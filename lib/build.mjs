import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeMetafile, build } from 'esbuild';
import { escapePath, glob } from 'tinyglobby';

import {
    createBuildOptions,
    createContentScriptBuildOptions,
    createWebviewScriptBuildOptions,
    mergeOptions,
    readPluginConfig,
    scriptOutputPaths,
} from './buildConfig.mjs';
import { PluginScriptsError } from './errors.mjs';
import { THIRD_PARTY_LICENSES_FILE, writeThirdPartyLicenses } from './licenses.mjs';
import { packagePlugin, readProject } from './packagePlugin.mjs';
import {
    describeInvalidWindowsName,
    invalidWindowsName,
    isInsideDirectory,
    pathCollisionKey,
    toSlashPath,
} from './paths.mjs';

/** @import { BuildOptions, Metafile, OutputFile } from 'esbuild' */

/**
 * Builds the plugin at `root`: validates the project, bundles the main entry point, extra scripts,
 * and webview scripts in memory, checks the combined `dist/` paths of the bundles' outputs and the
 * runtime assets from `src/` for collisions, then clears `dist/` and `publish/`, writes both, and
 * creates the `.jpl` archive. Any failure before that leaves the previous output untouched.
 * @param {string} root Plugin project root.
 * @param {{ analyze?: boolean, color?: boolean, dev?: boolean, sourcemap?: boolean, minify?: boolean }} [options]
 *   Optional build flags.
 * @returns {Promise<{ archivePath: string, version: string, analysis?: string }>} Absolute path of
 *   the created `.jpl` archive, the packaged plugin version, and (when `analyze` is true) esbuild's
 *   bundle-size breakdown.
 */
export async function buildPlugin(
    root,
    { analyze = false, color = false, dev = false, sourcemap = false, minify } = {}
) {
    const dist = path.join(root, 'dist');
    const publish = path.join(root, 'publish');
    const { manifest } = await readProject(root);
    const {
        extraScripts,
        webviewScripts,
        excludeAssets,
        mainBuildOptions,
        contentScriptBuildOptions,
        webviewScriptBuildOptions,
    } = await readPluginConfig(root);
    const flags = { dev, sourcemap, minify };
    const mainOverrides = applyBuildFlags(mainBuildOptions, flags);
    const contentOverrides = applyBuildFlags(contentScriptBuildOptions, flags);
    const webviewOverrides = applyBuildFlags(webviewScriptBuildOptions, flags);
    /** @type {{ entry: string, options: BuildOptions }[]} */
    const bundles = [
        { entry: 'src/index.ts', options: createBuildOptions(root, mainOverrides) },
        ...extraScripts.map((script) => ({
            entry: `src/${script}`,
            options: createContentScriptBuildOptions(root, script, contentOverrides),
        })),
        ...webviewScripts.map((script) => ({
            entry: `src/${script}`,
            options: createWebviewScriptBuildOptions(root, script, webviewOverrides),
        })),
    ];
    const listedAssets = await listRuntimeAssets(root, excludeAssets, [...extraScripts, ...webviewScripts]);

    // Build in memory, so nothing on disk changes until every output path is known and checked.
    // Wait for every bundle, so esbuild has printed all of its errors before the build stops.
    // Each result carries its bundle's entry point, so the pairing survives filtering.
    const results = await Promise.allSettled(
        bundles.map(async ({ entry, options }) => ({
            entry,
            result: await build({ ...options, write: false, metafile: true }),
        }))
    );
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) {
        // esbuild's own failures carry `errors` and have already been logged; anything else is unexpected.
        const unexpected = failures.find((failure) => !isEsbuildFailure(failure));
        if (unexpected) throw unexpected;
        throw new PluginScriptsError('Bundling failed; see the esbuild errors above.', { cause: failures[0] });
    }
    const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const generated = collectGeneratedFiles(
        dist,
        fulfilled.map(({ entry, result }) => ({ entry, outputFiles: result.outputFiles ?? [] }))
    );
    const assets = resolveOutputs(listedAssets, generated);

    // Only these fixed, project-local output directories are removed.
    await rm(dist, { recursive: true, force: true });
    await rm(publish, { recursive: true, force: true });
    await mkdir(dist, { recursive: true });

    await copyRuntimeAssets(root, dist, assets);
    for (const [output, { contents }] of generated) {
        const destination = path.join(dist, output);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, contents);
    }

    /** @type {Metafile[]} */
    const metafiles = [];
    for (const { result } of fulfilled) {
        if (result.metafile) metafiles.push(result.metafile);
    }
    await writeThirdPartyLicenses(root, dist, metafiles);

    const archivePath = await packagePlugin(root, manifest, scriptOutputPaths(extraScripts, webviewScripts));
    if (!analyze) return { archivePath, version: manifest.version };

    const analyses = await Promise.all(metafiles.map((metafile) => analyzeMetafile(metafile, { color })));
    const analysis = analyses.join('').replace(/^\n/, '');
    return { archivePath, version: manifest.version, analysis };
}

