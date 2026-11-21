import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { analyzeMetafile, build } from 'esbuild';
import { escapePath, glob } from 'tinyglobby';

import {
    createBuildOptions,
    createContentScriptBuildOptions,
    createWebviewScriptBuildOptions,
    readPluginConfig,
    scriptOutputPaths,
} from './buildConfig.mjs';
import { PluginScriptsError } from './errors.mjs';
import { THIRD_PARTY_LICENSES_FILE, writeThirdPartyLicenses } from './licenses.mjs';
import { packagePlugin, readProject } from './packagePlugin.mjs';

/**
 * Builds the plugin at `root`: validates the project, clears `dist/` and `publish/`, copies runtime
 * assets from `src/`, bundles the main entry point, extra scripts, and webview scripts, and creates
 * the `.jpl` archive.
 * @param {string} root Plugin project root.
 * @param {{ analyze?: boolean, color?: boolean }} [options] Optional build flags.
 * @returns {Promise<{ archivePath: string, version: string, analysis?: string }>} Absolute path of
 *   the created `.jpl` archive, the packaged plugin version, and (when `analyze` is true) esbuild's
 *   bundle-size breakdown.
 */
export async function buildPlugin(root, { analyze = false, color = false } = {}) {
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
    const scriptBuilds = [
        ...extraScripts.map((script) => createContentScriptBuildOptions(root, script, contentScriptBuildOptions)),
        ...webviewScripts.map((script) => createWebviewScriptBuildOptions(root, script, webviewScriptBuildOptions)),
    ];
    await assertNoReservedAssets(root);

    // Only these fixed, project-local output directories are removed.
    await rm(dist, { recursive: true, force: true });
    await rm(publish, { recursive: true, force: true });
    await mkdir(dist, { recursive: true });

    // Copy first so a JavaScript source asset cannot overwrite a compiled bundle.
    await copyRuntimeAssets(root, dist, excludeAssets, [...extraScripts, ...webviewScripts]);
    // Wait for every bundle, so esbuild has printed all of its errors before the build stops.
    const results = await Promise.allSettled([
        build({ ...createBuildOptions(root, mainBuildOptions), metafile: true }),
        ...scriptBuilds.map((options) => build({ ...options, metafile: true })),
    ]);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) {
        // esbuild's own failures carry `errors` and have already been logged; anything else is unexpected.
        const unexpected = failures.find((failure) => !isEsbuildFailure(failure));
        if (unexpected) throw unexpected;
        throw new PluginScriptsError('Bundling failed; see the esbuild errors above.', { cause: failures[0] });
    }

    /** @type {import('esbuild').Metafile[]} */
    const metafiles = [];
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.metafile) {
            metafiles.push(result.value.metafile);
        }
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
 * Copies runtime assets from `<root>/src` to `dist`, so `dist/` holds the same files as the `.jpl`:
 * - Only directories containing a copied file are created.
 * - Dotfiles and dot-directories are skipped, as packaging skips them.
 * - Symlinks are followed and their targets copied as regular files, rather than archived as links
 *   to absolute paths on the build machine. Broken links are skipped, and a link to an ancestor
 *   directory is traversed only once.
 * @param {string} root Plugin project root.
 * @param {string} dist Output directory.
 * @param {string[]} excludeAssets Normalized `src/`-relative file or directory paths to exclude.
 * @param {string[]} scriptEntries Bundled script paths relative to `src/`; their sources are not
 *   copied, since they ship as `.js` bundles.
 * @returns {Promise<void>}
 */
async function copyRuntimeAssets(root, dist, excludeAssets, scriptEntries) {
    const src = path.join(root, 'src');
    // Normalize native separators to match glob results, preserving literal backslashes on POSIX.
    const scriptPaths = new Set(scriptEntries.map((script) => path.normalize(script).split(path.sep).join('/')));
    const ignore = [
        ...RUNTIME_ASSET_IGNORE,
        ...excludeAssets.flatMap((assetPath) => {
            const escaped = escapePath(assetPath);
            return [escaped, `${escaped}/**`];
        }),
    ];
    const files = await glob('**', {
        cwd: src,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: true,
        ignore,
    });
    for (const file of files) {
        if (scriptPaths.has(file)) continue;
        const destination = path.join(dist, file);
        await mkdir(path.dirname(destination), { recursive: true });
        // copyFile follows symlinks, so the target's contents are written as a regular file.
        await copyFile(path.join(src, file), destination);
    }
}

/**
 * Rejects a `src/` file that would be copied over the generated `dist/THIRD-PARTY-LICENSES.txt`, or
 * collide with it on a case-insensitive file system. Runs before `dist/` is cleared, and regardless of
 * whether any license file would be generated, so adding a dependency later cannot start a failure.
 * @param {string} root Plugin project root.
 * @returns {Promise<void>}
 */
async function assertNoReservedAssets(root) {
    const reserved = THIRD_PARTY_LICENSES_FILE.toLowerCase();
    const conflict = (await readdir(path.join(root, 'src'))).find((name) => name.toLowerCase() === reserved);
    if (conflict) {
        throw new PluginScriptsError(
            `${path.join('src', conflict)} conflicts with the generated dist/${THIRD_PARTY_LICENSES_FILE}; ` +
                'rename it, e.g. to NOTICE.txt.'
        );
    }
}

/**
 * Checks whether a rejected build is an esbuild `BuildFailure`, whose messages esbuild has already logged.
 * @param {unknown} error
 * @returns {boolean}
 */
function isEsbuildFailure(error) {
    return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}
