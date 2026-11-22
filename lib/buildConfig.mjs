import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { errorMessage, hasErrorCode, PluginScriptsError } from './errors.mjs';
import { describeInvalidWindowsName, invalidWindowsName, PATH_SEPARATOR_PATTERN, pathCollisionKey } from './paths.mjs';

/** @import { BuildOptions } from 'esbuild' */

/** Name of the optional per-plugin build configuration file at the project root. */
const CONFIG_FILE = 'plugin.config.json';

/** Matches a bundleable script extension, e.g. `a.ts`, `a.mts`, `a.cts`, `a.tsx`, `a.js`, `a.mjs`, `a.cjs`, `a.jsx`. */
const SCRIPT_EXTENSION_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * esbuild options managed by this package and unavailable to overrides:
 * - Input and output locations.
 * - `write`: the build bundles in memory and writes the outputs itself, after checking that they
 *   cannot overwrite each other or the runtime assets.
 * - `format`: Joplin loads the main bundle as CommonJS.
 * - `plugins`: plugin hooks cannot be represented in JSON.
 * - `bundle` and `packages`: each output must work as a single file.
 *   Setting `bundle: false` or `packages: "external"` would leave imports as
 *   `require` calls. Those calls could reference modules missing from the
 *   archive, or fail in a webview where `require` is unavailable.
 *
 * Individual packages can still be excluded from bundling with `external`.
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
 * @param {...BuildOptions} layers
 * @returns {BuildOptions}
 */