/**
 * Glob patterns excluded when copying runtime assets from `src/` to `dist/`:
 * compiled sources (TypeScript and JSX), test/benchmark files, and test/fixture directories.
 */
const RUNTIME_ASSET_IGNORE = [
    '**/fixtures/**',
    '**/{__tests__,__benchmarks__,__mocks__,__fixtures__,__snapshots__}/**',
    '**/*.{ts,mts,cts,tsx,jsx}',
    '**/*.{test,spec,bench}.{js,mjs,cjs}',
];

/**
 * Lists the runtime assets in `<root>/src` to copy to `dist/`, as `src/`-relative paths with `/` separators:
 * - Dotfiles and dot-directories are skipped, as packaging skips them.
 * - Symlinks are followed, so their targets are copied as regular files. Broken links are skipped,
 *   and a link to an ancestor directory is traversed only once.
 * - Bundled script sources are skipped, since they ship as `.js` bundles.
 * @param {string} root Plugin project root.
 * @param {string[]} excludeAssets Normalized `src/`-relative file or directory paths to exclude.
 * @param {string[]} scriptEntries Bundled script paths relative to `src/`, using `/` separators.
 * @returns {Promise<string[]>}
 */
async function listRuntimeAssets(root, excludeAssets, scriptEntries) {
    const scriptPaths = new Set(scriptEntries);
    const ignore = [
        ...RUNTIME_ASSET_IGNORE,
        ...excludeAssets.flatMap((assetPath) => {
            const escaped = escapePath(assetPath);
            return [escaped, `${escaped}/**`];
        }),
    ];
    const files = await glob('**', {
        cwd: path.join(root, 'src'),
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: true,
        ignore,
    });
    // Sorted, so copying and collision errors don't depend on directory listing order.
    return files.filter((file) => !scriptPaths.has(file)).sort();
}

/**
 * Copies runtime assets from `<root>/src` to `dist`, so `dist/` holds the same files as the `.jpl`.
 * Only directories containing a copied file are created.
 * @param {string} root Plugin project root.
 * @param {string} dist Output directory.
 * @param {string[]} assets Asset paths relative to `src/`, from `resolveOutputs`.
 * @returns {Promise<void>}
 */
async function copyRuntimeAssets(root, dist, assets) {
    const src = path.join(root, 'src');
    for (const file of assets) {
        const destination = path.join(dist, file);
        await mkdir(path.dirname(destination), { recursive: true });
        // copyFile follows symlinks, so the target's contents are written as a regular file.
        await copyFile(path.join(src, file), destination);
    }
}

/**
 * Maps each file esbuild generated to its `dist/`-relative path (with `/` separators), the entry point
 * of the bundle that generated it, and its contents. Rejects files outside `dist/`, which the build
 * would otherwise write itself, and names Windows cannot extract (see `invalidWindowsName`). esbuild
 * only checks for clashing outputs within one build, so this also rejects two bundles generating the
 * same file with different contents; identical files, e.g. one image imported by both through the
 * `file` loader, are kept once.
 * @param {string} dist Output directory.
 * @param {{ entry: string, outputFiles: OutputFile[] }[]} bundles Each bundle's entry
 *   point relative to the project root, and the files it generated.
 * @returns {Map<string, { entry: string, contents: Uint8Array }>}
 */
function collectGeneratedFiles(dist, bundles) {
    /** @type {Map<string, { entry: string, contents: Uint8Array }>} */
    const generated = new Map();
    for (const { entry, outputFiles } of bundles) {
        for (const file of outputFiles) {
            const output = generatedOutputPath(dist, entry, file.path);
            const existing = generated.get(output);
            if (!existing) {
                generated.set(output, { entry, contents: file.contents });
            } else if (Buffer.compare(existing.contents, file.contents) !== 0) {
                throw new PluginScriptsError(
                    `The bundles for ${existing.entry} and ${entry} both generate dist/${output}, with different ` +
                        'contents; check their build options in plugin.config.json.'
                );
            }
        }
    }
    return generated;
}

/**
 * Returns the `dist/`-relative path, with `/` separators, of a file a bundle generated, rejecting
 * paths outside `dist/` and names Windows cannot extract.
 * @param {string} dist Output directory.
 * @param {string} entry The bundle's entry point relative to the project root.
 * @param {string} filePath Absolute path of the generated file.
 * @returns {string}
 */
