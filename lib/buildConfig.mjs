import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, hasErrorCode, PluginScriptsError } from './errors.mjs';

/** Name of the optional per-plugin build configuration file at the project root. */
export const CONFIG_FILE = 'plugin.config.json';

/**
 * Matches sources that cannot run without compiling, so they are bundled rather than copied,
 * e.g. `index.ts`, `view.tsx`, `dialog.jsx`, `worker.mts`, `config.cts`, `types.d.ts`
 * (not `worker.js` or `notes.txt`).
 */
const COMPILED_SOURCE_PATTERN = /\.(?:[cm]?ts|[jt]sx)$/;

/** Matches a bundleable script extension, e.g. `a.ts`, `a.tsx`, `a.js`, `a.jsx` (not `a.json`, `a.css`). */
const SCRIPT_EXTENSION_PATTERN = /\.[jt]sx?$/;

/** Splits a path on either separator, e.g. `a/b\c` becomes `['a', 'b', 'c']`. */
const PATH_SEPARATOR_PATTERN = /[\\/]/;

/** Matches test files, e.g. `pipeline.test.ts` or `render.spec.js`. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * esbuild options that the package owns and no override may set: the input and output locations,
 * `write` (packaging needs `dist/index.js` on disk), `format` (Joplin loads the main bundle as
 * CommonJS), `plugins` (plugin hooks cannot be represented in JSON), and `bundle` and
 * `packages`. Each output is loaded as a single file: with `bundle: false` or
 * `packages: "external"`, its imports would stay as `require` calls for modules that are not in
 * the archive or, in a webview, for a `require` that does not exist. Individual packages can
 * still be made external with `external`.
 */
const RESERVED_BUILD_OPTIONS = [
    'absWorkingDir',
    'entryPoints',
    'outfile',
    'outdir',
    'write',
    'format',
    'plugins',
    'bundle',
    'packages',
];

/**
 * Further options that webview-script overrides may not set. A webview script is an IIFE loaded
 * by a `<script>` tag in a dialog or panel, which has no `require` on any platform, so `platform`
 * stays `browser` (unresolved Node built-in imports fail the build by default) and nothing may
 * be `external`.
 */
const RESERVED_WEBVIEW_BUILD_OPTIONS = [...RESERVED_BUILD_OPTIONS, 'platform', 'external'];

/**
 * Configuration keys holding esbuild overrides, with the options each may not set. `buildOptions`
 * applies to every bundle, so it may set only what every bundle type may set: the webview list.
 * @type {Record<'buildOptions' | 'mainBuildOptions' | 'contentScriptBuildOptions' | 'webviewScriptBuildOptions', string[]>}
 */
const BUILD_OPTION_KEYS = {
    buildOptions: RESERVED_WEBVIEW_BUILD_OPTIONS,
    mainBuildOptions: RESERVED_BUILD_OPTIONS,
    contentScriptBuildOptions: RESERVED_BUILD_OPTIONS,
    webviewScriptBuildOptions: RESERVED_WEBVIEW_BUILD_OPTIONS,
};

/**
 * Excludes compiled sources (TypeScript and JSX), tests, and development fixtures in `<root>/src` from copied runtime assets.
 * @param {string} root Plugin project root.
 * @param {string} source
 * @returns {boolean}
 */
