/**
 * Checks whether a caught value is an error with the given Node.js error code, e.g. `ENOENT`.
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
export function hasErrorCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Returns a caught value's message for use in a wrapping error or warning.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