function generatedOutputPath(dist, entry, filePath) {
    if (!isInsideDirectory(dist, filePath)) {
        throw new PluginScriptsError(
            `The bundle for ${entry} generates ${filePath}, outside dist/; check its build options in plugin.config.json.`
        );
    }
    const output = toSlashPath(path.relative(dist, filePath));
    const invalid = invalidWindowsName(output);
    if (invalid !== undefined) {
        throw new PluginScriptsError(
            `The bundle for ${entry} generates dist/${output}, which ${describeInvalidWindowsName(invalid)}; ` +
                'check its build options in plugin.config.json.'
        );
    }
    return output;
}

/** Manifest file copied from `src/` to `dist/`, which bundles cannot replace and users cannot exclude. */
const MANIFEST_FILE = 'manifest.json';

/** @typedef {{ output: string, label: string, asset: boolean, fixed?: boolean, source?: string }} Output */

/**
 * Works out the final `dist/` contents and returns the runtime assets to copy. A generated file
 * replaces a runtime asset at the same exact path, e.g. `src/index.js` next to `src/index.ts`, or CSS
 * a bundle imports, except for `manifest.json`. Any other collision fails, compared by
 * `pathCollisionKey`, since the archive may be installed where `Logo.png` and `logo.png` are one
 * file. A file also collides with a directory of the same name, and two directories cannot differ
 * only in letter case or Unicode normalization. The license file is reserved whether or not it ends
 * up being written, so e.g. adding a dependency with a license later cannot start a failure. Asset
 * names Windows cannot extract are rejected (see `invalidWindowsName`).
 * @param {string[]} assets Asset paths relative to `src/`, using `/` separators.
 * @param {Map<string, { entry: string }>} generated Files esbuild generated, from `collectGeneratedFiles`.
 * @returns {string[]}
 */
function resolveOutputs(assets, generated) {
    assertValidAssetNames(assets);
    const outputs = collectOutputs(assets, generated);
    const files = assertNoFileCollisions(outputs);
    assertNoDirectoryCollisions(outputs, files);
    return assets.filter((asset) => outputs.get(asset)?.asset);
}

/**
 * Rejects runtime asset names Windows cannot extract (see `invalidWindowsName`).
 * @param {string[]} assets Asset paths relative to `src/`, using `/` separators.
 */
function assertValidAssetNames(assets) {
    for (const asset of assets) {
        const invalid = invalidWindowsName(asset);
        if (invalid === undefined) continue;
        // excludeAssets reads `\` as a separator, so it cannot exclude a name containing one; only renaming helps.
        const fix = asset.includes('\\') ? 'rename it' : 'rename it or add it to excludeAssets in plugin.config.json';
        throw new PluginScriptsError(`src/${asset} ${describeInvalidWindowsName(invalid)}; ${fix}.`);
    }
}

/**
 * Maps each final `dist/` path to its output: runtime assets, then generated files replacing assets
 * at the same exact path (except `manifest.json`), then the reserved license file.
 * @param {string[]} assets Asset paths relative to `src/`, using `/` separators.
 * @param {Map<string, { entry: string }>} generated Files esbuild generated, from `collectGeneratedFiles`.
 * @returns {Map<string, Output>}
 */
function collectOutputs(assets, generated) {
    /** @type {Map<string, Output>} */
    const outputs = new Map(
        assets.map((output) => [
            output,
            { output, label: `src/${output}`, asset: true, fixed: output === MANIFEST_FILE },
        ])
    );
    for (const [output, { entry }] of generated) {
        /** @type {Output} */
        const next = { output, label: `the generated dist/${output}`, asset: false, source: entry };
        const existing = outputs.get(output);
        if (existing?.fixed) throw outputCollision(next, existing, next.output, existing.output);
        outputs.set(output, next);
    }
    /** @type {Output} */
    const license = {
        output: THIRD_PARTY_LICENSES_FILE,
        label: `the generated dist/${THIRD_PARTY_LICENSES_FILE}`,
        asset: false,
        fixed: true,
    };
    const replaced = outputs.get(license.output);
    if (replaced) throw outputCollision(replaced, license, replaced.output, license.output);
    outputs.set(license.output, license);
    return outputs;
}

/**
 * Rejects outputs whose paths share a `pathCollisionKey`.
 * @param {Map<string, Output>} outputs Outputs from `collectOutputs`.
 * @returns {Map<string, Output>} The outputs keyed by `pathCollisionKey`.
 */
