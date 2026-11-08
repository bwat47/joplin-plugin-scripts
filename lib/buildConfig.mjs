import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, hasErrorCode } from './errors.mjs';

/** Name of the optional per-plugin build configuration file at the project root. */
export const CONFIG_FILE = 'plugin.config.json';

/**
 * Matches TypeScript sources, which are bundled rather than copied,
 * e.g. `index.ts`, `view.tsx`, `worker.mts`, `config.cts`, `types.d.ts` (not `notes.txt`).
 */
const TYPESCRIPT_SOURCE_PATTERN = /\.(?:[cm]?ts|tsx)$/;

/** Matches a bundleable script extension, e.g. `a.ts`, `a.tsx`, `a.js`, `a.jsx` (not `a.json`, `a.css`). */
const SCRIPT_EXTENSION_PATTERN = /\.[jt]sx?$/;

/** Splits a path on either separator, e.g. `a/b\c` becomes `['a', 'b', 'c']`. */
const PATH_SEPARATOR_PATTERN = /[\\/]/;

/** Matches test files, e.g. `pipeline.test.ts` or `render.spec.js`. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Matches a Node built-in import with the `node:` prefix, e.g. `node:path`. */
const NODE_PREFIX_PATTERN = /^node:/;

/**
 * esbuild options that the package owns and `mainBuildOptions` may not override: the input and
 * output locations, `write` (packaging needs `dist/index.js` on disk), `format` (Joplin loads the
 * main bundle as CommonJS), and `plugins` (replacing them drops the `node:` prefix rewrite).
 */
const RESERVED_BUILD_OPTIONS = ['absWorkingDir', 'entryPoints', 'outfile', 'outdir', 'write', 'format', 'plugins'];

/**
 * Excludes bundled sources, tests, and development fixtures in `<root>/src` from copied runtime assets.
 * @param {string} root Plugin project root.
 * @param {string} source
 * @returns {boolean}
 */
export function isRuntimeAsset(root, source) {
    const parts = path.relative(path.join(root, 'src'), source).split(PATH_SEPARATOR_PATTERN);
    return (
        !TYPESCRIPT_SOURCE_PATTERN.test(source) &&
        !TEST_FILE_PATTERN.test(source) &&
        !parts.some((part) => part === 'fixtures' || part === '__tests__')
    );
}

// Keep the generator's explicit host-library list: these must share Joplin's instances.
// `update-api` warns when this list differs from the generator's.
export const contentScriptExternals = [
    '@codemirror/view',
    '@codemirror/state',
    '@codemirror/search',
    '@codemirror/language',
    '@codemirror/autocomplete',
    '@codemirror/commands',
    '@codemirror/highlight',
    '@codemirror/lint',
    '@codemirror/lang-html',
    '@codemirror/lang-markdown',
    '@codemirror/language-data',
    '@lezer/common',
    '@lezer/markdown',
    '@lezer/highlight',
];

/**
 * Rewrites Node built-in imports to their bare names, e.g. `node:path` to `path`,
 * matching the generator's Webpack build for Joplin's plugin runtime.
 * @type {import('esbuild').Plugin}
 */
const stripNodePrefix = {
    name: 'strip-node-prefix',
    setup(pluginBuild) {
        pluginBuild.onResolve({ filter: NODE_PREFIX_PATTERN }, (args) => ({
            path: args.path.slice('node:'.length),
            external: true,
        }));
    },
};

/**
 * Options shared by the main plugin and content-script bundles.
 * `api` resolves through tsconfig.json `paths`: api/index.ts exports Joplin's injected global,
 * and api/types contains runtime enums, so both are bundled.
 * @param {string} root Plugin project root.
 * @returns {import('esbuild').BuildOptions}
 */
function sharedOptions(root) {
    return {
        absWorkingDir: root,
        bundle: true,
        format: 'cjs',
        target: 'es2020',
        minify: true,
        // Matches Webpack's production mode. esbuild only sets this automatically for minified browser builds,
        // and the main bundle may run in a webview without `process` (mobile).
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'info',
    };
}

/**
 * Returns the esbuild options for the main plugin bundle, `src/index.ts` to `dist/index.js`.
 * `mainBuildOptions` from the plugin config are merged over the defaults.
 * `define` entries are merged individually so unrelated definitions preserve the defaults.
 * @param {string} root Plugin project root.
 * @param {import('esbuild').BuildOptions} [overrides] The plugin config's `mainBuildOptions`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createBuildOptions(root, overrides = {}) {
    const defaults = sharedOptions(root);
    return {
        ...defaults,
        entryPoints: ['src/index.ts'],
        outfile: 'dist/index.js',
        platform: 'node',
        plugins: [stripNodePrefix],
        ...overrides,
        define: { ...defaults.define, ...overrides.define },
    };
}

/**
 * Rejects a script path that is not a bundleable script inside `src/`, e.g. `../a.ts` or `notes.txt`.
 * @param {string} script Script path relative to `src/`.
 */
function assertValidScriptPath(script) {
    if (
        !SCRIPT_EXTENSION_PATTERN.test(script) ||
        path.isAbsolute(script) ||
        script.split(PATH_SEPARATOR_PATTERN).includes('..')
    ) {
        throw new Error(`Invalid extra script path: ${script}`);
    }
}

