import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PluginScriptsError } from './errors.mjs';
import { readProject } from './packagePlugin.mjs';

/** Matches a `major.minor.patch` version, e.g. `1.14.2`. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Captures the newline and indent after a JSON file's opening brace, e.g. `{\r\n  "name"` captures
 * `\r\n` and two spaces. This is how npm detects a lockfile's formatting.
 */
const JSON_FORMAT_PATTERN = /^\s*[{[]((?:\r?\n)+)([ \t]*)/;

/**
 * Serializes `value` in the formatting of `original`, as npm does when it rewrites a lockfile:
 * the same indent and newline style, ending with one newline. Text without a newline after its
 * opening brace (e.g. minified JSON) is written on one line, without a trailing newline.
 * @param {unknown} value
 * @param {string} original Text of the file being rewritten.
 * @returns {string}
 */
function stringifyLike(value, original) {
    const [, newlines = '', indent = ''] = JSON_FORMAT_PATTERN.exec(original) ?? [];
    const newline = newlines.startsWith('\r\n') ? '\r\n' : newlines.slice(0, 1);
    return `${JSON.stringify(value, null, indent)}\n`.replaceAll('\n', newline);
}

/**
 * Returns the text of a hand-formatted JSON file with its single `"version": "<from>"` entry
 * replaced, leaving every other byte untouched so a version bump produces a one-line diff.
 * @param {string} filePath
 * @param {string} from Current version in major.minor.patch format.
 * @param {string} to Replacement version in major.minor.patch format.
 * @returns {Promise<string>}
 */
async function replaceVersion(filePath, from, to) {
    const text = await readFile(filePath, 'utf8');
    // e.g. `"version": "1.14.2"`; `from` is validated semver, so only its dots need escaping.
    const pattern = new RegExp(`("version"\\s*:\\s*")${from.replaceAll('.', '\\.')}(")`, 'g');
    const matches = text.match(pattern)?.length ?? 0;
    if (matches !== 1) {
        throw new PluginScriptsError(`Expected one "version": "${from}" entry in ${filePath}, found ${matches}.`);
    }
    return text.replace(pattern, `$1${to}$2`);
}

/** Release types accepted by `updateVersion`, in the order they appear in messages. */
const RELEASE_TYPES = ['major', 'minor', 'patch'];

/**
 * Splits a validated `major.minor.patch` version into its numbers.
 * @param {string} version
 * @returns {number[]}
 */
function parseVersion(version) {
    return version.split('.').map(Number);
}

/**
 * Returns the version that follows `current` for `release`, which is `major`, `minor`, `patch`, or
 * an explicit `major.minor.patch` version higher than `current`.
 * @param {string} current Current version in major.minor.patch format.
 * @param {string} release
 * @returns {string}
 */
function nextVersion(current, release) {
    const parts = parseVersion(current);
    const index = RELEASE_TYPES.indexOf(release);
    if (index !== -1) {
        // Bumping a part resets the parts after it, e.g. a minor bump of 1.3.7 is 1.4.0.
        return [...parts.slice(0, index), parts[index] + 1, ...parts.slice(index + 1).map(() => 0)].join('.');
    }
    if (!SEMVER_PATTERN.test(release)) {
        throw new PluginScriptsError(
            `update-version expects ${RELEASE_TYPES.join(', ')}, or a major.minor.patch version; got "${release}".`
        );
    }
    // Compare numerically part by part, so 1.10.0 is higher than 1.9.0.
    const target = parseVersion(release);
    const difference = target.map((part, i) => part - parts[i]).find((d) => d !== 0) ?? 0;
    if (difference <= 0) {
        throw new PluginScriptsError(`update-version requires a version higher than ${current}; got ${release}.`);
    }
    // Normalize, e.g. 01.2.3 becomes 1.2.3.
    return target.join('.');
}

/**
 * Updates the version in `package.json`, `src/manifest.json`, and `package-lock.json` together.
 * Writes nothing unless all three files can be updated.
 * @param {string} root Plugin project root.
 * @param {string} [release] `major`, `minor`, or `patch` to increment that part (resetting the
 *   parts after it), or an explicit `major.minor.patch` version higher than the current one.
 * @returns {Promise<string>} The new version.
 */
export async function updateVersion(root, release = 'patch') {
    const { packageJson } = await readProject(root);
    const current = packageJson.version;
    if (!SEMVER_PATTERN.test(current)) {
        throw new PluginScriptsError('update-version requires a version in major.minor.patch format.');
    }
    const version = nextVersion(current, release);

    const lockPath = path.join(root, 'package-lock.json');
    const lockText = await readFile(lockPath, 'utf8');
    const lock = JSON.parse(lockText);
    const lockRoot = lock.packages?.[''];
    if (!lockRoot) {
        throw new PluginScriptsError(
            `${lockPath} has no root package entry (packages[""]); regenerate it with npm install.`
        );
    }
    if (lock.version !== current || lockRoot.version !== current) {
        throw new PluginScriptsError(
            `${lockPath} versions (${lock.version}, ${lockRoot.version}) do not match package.json (${current}); ` +
                'run npm install to resync the lockfile.'
        );
    }
    lock.version = version;
    lockRoot.version = version;

    const packagePath = path.join(root, 'package.json');
    const manifestPath = path.join(root, 'src/manifest.json');
    // Prepare every file before writing any, so a failed check leaves all versions in sync.
    const updates = [
        [packagePath, await replaceVersion(packagePath, current, version)],
        [manifestPath, await replaceVersion(manifestPath, current, version)],
        // npm owns the lockfile format, which is JSON.stringify output in the file's detected indent and
        // newline style; it is reserialized rather than patched because dependencies may share the version string.
        [lockPath, stringifyLike(lock, lockText)],
    ];
    for (const [filePath, text] of updates) await writeFile(filePath, text);
    return version;
}