function assertNoFileCollisions(outputs) {
    /** @type {Map<string, Output>} */
    const files = new Map();
    for (const entry of outputs.values()) {
        const key = pathCollisionKey(entry.output);
        const existing = files.get(key);
        if (existing) throw outputCollision(entry, existing, entry.output, existing.output);
        files.set(key, entry);
    }
    return files;
}

/**
 * Rejects a file colliding with a directory of the same name, and directories that differ only in
 * letter case or Unicode normalization.
 * @param {Map<string, Output>} outputs Outputs from `collectOutputs`.
 * @param {Map<string, Output>} files The outputs keyed by `pathCollisionKey`, from `assertNoFileCollisions`.
 */
function assertNoDirectoryCollisions(outputs, files) {
    /** @type {Map<string, Output>} */
    const directories = new Map();
    for (const entry of outputs.values()) {
        for (const dirEntry of parentDirectories(entry)) {
            const key = pathCollisionKey(dirEntry.output);
            const file = files.get(key);
            if (file) throw outputCollision(file, dirEntry, file.output, dirEntry.output);
            const existing = directories.get(key);
            if (!existing) {
                directories.set(key, dirEntry);
            } else if (existing.output !== dirEntry.output) {
                throw outputCollision(dirEntry, existing, dirEntry.output, existing.output);
            }
        }
    }
}

/**
 * Lists the directories an output is nested in, outermost first, as outputs for `outputCollision`.
 * @param {Output} entry
 * @returns {Output[]}
 */
function parentDirectories(entry) {
    const parts = entry.output.split('/');
    return parts.slice(1).map((_, index) => {
        const directory = parts.slice(0, index + 1).join('/');
        const label = `the directory ${entry.asset ? 'src' : 'dist'}/${directory}/`;
        return { output: directory, label, asset: entry.asset, source: entry.source };
    });
}

/**
 * Creates the error for two colliding outputs found by `resolveOutputs`, naming a renameable runtime
 * asset first (since the user can rename or exclude it), and never putting a fixed output
 * (`src/manifest.json` or `dist/THIRD-PARTY-LICENSES.txt`) in the slot the fix refers to.
 * @param {Output} a One output.
 * @param {Output} b The output `a` collides with.
 * @param {string} aPath The path of `a` that collides, with `/` separators.
 * @param {string} bPath The path of `b` that collides; a directory if `b` is one.
 * @returns {PluginScriptsError}
 */
function outputCollision(a, b, aPath, bPath) {
    const describe = (/** @type {Output} */ { label, source }) => (source ? `${label} (from ${source})` : label);
    const canRename = (/** @type {Output} */ entry) => entry.asset && !entry.fixed;
    const swap = (canRename(b) && !canRename(a)) || (Boolean(a.fixed) && !b.fixed);
    const [first, second] = swap ? [b, a] : [a, b];
    // Paths that are not identical only share a `pathCollisionKey`, so say why they still collide.
    const why = aPath === bPath ? '' : ` (${COLLISION_NOTE})`;
    const fix = canRename(first)
        ? 'rename it or add it to excludeAssets in plugin.config.json'
        : 'check the build options in plugin.config.json';
    return new PluginScriptsError(`${describe(first)} conflicts with ${describe(second)}${why}; ${fix}.`);
}

/** Explains a collision between paths that differ only as `pathCollisionKey` ignores. */
const COLLISION_NOTE = 'names that differ only in letter case or Unicode form can name one file on Windows or macOS';

/**
 * Applies CLI build flags around a bundle's configured overrides: `--dev` changes the default
 * `process.env.NODE_ENV` to `"development"` (without clobbering an explicit config `define`),
 * while `minify: false` and `sourcemap: 'inline'` override `plugin.config.json`.
 * @param {BuildOptions} overrides Bundle overrides from `plugin.config.json`.
 * @param {{ dev: boolean, sourcemap: boolean, minify?: boolean }} flags
 * @returns {BuildOptions}
 */
function applyBuildFlags(overrides, { dev, sourcemap, minify }) {
    /** @type {BuildOptions} */
    const defaultOverrides = dev ? { define: { 'process.env.NODE_ENV': '"development"' } } : {};
    /** @type {BuildOptions} */
    const cliOverrides = {};
    if (dev || sourcemap) cliOverrides.sourcemap = 'inline';
    if (dev || minify === false) {
        cliOverrides.minify = false;
        cliOverrides.minifyIdentifiers = false;
        cliOverrides.minifySyntax = false;
        cliOverrides.minifyWhitespace = false;
    }
    return mergeOptions(defaultOverrides, overrides, cliOverrides);
}

/**
 * Checks whether a rejected build is an esbuild `BuildFailure`, whose messages esbuild has already logged.
 * @param {unknown} error
 * @returns {boolean}
 */
function isEsbuildFailure(error) {
    return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}