export function mergeOptions(...layers) {
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
 * @returns {BuildOptions}
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
 * @returns {BuildOptions}
 */
function fixedOptions(root, entryPoint, outfile) {
    return { absWorkingDir: root, entryPoints: [entryPoint], outfile, bundle: true };
}

/**
 * Returns the esbuild options for the main plugin bundle, `src/index.ts` to `dist/index.js`.
 * `mainBuildOptions` from the plugin config are merged over the defaults.
 * @param {string} root Plugin project root.
 * @param {BuildOptions} [overrides] The plugin config's `mainBuildOptions`.
 * @returns {BuildOptions}
 */
export function createBuildOptions(root, overrides = {}) {
    return mergeOptions({ ...defaultOptions(), platform: 'node' }, overrides, {
        ...fixedOptions(root, 'src/index.ts', 'dist/index.js'),
        format: 'cjs',
    });
}

/**
 * Rejects a script path that is not a bundleable script inside `src/`, e.g. `../a.ts` or `notes.txt`.
 * A leading `\` counts as absolute on every platform, matching `normalizeScriptPath`.
 * @param {string} script Script path relative to `src/`.
 */
function assertValidScriptPath(script) {
    if (
        !SCRIPT_EXTENSION_PATTERN.test(script) ||
        path.isAbsolute(script) ||
        PATH_SEPARATOR_PATTERN.test(script.charAt(0)) ||
        script.split(PATH_SEPARATOR_PATTERN).includes('..')
    ) {
        throw new PluginScriptsError(`Invalid script path: ${script}`);
    }
}

/**
 * Options content-script and webview-script bundles set after their overrides. The script path is
 * normalized as `readPluginConfig` does, so direct callers get the same entry point and output file.
 * @param {string} root Plugin project root.
 * @param {string} script Script path relative to `src/`.
 * @returns {BuildOptions}
 */
function fixedScriptOptions(root, script) {
    const normalized = normalizeScriptPath(script);
    return fixedOptions(root, `src/${normalized}`, `dist/${normalized.replace(SCRIPT_EXTENSION_PATTERN, '.js')}`);
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
 * @param {BuildOptions} [overrides] The plugin config's `contentScriptBuildOptions`.
 * @returns {BuildOptions}
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
 * @param {BuildOptions} [overrides] The plugin config's `webviewScriptBuildOptions`.
 * @returns {BuildOptions}
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
 * @param {string[]} extraScripts Content-script paths relative to `src/`, from `readPluginConfig`.
 * @param {string[]} webviewScripts Webview-script paths relative to `src/`, from `readPluginConfig`.
 * @returns {string[]} Bundle paths relative to `dist/`, using `/` separators.
 */
export function scriptOutputPaths(extraScripts, webviewScripts) {
    return [...extraScripts, ...webviewScripts].map((script) => script.replace(SCRIPT_EXTENSION_PATTERN, '.js'));
}

/**
 * Validates a configured script path and normalizes it to `/` separators with no `./` or repeated
 * separators. `\` counts as a separator on every platform, so a config written on Windows builds
 * the same everywhere. Rejects names its bundle could not be extracted under on Windows.
 * @param {string} script Script path relative to `src/`.
 * @returns {string}
 */
function normalizeScriptPath(script) {
    assertValidScriptPath(script);
    const normalized = path.posix.normalize(script.replaceAll('\\', '/'));
    const invalid = invalidWindowsName(normalized);
    if (invalid !== undefined) {
        throw new PluginScriptsError(
            `Script path ${script} ${describeInvalidWindowsName(invalid)}; rename the script.`
        );
    }
    return normalized;
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
 * Rejects a configuration entry that is not an array of paths relative to `src/`.
 * @param {unknown} value
 * @param {string} key
 * @param {string} configPath
 * @returns {asserts value is string[]}
 */
function assertPathArray(value, key, configPath) {
    if (!isStringArray(value)) {
        throw new PluginScriptsError(`${configPath} "${key}" must be an array of paths relative to src/.`);
    }
}

/**
 * Normalizes an `excludeAssets` entry to a slash-separated path relative to `src/` with no
 * leading `./` or trailing `/`, rejecting empty, absolute, or parent-traversing paths.
 * @param {string} assetPath Asset path relative to `src/`.
 * @returns {string}
 */
function normalizeExcludedAssetPath(assetPath) {
    if (assetPath === '' || path.isAbsolute(assetPath) || assetPath.split(PATH_SEPARATOR_PATTERN).includes('..')) {
        throw new PluginScriptsError(`Invalid excluded asset path: ${assetPath}`);
    }
    const normalized = path.posix.normalize(assetPath.replaceAll('\\', '/')).replace(/\/+$/, '');
    if (normalized === '' || normalized === '.' || normalized.startsWith('/')) {
        throw new PluginScriptsError(`Invalid excluded asset path: ${assetPath}`);
    }
    return normalized;
}

/**
 * Normalizes `excludeAssets` entries and rejects malformed paths or attempts to exclude
 * `src/manifest.json`.
 * @param {string} configPath Configuration file path used in error messages.
 * @param {string[]} excludeAssets Asset paths relative to `src/`.
 * @returns {string[]} Normalized `src/`-relative paths using `/` separators.
 */
function normalizeExcludedAssets(configPath, excludeAssets) {
    return excludeAssets.map((assetPath) => {
        const normalized = normalizeExcludedAssetPath(assetPath);
        if (normalized.toLowerCase() === 'manifest.json') {
            throw new PluginScriptsError(`${configPath} "excludeAssets" cannot exclude manifest.json.`);
        }
        return normalized;
    });
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
 * Rejects scripts that build to the main bundle's `dist/index.js`, and scripts that build to the
 * same output path. Paths are compared by `pathCollisionKey` on every platform: the archive may be
 * installed on a file system where `Editor.js` and `editor.js` are one file (Windows, macOS).
 * @param {string} configPath Configuration file path used in error messages.
 * @param {string[]} extraScripts Normalized content-script paths relative to `src/`.
 * @param {string[]} webviewScripts Normalized webview-script paths relative to `src/`.
 */
function assertDistinctScriptOutputs(configPath, extraScripts, webviewScripts) {
    const seen = new Set();
    for (const output of scriptOutputPaths(extraScripts, webviewScripts)) {
        const key = pathCollisionKey(output);
        if (key === 'index.js') {
            throw new PluginScriptsError(
                `${configPath} lists a script that builds to dist/index.js, which is reserved for the main bundle.`
            );
        }
        if (seen.has(key)) {
            throw new PluginScriptsError(`${configPath} lists more than one script that builds to dist/${output}.`);
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
 * @returns {asserts options is BuildOptions}
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
 * @property {string[]} extraScripts Content-script paths relative to `src/`, normalized to `/` separators.
 * @property {string[]} webviewScripts Webview-script paths relative to `src/`, normalized to `/` separators.
 * @property {string[]} excludeAssets Asset file or directory paths relative to `src/` to exclude from `dist/`.
 * @property {BuildOptions} mainBuildOptions Overrides for the main bundle.
 * @property {BuildOptions} contentScriptBuildOptions Overrides for every content script.
 * @property {BuildOptions} webviewScriptBuildOptions Overrides for every webview script.
 */

/**
 * Reads and validates `<root>/plugin.config.json`. The file is optional; a plugin without one
 * has no extra or webview scripts, no excluded assets, and uses the default build options.
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
        excludeAssets = [],
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
    assertPathArray(extraScripts, 'extraScripts', configPath);
    assertPathArray(webviewScripts, 'webviewScripts', configPath);
    assertPathArray(excludeAssets, 'excludeAssets', configPath);
    // Each path is validated as it is normalized, so a malformed one is reported as invalid,
    // not as the collision it normalizes to.
    const normalizedExtraScripts = extraScripts.map(normalizeScriptPath);
    const normalizedWebviewScripts = webviewScripts.map(normalizeScriptPath);
    assertDistinctScriptOutputs(configPath, normalizedExtraScripts, normalizedWebviewScripts);
    const normalizedExcludeAssets = normalizeExcludedAssets(configPath, excludeAssets);
    assertBuildOptions(buildOptions, 'buildOptions', configPath);
    assertBuildOptions(mainBuildOptions, 'mainBuildOptions', configPath);
    assertBuildOptions(contentScriptBuildOptions, 'contentScriptBuildOptions', configPath);
    assertBuildOptions(webviewScriptBuildOptions, 'webviewScriptBuildOptions', configPath);
    return {
        extraScripts: normalizedExtraScripts,
        webviewScripts: normalizedWebviewScripts,
        excludeAssets: normalizedExcludeAssets,
        mainBuildOptions: mergeOptions(buildOptions, mainBuildOptions),
        contentScriptBuildOptions: mergeOptions(buildOptions, contentScriptBuildOptions),
        webviewScriptBuildOptions: mergeOptions(buildOptions, webviewScriptBuildOptions),
    };
}
