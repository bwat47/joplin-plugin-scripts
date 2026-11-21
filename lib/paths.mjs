import path from 'node:path';

/** Splits a path on either separator, e.g. `a/b\c` becomes `['a', 'b', 'c']`. */
export const PATH_SEPARATOR_PATTERN = /[\\/]/;

/**
 * Converts a native relative path to normalized `/` separators, e.g. `scripts\a.js` as `scripts/a.js`
 * on Windows. On Linux and macOS, `\` is an ordinary file-name character and is kept.
 * @param {string} relativePath
 * @returns {string}
 */
export function toSlashPath(relativePath) {
    return path.normalize(relativePath).split(path.sep).join('/');
}

/**
 * Returns the key under which two paths name the same file somewhere the plugin may be installed.
 * Windows and macOS ignore letter case, so `Logo.png` and `logo.png` are one file there, and macOS
 * also ignores Unicode normalization, so `é` as one code point (NFC) or as `e` plus a combining
 * accent (NFD) is one name.
 * @param {string} relativePath Path with `/` separators.
 * @returns {string}
 */
export function pathCollisionKey(relativePath) {
    return relativePath.toLowerCase().normalize('NFC');
}

/** Characters Windows forbids in a file or directory name: `\` (a folder separator there), `<>:"|?*`, and controls. */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
const WINDOWS_INVALID_CHARACTER = /[\\<>:"|?*\u0000-\u001f]/;

/** Device names Windows reserves, with or without an extension, e.g. `con` or `NUL.txt`. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Returns the first `/`-separated name in `relativePath` that Windows cannot extract unchanged, or
 * `undefined` if there is none. Joplin installs the archive by extracting it, so such a file would
 * fail to install or land at a different path there, possibly over another file. A name fails if it
 * has a character Windows forbids (including `\`, a separator there), ends in a dot or space (which
 * Windows strips), or is a reserved device name such as `CON` or `nul.txt`.
 * @param {string} relativePath Path with `/` separators.
 * @returns {string | undefined}
 */
export function invalidWindowsName(relativePath) {
    return relativePath
        .split('/')
        .find(
            (name) =>
                WINDOWS_INVALID_CHARACTER.test(name) ||
                /[. ]$/.test(name) ||
                WINDOWS_RESERVED_NAME.test(name.split('.')[0].trimEnd())
        );
}

/**
 * Describes a name `invalidWindowsName` returned, to follow the path it is part of, e.g.
 * `src/a:b.png cannot be extracted on Windows because of the name "a:b.png" (…)`. The name is quoted
 * with `JSON.stringify`, so control characters and trailing spaces are visible.
 * @param {string} name
 * @returns {string}
 */
export function describeInvalidWindowsName(name) {
    return (
        `cannot be extracted on Windows because of the name ${JSON.stringify(name)} ` +
        '(names cannot contain \\ < > : " | ? * or control characters, end in a dot or space, ' +
        'or be reserved, e.g. CON)'
    );
}

/**
 * Returns whether `candidate` stays inside `baseDir`.
 * @param {string} baseDir
 * @param {string} candidate
 * @returns {boolean}
 */
export function isInsideDirectory(baseDir, candidate) {
    const relative = path.relative(baseDir, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