export function isRuntimeAsset(root, source) {
    const parts = path.relative(path.join(root, 'src'), source).split(PATH_SEPARATOR_PATTERN);
    return (
        !COMPILED_SOURCE_PATTERN.test(source) &&
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
 * esbuild options whose values are maps from a key to a setting, with the type of each setting.
 * Layers merge these entry by entry, so a layer can add an entry without dropping earlier ones,
 * e.g. a `mainBuildOptions.alias` entry keeps the `buildOptions.alias` entries.
 * @type {Record<'define' | 'alias' | 'loader' | 'banner' | 'footer' | 'supported', 'string' | 'boolean'>}
 */
const RECORD_OPTIONS = {
    define: 'string',
    alias: 'string',
    loader: 'string',
    banner: 'string',
    footer: 'string',
    supported: 'boolean',
};

/**
 * Merges esbuild option layers from left to right, so later layers win. Record options
 * (`RECORD_OPTIONS`) are merged entry by entry; other options, including arrays, are replaced.
 * @param {...import('esbuild').BuildOptions} layers
 * @returns {import('esbuild').BuildOptions}
 */
function mergeOptions(...layers) {
    const merged = layers.reduce(
        (result, layer) => ({ ...result, ...layer }),
        /** @type {Record<string, unknown>} */ ({})
    );
    for (const option of /** @type {(keyof typeof RECORD_OPTIONS)[]} */ (Object.keys(RECORD_OPTIONS))) {
        const entries = layers.reduce(
            (result, layer) => ({ ...result, ...layer[option] }),
            /** @type {Record<string, unknown>} */ ({})
        );
        if (Object.keys(entries).length > 0) merged[option] = entries;
    }
    return merged;
}

/**
 * Overridable defaults for every bundle.
 * @returns {import('esbuild').BuildOptions}
 */
function defaultOptions() {
    return {
        target: 'es2020',
        minify: true,
        // Matches Webpack's production mode. esbuild only sets this automatically for minified browser builds,
        // and the main bundle may run in a webview without `process` (mobile).
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'info',
    };
}

/**
 * Options every bundle sets after its overrides, so they hold even for direct callers of the
 * `create*BuildOptions` functions: the project root, entry point, output file, and bundling.
 * `readPluginConfig` rejects the full reserved list (`RESERVED_BUILD_OPTIONS`); options such as
 * `write` stay open to direct callers, e.g. tests that build in memory with `write: false`.
 * `api` resolves through tsconfig.json `paths`: api/index.ts exports Joplin's injected global,
 * and api/types contains runtime enums, so both are bundled.
 * @param {string} root Plugin project root.
 * @param {string} entryPoint Entry point relative to `root`.
 * @param {string} outfile Output file relative to `root`.
 * @returns {import('esbuild').BuildOptions}
 */
function fixedOptions(root, entryPoint, outfile) {
    return { absWorkingDir: root, entryPoints: [entryPoint], outfile, bundle: true };
}

/**
 * Returns the esbuild options for the main plugin bundle, `src/index.ts` to `dist/index.js`.
 * `mainBuildOptions` from the plugin config are merged over the defaults.
 * @param {string} root Plugin project root.
 * @param {import('esbuild').BuildOptions} [overrides] The plugin config's `mainBuildOptions`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createBuildOptions(root, overrides = {}) {
    return mergeOptions({ ...defaultOptions(), platform: 'node' }, overrides, {
        ...fixedOptions(root, 'src/index.ts', 'dist/index.js'),
        format: 'cjs',
    });
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
        throw new PluginScriptsError(`Invalid extra script path: ${script}`);
    }
}

/**
 * Options content-script and webview-script bundles set after their overrides.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @returns {import('esbuild').BuildOptions}
 */
function fixedScriptOptions(root, script) {
    assertValidScriptPath(script);
    return fixedOptions(root, `src/${script}`, `dist/${script.replace(SCRIPT_EXTENSION_PATTERN, '.js')}`);
}

/**
 * Returns the esbuild options for one content script, e.g. `contentScripts/codeMirror.ts`
 * (relative to `src/`) to `dist/contentScripts/codeMirror.js`. `overrides` are merged over the
 * defaults; their `external` entries are added to the host libraries, which always stay external.
 *
 * The platform defaults to `browser`, unlike the generator's `target: 'node'`. On desktop, content
 * scripts are loaded with Node access, but on mobile and the web app they run without Node.
 * Unresolved Node built-in imports fail the build by default, and dependency resolution prefers
 * browser entry points where provided. Desktop-only plugins can list Node built-ins in `external`
 * to keep them as runtime `require` calls, or set `platform: 'node'` to prefer Node entry points
 * where provided.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @param {import('esbuild').BuildOptions} [overrides] The plugin config's `contentScriptBuildOptions`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createContentScriptBuildOptions(root, script, overrides = {}) {
    return mergeOptions({ ...defaultOptions(), platform: 'browser' }, overrides, {
        ...fixedScriptOptions(root, script),
        format: 'cjs',
        external: [...new Set([...contentScriptExternals, ...(overrides.external ?? [])])],
    });
}

/**
 * Returns the esbuild options for one webview script, e.g. `dialog/resizeDialog.ts` (relative to
 * `src/`) to `dist/dialog/resizeDialog.js`. Webview scripts are loaded by a `<script>` tag in a
 * dialog or panel, which has no `module`, `exports`, or `require`, so they are bundled as a
 * self-contained IIFE. Their exports are dropped; the script runs for its side effects.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @param {import('esbuild').BuildOptions} [overrides] The plugin config's `webviewScriptBuildOptions`.
 * @returns {import('esbuild').BuildOptions}
 */
export function createWebviewScriptBuildOptions(root, script, overrides = {}) {
    return mergeOptions(defaultOptions(), overrides, {
        ...fixedScriptOptions(root, script),
        platform: 'browser',
        format: 'iife',
        // A webview has no host CodeMirror instance to share, so everything is bundled.
        external: [],
    });
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
        throw new PluginScriptsError(`${configPath} "${key}" must be an array of paths relative to src/.`);
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
            throw new PluginScriptsError(
                `${configPath} lists a script that builds to dist/index.js, which is reserved for the main bundle.`
            );
        }
        if (seen.has(key)) {
            throw new PluginScriptsError(
                `${configPath} lists more than one script that builds to dist/${displayOutputPath(output)}.`
            );
        }
        seen.add(key);
    }
}