/**
 * Returns the esbuild options for one content script, e.g. `contentScripts/codeMirror.ts`
 * (relative to `src/`) to `dist/contentScripts/codeMirror.js`.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createContentScriptBuildOptions(root, script) {
    assertValidScriptPath(script);
    // Content scripts run in the editor webview, so they use esbuild's default browser platform:
    // a Node built-in import fails the build instead of becoming a runtime require.
    return {
        ...sharedOptions(root),
        entryPoints: [`src/${script}`],
        outfile: `dist/${script.replace(SCRIPT_EXTENSION_PATTERN, '.js')}`,
        external: contentScriptExternals,
    };
}

/**
 * Returns the esbuild options for one webview script, e.g. `dialog/resizeDialog.ts` (relative to
 * `src/`) to `dist/dialog/resizeDialog.js`. Webview scripts are loaded by a `<script>` tag in a
 * dialog or panel, which has no `module`, `exports`, or `require`, so they are bundled as a
 * self-contained IIFE. Their exports are dropped; the script runs for its side effects.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createWebviewScriptBuildOptions(root, script) {
    return {
        ...createContentScriptBuildOptions(root, script),
        format: 'iife',
        // A webview has no host CodeMirror instance to share, so everything is bundled.
        external: [],
    };
}

/**
 * Returns `dist/`-relative output paths for every script the plugin config registers.
 * @param {string[]} extraScripts Content-script paths relative to `src/`.
 * @param {string[]} webviewScripts Webview-script paths relative to `src/`.
 * @returns {string[]} Bundle paths relative to `dist/`, using native separators.
 */
export function scriptOutputPaths(extraScripts, webviewScripts) {
    return [...extraScripts, ...webviewScripts].map((script) =>
        path.normalize(script.replace(SCRIPT_EXTENSION_PATTERN, '.js'))
    );
}

/**
 * Shows a `dist/`-relative output path with `/` separators on every platform, e.g. `scripts\a.js` as `scripts/a.js`.
 * @param {string} output Bundle path relative to `dist/`.
 * @returns {string}
 */
function displayOutputPath(output) {
    return output.replaceAll('\\', '/');
}

/**
 * Output paths are compared without case on every platform: the archive may be installed on a
 * case-insensitive filesystem (Windows, macOS), where `Editor.js` and `editor.js` are one file.
 * @param {string} output Bundle path relative to `dist/`.
 * @returns {string}
 */
function outputPathKey(output) {
    return displayOutputPath(output).toLowerCase();
}

/**
 * Checks whether a configuration value is an array of strings.
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Rejects a configuration entry that is not an array of script paths.
 * @param {unknown} value
 * @param {string} key
 * @param {string} configPath
 * @returns {asserts value is string[]}
 */
function assertScriptArray(value, key, configPath) {
    if (!isStringArray(value)) {
        throw new Error(`${configPath} "${key}" must be an array of paths relative to src/.`);
    }
}

/**
 * Checks whether a configuration value is a non-null, non-array object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects malformed script paths, scripts that build to the main bundle's `dist/index.js`,
 * and scripts that build to the same output path.
 * @param {string} configPath Configuration file path used in error messages.
 * @param {string[]} extraScripts Content-script paths relative to `src/`.
 * @param {string[]} webviewScripts Webview-script paths relative to `src/`.
 */
function assertValidScripts(configPath, extraScripts, webviewScripts) {
    // Report a malformed path as such, before normalization can make it look like a collision.
    for (const script of [...extraScripts, ...webviewScripts]) assertValidScriptPath(script);
    const mainOutput = outputPathKey('index.js');
    const seen = new Set();
    for (const output of scriptOutputPaths(extraScripts, webviewScripts)) {
        const key = outputPathKey(output);
        if (key === mainOutput) {
            throw new Error(
                `${configPath} lists a script that builds to dist/index.js, which is reserved for the main bundle.`
            );
        }
        if (seen.has(key)) {
            throw new Error(
                `${configPath} lists more than one script that builds to dist/${displayOutputPath(output)}.`
            );
        }
        seen.add(key);
    }
}

/**
 * Reads and validates `<root>/plugin.config.json`. The file is optional; a plugin without one
 * has no extra or webview scripts and uses the default main build options.
 * @param {string} root Plugin project root.
 * @returns {Promise<{ extraScripts: string[], webviewScripts: string[], mainBuildOptions: import('esbuild').BuildOptions }>}
 */
export async function readPluginConfig(root) {
    const configPath = path.join(root, CONFIG_FILE);
    let config;
    try {
        config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { extraScripts: [], webviewScripts: [], mainBuildOptions: {} };
        throw new Error(`Could not read ${configPath}: ${errorMessage(error)}`, { cause: error });
    }
    if (!isPlainObject(config)) throw new Error(`${configPath} must contain a JSON object.`);
    const { extraScripts = [], webviewScripts = [], mainBuildOptions = {}, ...unknown } = config;
    const unknownKeys = Object.keys(unknown);
    if (unknownKeys.length > 0) {
        throw new Error(`${configPath} has unknown keys: ${unknownKeys.join(', ')}.`);
    }
    assertScriptArray(extraScripts, 'extraScripts', configPath);
    assertScriptArray(webviewScripts, 'webviewScripts', configPath);
    assertValidScripts(configPath, extraScripts, webviewScripts);
    if (!isPlainObject(mainBuildOptions)) {
        throw new Error(`${configPath} "mainBuildOptions" must be an object of esbuild options.`);
    }
    const reserved = RESERVED_BUILD_OPTIONS.filter((key) => key in mainBuildOptions);
    if (reserved.length > 0) {
        throw new Error(`${configPath} "mainBuildOptions" cannot set ${reserved.join(', ')}.`);
    }
    const { define } = mainBuildOptions;
    if (
        define !== undefined &&
        !(isPlainObject(define) && Object.values(define).every((value) => typeof value === 'string'))
    ) {
        throw new Error(`${configPath} "mainBuildOptions.define" must be an object of string replacements.`);
    }
    return { extraScripts, webviewScripts, mainBuildOptions };
}
