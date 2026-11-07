import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

/** esbuild options that the package owns and `mainBuildOptions` may not override. */
const RESERVED_BUILD_OPTIONS = ['absWorkingDir', 'entryPoints', 'outfile', 'outdir'];

/** Excludes bundled sources, tests, and development fixtures in `<root>/src` from copied runtime assets. */
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
 * @param {string} root Plugin project root.
 * @param {import('esbuild').BuildOptions} [overrides] The plugin config's `mainBuildOptions`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createBuildOptions(root, overrides = {}) {
    return {
        ...sharedOptions(root),
        entryPoints: ['src/index.ts'],
        outfile: 'dist/index.js',
        platform: 'node',
        plugins: [stripNodePrefix],
        ...overrides,
    };
}

/**
 * Returns the esbuild options for one content script, e.g. `contentScripts/codeMirror.ts`
 * (relative to `src/`) to `dist/contentScripts/codeMirror.js`.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createContentScriptBuildOptions(root, script) {
    if (
        !SCRIPT_EXTENSION_PATTERN.test(script) ||
        path.isAbsolute(script) ||
        script.split(PATH_SEPARATOR_PATTERN).includes('..')
    ) {
        throw new Error(`Invalid extra script path: ${script}`);
    }
    // Content scripts run in the editor webview, so they use esbuild's default browser platform:
    // a Node built-in import fails the build instead of becoming a runtime require.
    return {
        ...sharedOptions(root),
        entryPoints: [`src/${script}`],
        outfile: `dist/${script.replace(SCRIPT_EXTENSION_PATTERN, '.js')}`,
        external: contentScriptExternals,
    };
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates `<root>/plugin.config.json`. The file is optional; a plugin without one
 * has no extra scripts and uses the default main build options.
 * @returns {Promise<{ extraScripts: string[], mainBuildOptions: import('esbuild').BuildOptions }>}
 */
export async function readPluginConfig(root) {
    const configPath = path.join(root, CONFIG_FILE);
    let config;
    try {
        config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { extraScripts: [], mainBuildOptions: {} };
        throw new Error(`Could not read ${configPath}: ${error.message}`, { cause: error });
    }
    if (!isPlainObject(config)) throw new Error(`${configPath} must contain a JSON object.`);
    const { extraScripts = [], mainBuildOptions = {}, ...unknown } = config;
    const unknownKeys = Object.keys(unknown);
    if (unknownKeys.length > 0) {
        throw new Error(`${configPath} has unknown keys: ${unknownKeys.join(', ')}.`);
    }
    if (!Array.isArray(extraScripts) || extraScripts.some((script) => typeof script !== 'string')) {
        throw new Error(`${configPath} "extraScripts" must be an array of paths relative to src/.`);
    }
    if (!isPlainObject(mainBuildOptions)) {
        throw new Error(`${configPath} "mainBuildOptions" must be an object of esbuild options.`);
    }
    const reserved = RESERVED_BUILD_OPTIONS.filter((key) => key in mainBuildOptions);
    if (reserved.length > 0) {
        throw new Error(`${configPath} "mainBuildOptions" cannot set ${reserved.join(', ')}.`);
    }
    return { extraScripts, mainBuildOptions };
}
