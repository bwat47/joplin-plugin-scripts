import path from 'node:path';

/** Splits a path on either separator, e.g. `a/b\c` becomes `['a', 'b', 'c']`. */
export const PATH_SEPARATOR_PATTERN = /[\\/]/;

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
