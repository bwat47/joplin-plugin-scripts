import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { create } from 'tar';

import { errorMessage, hasErrorCode, PluginScriptsError } from './errors.mjs';

/**
 * Package metadata used by the build and version commands. Other fields are preserved.
 * @typedef {object} PackageMetadata
 * @property {string} name
 * @property {string} version
 * @property {string[]} [keywords]
 */

/**
 * Plugin manifest fields used by validation and packaging. Other fields are preserved.
 * @typedef {object} PluginManifest
 * @property {string} id
 * @property {string} version
 * @property {string[]} [categories]
 * @property {{ src: string }[]} [screenshots] Local or remote screenshots.
 */

/**
 * Plugin repository categories accepted in `manifest.categories`.
 * Mirrors generator-joplin's list; `update-api` warns when they differ.
 */
export const VALID_CATEGORIES = new Set([
    'appearance',
    'developer tools',
    'productivity',
    'themes',
    'integrations',
    'viewer',
    'search',
    'tags',
    'editor',
    'files',
    'personal knowledge management',
]);

/** File extensions accepted for local manifest screenshots. */
const SCREENSHOT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Maximum size of a local manifest screenshot. */
const MAX_SCREENSHOT_BYTES = 1024 * 1024;

/** Matches a remote screenshot URL, which is not validated locally, e.g. `https://example.com/a.png`. */
const REMOTE_URL_PATTERN = /^https?:\/\//;

/** Matches a valid plugin ID, e.g. `com.example.my-plugin` (letters, digits, `_`, `.`, `-`). */
const PLUGIN_ID_PATTERN = /^[\w.-]+$/;

/**
 * Reads and parses a project JSON file, explaining a missing or malformed file without a stack trace.
 * @param {string} root Plugin project root.
 * @param {string} relativePath Path relative to `root`, e.g. `src/manifest.json`.
 * @returns {Promise<any>}
 */
async function readProjectJson(root, relativePath) {
    const filePath = path.join(root, relativePath);
    let text;
    try {
        text = await readFile(filePath, 'utf8');
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
        throw new PluginScriptsError(`${filePath} not found; run this command from the plugin project root.`, {
            cause: error,
        });
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new PluginScriptsError(`${filePath} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
}

/**
 * Rejects a manifest screenshot without `src`, or a local one that is missing, of an unsupported
 * type, or too large. Remote screenshots are not checked.
 * @param {string} root Plugin project root.
 * @param {{ src: string }} screenshot
 */
async function assertValidScreenshot(root, screenshot) {
    if (!screenshot.src) throw new PluginScriptsError('Manifest screenshot must specify src.');
    if (REMOTE_URL_PATTERN.test(screenshot.src)) return;
    if (!SCREENSHOT_EXTENSIONS.has(path.extname(screenshot.src))) {
        throw new PluginScriptsError(`Unsupported screenshot type: ${screenshot.src}`);
    }
    let size;
    try {
        ({ size } = await stat(path.join(root, screenshot.src)));
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
        throw new PluginScriptsError(`Screenshot not found: ${screenshot.src}`, { cause: error });
    }
    if (size > MAX_SCREENSHOT_BYTES) {
        throw new PluginScriptsError(
            `Screenshot exceeds ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} MB: ${screenshot.src}`
        );
    }
}

/**
 * Reads `package.json` and `src/manifest.json` from `root` and validates the fields the plugin
 * repository depends on: plugin ID, matching versions, package name and keyword, categories, and
 * local screenshots.
 * @param {string} root Plugin project root.
 * @returns {Promise<{ packageJson: PackageMetadata, manifest: PluginManifest }>}
 */
export async function readProject(root) {
    /** @type {PackageMetadata} */
    const packageJson = await readProjectJson(root, 'package.json');
    /** @type {PluginManifest} */
    const manifest = await readProjectJson(root, 'src/manifest.json');
    if (!manifest.id || !PLUGIN_ID_PATTERN.test(manifest.id)) {
        throw new PluginScriptsError(
            'Manifest plugin ID must contain only letters, digits, underscores, dots, or hyphens.'
        );
    }
    if (manifest.version !== packageJson.version) {
        throw new PluginScriptsError('package.json and src/manifest.json versions must match.');
    }
    if (!packageJson.name?.startsWith('joplin-plugin-') || !packageJson.keywords?.includes('joplin-plugin')) {
        throw new PluginScriptsError(
            'Package name must start with joplin-plugin- and keywords must include joplin-plugin.'
        );
    }
    const selectedCategories = manifest.categories ?? [];
    if (
        new Set(selectedCategories).size !== selectedCategories.length ||
        selectedCategories.some((category) => !VALID_CATEGORIES.has(category))
    ) {
        throw new PluginScriptsError('Manifest contains invalid or repeated categories.');
    }
    for (const screenshot of manifest.screenshots ?? []) await assertValidScreenshot(root, screenshot);
    return { packageJson, manifest };
}

/** Branch recorded in `_publish_commit` when the build runs from a detached HEAD. */
const DEFAULT_BRANCH = 'main';

/**
 * Reads the branch and commit for publish metadata, or an empty string outside Git.
 * @param {string} root Plugin project root.
 * @returns {string}
 */
function currentGitInfo(root) {
    try {
        // Git is intentionally resolved from the developer's PATH, with fixed arguments and no shell.
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Local build tool using the developer's Git installation.
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: 'pipe' })
            .toString()
            .trim();
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Fixed Git arguments, without a shell.
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }).toString().trim();
        // A detached HEAD (e.g. a CI tag checkout) reports `HEAD`; record the default branch instead.
        return `${branch === 'HEAD' ? DEFAULT_BRANCH : branch}:${commit}`;
    } catch {
        return '';
    }
}

/**
 * Lists files under `directory`, skipping dotfiles and dot-directories (e.g. `.DS_Store`, `.gitkeep`).
 * @param {string} directory
 * @param {string} [prefix] Relative parent path, including its trailing slash.
 * @returns {Promise<string[]>} Sorted file paths with forward slashes and the supplied prefix.
 */
async function listFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
            files.push(...(await listFiles(path.join(directory, entry.name), `${relativePath}/`)));
        } else {
            files.push(relativePath);
        }
    }
    return files.sort();
}

/**
 * Archives `<root>/dist` into `<root>/publish/<id>.jpl` and writes `<id>.json` publish metadata.
 * `extraScripts` are bundle paths relative to `dist/` that must exist before packaging.
 * @param {string} root Plugin project root.
 * @param {PluginManifest} manifest Validated plugin manifest, including its plugin ID.
 * @param {string[]} [extraScripts] Required bundle paths relative to `dist/`.
 */
export async function packagePlugin(root, manifest, extraScripts = []) {
    const dist = path.join(root, 'dist');
    const publish = path.join(root, 'publish');
    // Require the entry point and manifest, rather than publishing an incomplete build.
    await stat(path.join(dist, 'index.js'));
    await stat(path.join(dist, 'manifest.json'));
    for (const script of extraScripts) await stat(path.join(dist, script));
    await mkdir(publish, { recursive: true });
    const archivePath = path.join(publish, `${manifest.id}.jpl`);
    // Package files only, matching the generator and excluding empty source directories.
    await create({ cwd: dist, file: archivePath, portable: true, strict: true }, await listFiles(dist));
    const hash = createHash('sha256')
        .update(await readFile(archivePath))
        .digest('hex');
    const info = { ...manifest, _publish_hash: `sha256:${hash}`, _publish_commit: currentGitInfo(root) };
    await writeFile(path.join(publish, `${manifest.id}.json`), `${JSON.stringify(info, null, 4)}\n`);
}