/**
 * Rejects build overrides that are not an object, set an option the package owns, or have
 * record options (`RECORD_OPTIONS`) or `external` values the build cannot merge.
 * @param {unknown} options
 * @param {keyof typeof BUILD_OPTION_KEYS} key
 * @param {string} configPath
 * @returns {asserts options is import('esbuild').BuildOptions}
 */
function assertBuildOptions(options, key, configPath) {
    if (!isPlainObject(options)) {
        throw new PluginScriptsError(`${configPath} "${key}" must be an object of esbuild options.`);
    }
    const reserved = BUILD_OPTION_KEYS[key].filter((option) => option in options);
    if (reserved.length > 0) {
        throw new PluginScriptsError(`${configPath} "${key}" cannot set ${reserved.join(', ')}.`);
    }
    for (const [option, type] of Object.entries(RECORD_OPTIONS)) {
        const value = options[/** @type {keyof typeof RECORD_OPTIONS} */ (option)];
        if (
            value !== undefined &&
            !(isPlainObject(value) && Object.values(value).every((entry) => typeof entry === type))
        ) {
            const description = option === 'define' ? 'string replacements' : `${type} values`;
            throw new PluginScriptsError(`${configPath} "${key}.${option}" must be an object of ${description}.`);
        }
    }
    const { external } = options;
    if (external !== undefined && !isStringArray(external)) {
        throw new PluginScriptsError(`${configPath} "${key}.external" must be an array of module names.`);
    }
}

/**
 * Validated contents of `plugin.config.json`, with defaults for omitted keys. Each bundle type's
 * overrides already include the shared `buildOptions`, so they can be passed directly to the
 * `create*BuildOptions` functions.
 * @typedef {object} PluginConfig
 * @property {string[]} extraScripts Content-script paths relative to `src/`.
 * @property {string[]} webviewScripts Webview-script paths relative to `src/`.
 * @property {import('esbuild').BuildOptions} mainBuildOptions Overrides for the main bundle.
 * @property {import('esbuild').BuildOptions} contentScriptBuildOptions Overrides for every content script.
 * @property {import('esbuild').BuildOptions} webviewScriptBuildOptions Overrides for every webview script.
 */

/**
 * Reads and validates `<root>/plugin.config.json`. The file is optional; a plugin without one
 * has no extra or webview scripts and uses the default build options.
 * @param {string} root Plugin project root.
 * @returns {Promise<PluginConfig>}
 */
export async function readPluginConfig(root) {
    const configPath = path.join(root, CONFIG_FILE);
    let config;
    try {
        config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
            throw new PluginScriptsError(`Could not read ${configPath}: ${errorMessage(error)}`, { cause: error });
        }
        config = {};
    }
    if (!isPlainObject(config)) throw new PluginScriptsError(`${configPath} must contain a JSON object.`);
    const {
        extraScripts = [],
        webviewScripts = [],
        buildOptions = {},
        mainBuildOptions = {},
        contentScriptBuildOptions = {},
        webviewScriptBuildOptions = {},
        ...unknown
    } = config;
    const unknownKeys = Object.keys(unknown);
    if (unknownKeys.length > 0) {
        throw new PluginScriptsError(`${configPath} has unknown keys: ${unknownKeys.join(', ')}.`);
    }
    assertScriptArray(extraScripts, 'extraScripts', configPath);
    assertScriptArray(webviewScripts, 'webviewScripts', configPath);
    assertValidScripts(configPath, extraScripts, webviewScripts);
    assertBuildOptions(buildOptions, 'buildOptions', configPath);
    assertBuildOptions(mainBuildOptions, 'mainBuildOptions', configPath);
    assertBuildOptions(contentScriptBuildOptions, 'contentScriptBuildOptions', configPath);
    assertBuildOptions(webviewScriptBuildOptions, 'webviewScriptBuildOptions', configPath);
    return {
        extraScripts,
        webviewScripts,
        mainBuildOptions: mergeOptions(buildOptions, mainBuildOptions),
        contentScriptBuildOptions: mergeOptions(buildOptions, contentScriptBuildOptions),
        webviewScriptBuildOptions: mergeOptions(buildOptions, webviewScriptBuildOptions),
    };
}
