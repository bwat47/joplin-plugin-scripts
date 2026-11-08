import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extract } from 'tar';

import { contentScriptExternals } from './buildConfig.mjs';
import { errorMessage, hasErrorCode, PluginScriptsError } from './errors.mjs';
import { VALID_CATEGORIES } from './packagePlugin.mjs';

const templates = 'package/generators/app/templates';

/** Package whose templates provide the plugin API declarations. */
const GENERATOR_PACKAGE = 'generator-joplin';

/** Registry used when npm has not set `npm_config_registry`, e.g. outside npm scripts. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Time allowed for each registry request. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Matches the generator's category list, e.g.
 * `const allPossibleCategories = [{'name':'appearance'},{'name':'editor'}];`
 */
const GENERATOR_CATEGORIES_PATTERN = /const allPossibleCategories = \[(.*?)\];/s;

/** Matches one category entry within that list, e.g. `{'name':'developer tools'}` captures `developer tools`. */
const GENERATOR_CATEGORY_NAME_PATTERN = /["']name["']\s*:\s*["']([^"']+)["']/g;

/**
 * Matches the generator's content-script externals, e.g.
 * `const externalContentScriptLibraries = [\n\t'@codemirror/view',\n\t'@lezer/common',\n];`
 */
const GENERATOR_EXTERNALS_PATTERN = /const externalContentScriptLibraries = \[([^\]]*)\]/;

/** Matches one quoted string, e.g. `'@codemirror/view'` captures `@codemirror/view`. */
const QUOTED_STRING_PATTERN = /["']([^"']+)["']/g;

/** Where the hand-maintained lists live, for warnings shown in plugin projects. */
const LIST_SOURCE = '@bwat47/joplin-plugin-scripts';

/**
 * Copies a source directory into a destination directory.
 * @typedef {(from: string, to: string) => Promise<void>} CopyDirectory
 */

/**
 * Extracts string entries from a generator configuration list.
 * @param {string} text
 * @param {RegExp} listPattern Pattern capturing the list contents.
 * @param {RegExp} itemPattern Global pattern capturing each entry.
 * @returns {string[] | undefined}
 */
function extractList(text, listPattern, itemPattern) {
    const list = listPattern.exec(text)?.[1];
    return list === undefined ? undefined : [...list.matchAll(itemPattern)].map((match) => match[1]);
}

/**
 * Describes missing or unexpected entries in a maintained list.
 * @param {string} label List name for warning messages.
 * @param {string[] | undefined} generatorItems Entries found in the generator, or `undefined` if the list was not found.
 * @param {Iterable<string>} localItems Locally maintained entries.
 * @param {string} location Source location to update.
 * @returns {string | undefined}
 */
function describeListDifference(label, generatorItems, localItems, location) {
    if (generatorItems === undefined) {
        return `Could not find the ${label} in generator-joplin's webpack.config.js; compare ${location} manually.`;
    }
    const local = new Set(localItems);
    const generator = new Set(generatorItems);
    const missing = [...generator].filter((item) => !local.has(item));
    const extra = [...local].filter((item) => !generator.has(item));
    if (missing.length === 0 && extra.length === 0) return undefined;
    const details = [
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        extra.length > 0 ? `not in generator ${extra.join(', ')}` : '',
    ].filter(Boolean);
    return `The ${label} differ from generator-joplin (${details.join('; ')}); update ${location}.`;
}

/**
 * Compares the hand-maintained category and content-script external lists with the ones in
 * generator-joplin's `webpack.config.js` text. Returns one warning per list that differs or
 * cannot be found; an empty array means both match.
 * @param {string} webpackConfig
 * @returns {string[]}
 */
export function compareGeneratorLists(webpackConfig) {
    return [
        describeListDifference(
            'plugin categories',
            extractList(webpackConfig, GENERATOR_CATEGORIES_PATTERN, GENERATOR_CATEGORY_NAME_PATTERN),
            VALID_CATEGORIES,
            `VALID_CATEGORIES in ${LIST_SOURCE} (lib/packagePlugin.mjs)`
        ),
        describeListDifference(
            'content-script externals',
            extractList(webpackConfig, GENERATOR_EXTERNALS_PATTERN, QUOTED_STRING_PATTERN),
            contentScriptExternals,
            `contentScriptExternals in ${LIST_SOURCE} (lib/buildConfig.mjs)`
        ),
    ].filter((warning) => warning !== undefined);
}

/**
 * Replaces `<root>/api` with a copy of `source`. The copy is staged next to `api/` and swapped in
 * by rename, so a failed copy leaves the existing `api/` untouched. `copy` defaults to a recursive copy.
 * @param {string} root Plugin project root.
 * @param {string} source
 * @param {CopyDirectory} [copy] Copies the API into the staging directory.
 */
export async function replaceApi(root, source, copy = (from, to) => cp(from, to, { recursive: true })) {
    // Fail before changing anything if the generator layout has changed.
    await stat(path.join(source, 'index.ts'));
    const destination = path.join(root, 'api');
    const staging = await mkdtemp(path.join(root, '.api-staging-'));
    const backup = `${staging}-previous`;
    try {
        await copy(source, staging);
        let hadPrevious = true;
        try {
            await rename(destination, backup);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
            hadPrevious = false;
        }
        try {
            await rename(staging, destination);
        } catch (error) {
            if (hadPrevious) await rename(backup, destination);
            throw error;
        }
        if (hadPrevious) await rm(backup, { recursive: true, force: true });
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

/**
 * Reads the generator configuration and reports maintained-list differences.
 * @param {string} webpackConfigPath
 * @returns {Promise<string[]>}
 */
async function readGeneratorWarnings(webpackConfigPath) {
    let webpackConfig;
    try {
        webpackConfig = await readFile(webpackConfigPath, 'utf8');
    } catch (error) {
        return [`Could not read ${webpackConfigPath} (${errorMessage(error)}); compare the build lists manually.`];
    }
    return compareGeneratorLists(webpackConfig);
}

/**
 * Fetches and reads a registry URL, turning download failures into a plain error message.
 * @template T
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {(response: Response) => Promise<T>} readBody
 * @returns {Promise<T>}
 */
async function fetchOk(fetchImpl, url, readBody) {
    try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await readBody(response);
    } catch (error) {
        throw new PluginScriptsError(`Could not download ${url}: ${errorMessage(error)}`, { cause: error });
    }
}

/**
 * Rejects tarball bytes that do not match the registry's sha512 Subresource Integrity value,
 * e.g. `sha512-<base64>`. Other algorithms in the value are ignored; one sha512 match is enough.
 * @param {Buffer} tarball
 * @param {unknown} integrity
 * @param {string} url Tarball URL used in error messages.
 */
function assertIntegrity(tarball, integrity, url) {
    const expected =
        typeof integrity === 'string'
            ? integrity
                  .split(/\s+/)
                  .filter((entry) => entry.startsWith('sha512-'))
                  .map((entry) => entry.slice('sha512-'.length))
            : [];
    if (expected.length === 0) {
        throw new PluginScriptsError(`The registry did not provide a sha512 integrity value for ${url}.`);
    }
    const actual = createHash('sha512').update(tarball).digest('base64');
    if (!expected.includes(actual)) {
        throw new PluginScriptsError(`Integrity check failed for ${url}; the download may be corrupt.`);
    }
}

/**
 * Options for {@link updateApi}, for tests and alternative registries.
 * @typedef {object} UpdateApiOptions
 * @property {string} [registry] Registry base URL; defaults to npm's configured registry or registry.npmjs.org.
 * @property {typeof fetch} [fetch] Fetch implementation used for registry requests.
 */

/**
 * Replaces `<root>/api` with the API declarations from the latest generator-joplin package,
 * downloaded from the npm registry and checked against its published integrity hash.
 * Nothing else in the project is touched. Returns the generator version used and warnings for
 * hand-maintained build lists that no longer match the generator.
 * @param {string} root Plugin project root.
 * @param {UpdateApiOptions} [options]
 * @returns {Promise<{ version: string, warnings: string[] }>}
 */
export async function updateApi(
    root,
    { registry = process.env.npm_config_registry || DEFAULT_REGISTRY, fetch: fetchImpl = fetch } = {}
) {
    // A trailing slash keeps a registry path, e.g. `https://host/npm`, as the base of the request.
    const metadataUrl = new URL(`${GENERATOR_PACKAGE}/latest`, registry.endsWith('/') ? registry : `${registry}/`).href;
    const metadata = await fetchOk(fetchImpl, metadataUrl, (response) => response.json());
    const tarballUrl = metadata?.dist?.tarball;
    if (typeof tarballUrl !== 'string') {
        throw new PluginScriptsError(`${metadataUrl} did not include a tarball URL.`);
    }
    const tarball = Buffer.from(await fetchOk(fetchImpl, tarballUrl, (response) => response.arrayBuffer()));
    assertIntegrity(tarball, metadata.dist.integrity, tarballUrl);

    const temp = await mkdtemp(path.join(tmpdir(), 'joplin-api-'));
    try {
        const tarballPath = path.join(temp, 'generator.tgz');
        await writeFile(tarballPath, tarball);
        await extract({ file: tarballPath, cwd: temp, strict: true });
        const { version } = JSON.parse(await readFile(path.join(temp, 'package/package.json'), 'utf8'));
        await replaceApi(root, path.join(temp, templates, 'api'));
        const warnings = await readGeneratorWarnings(path.join(temp, templates, 'webpack.config.js'));
        return { version, warnings };
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}
