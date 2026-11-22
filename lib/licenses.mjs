import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hasErrorCode } from './errors.mjs';
import { isInsideDirectory } from './paths.mjs';

/** @import { Metafile } from 'esbuild' */

/** Filename written to `dist/` when bundled third-party packages include license or notice files. */
export const THIRD_PARTY_LICENSES_FILE = 'THIRD-PARTY-LICENSES.txt';

/**
 * Matches standalone license files in a package root, e.g. `LICENSE`, `LICENCE.md`, `LICENSE-MIT`,
 * `LICENSE_MIT`, `LICENSE.APACHE2`, `COPYING.LESSER`, `UNLICENSE`. Code files with similar names are
 * excluded by {@link CODE_FILE_PATTERN}.
 */
const LICENSE_FILE_PATTERN =
    /^(?:un)?licen[cs]e(?:[-._][a-z0-9][a-z0-9._-]*)?$|^copying(?:[-._][a-z0-9][a-z0-9._-]*)?$/i;

/** Matches code and data files that a license-like name can still belong to, e.g. `license.js`, `LICENSE.d.ts`. */
const CODE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|json|map)$/i;

/** Matches standalone notice files in a package root, e.g. `NOTICE`, `NOTICE.txt`, `NOTICE.md`. */
const NOTICE_FILE_PATTERN = /^notice(?:\.(?:txt|md|markdown))?$/i;

/** Matches npm's `SEE LICENSE IN <file>` license field format. */
const SEE_LICENSE_PATTERN = /^SEE LICEN[CS]E IN (.+)$/i;

/** Divider printed above and below each package header in `THIRD-PARTY-LICENSES.txt`. */
const HEADER_DIVIDER = '='.repeat(80);

/**
 * Package metadata discovered by walking upward from a bundled input file.
 * @typedef {object} PackageInfo
 * @property {string} dir Canonical package root directory.
 * @property {string} name Package name from `package.json`.
 * @property {string} version Package version from `package.json`, or empty string if absent.
 * @property {string | undefined} license Raw `license` string from `package.json`, if present.
 */

/**
 * A collected license or notice file belonging to a bundled third-party package.
 * @typedef {object} LicenseDocument
 * @property {string} name Filename relative to the package root, with forward slashes.
 * @property {string} text Normalized license text (LF line endings, trimmed).
 */

/**
 * Collected license documents for one bundled third-party package.
 * @typedef {object} PackageLicenses
 * @property {string} name Package name.
 * @property {string} version Package version, or empty string if absent.
 * @property {string | undefined} license SPDX or license summary from `package.json`, if not a `SEE LICENSE IN` reference.
 * @property {LicenseDocument[]} documents Collected license and notice files, license files first.
 */

/**
 * Compares two strings by Unicode code point for locale-independent deterministic sorting.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Returns the deduplicated input paths that contributed bytes to at least one esbuild output,
 * including CSS `url(...)` assets inlined from another file (while skipping `empty`-loaded assets).
 * @param {Metafile[]} metafiles
 * @returns {string[]}
 */
function collectBundledInputs(metafiles) {
    /** @type {Set<string>} */
    const inputs = new Set();
    for (const metafile of metafiles) {
        for (const output of Object.values(metafile.outputs)) {
            for (const [inputPath, { bytesInOutput }] of Object.entries(output.inputs)) {
                if (bytesInOutput <= 0) continue;
                inputs.add(inputPath);
                for (const asset of inlinedUrlAssets(metafile, inputPath)) inputs.add(asset);
            }
        }
    }
    return [...inputs];
}

/**
 * Returns the non-empty assets an input pulls in through CSS `url(...)`, which esbuild inlines
 * without listing them as inputs of the output.
 * @param {Metafile} metafile
 * @param {string} inputPath
 * @returns {string[]}
 */
function inlinedUrlAssets(metafile, inputPath) {
    return (metafile.inputs[inputPath]?.imports ?? [])
        .filter((imp) => !imp.external && imp.kind === 'url-token' && (metafile.inputs[imp.path]?.bytes ?? 0) > 0)
        .map((imp) => imp.path);
}

/**
 * Reads a directory's `package.json` if it defines a non-empty `name` field.
 * Subdirectory stubs such as `{"type": "module"}` return `null` so the search continues upward.
 * @param {string} dir
 * @returns {Promise<PackageInfo | null>}
 */
async function readPackageInfo(dir) {
    let text;
    try {
        text = await readFile(path.join(dir, 'package.json'), 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return null;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.name !== 'string' || parsed.name === '') {
        return null;
    }
    return {
        dir,
        name: parsed.name,
        version: typeof parsed.version === 'string' ? parsed.version : '',
        license: typeof parsed.license === 'string' ? parsed.license.trim() || undefined : undefined,
    };
}

/**
 * Walks upward from `startDir` to find the nearest owning third-party package root, stopping at
 * `rootRealPath`, any enclosing ancestor of `rootRealPath` (e.g. a monorepo workspace root), or a
 * `node_modules` directory boundary.
 * @param {string} startDir Canonical directory of a bundled input file.
 * @param {string} rootRealPath Canonical path of the plugin project root.
 * @param {Map<string, PackageInfo | null>} cache Per-directory memoization cache.
 * @returns {Promise<PackageInfo | null>}
 */
async function findOwningPackage(startDir, rootRealPath, cache) {
    /** @type {string[]} */
    const visited = [];
    let current = startDir;
    /** @type {PackageInfo | null} */
    let found = null;
    while (true) {
        if (cache.has(current)) {
            found = cache.get(current) ?? null;
            break;
        }
        if (
            current === rootRealPath ||
            isInsideDirectory(current, rootRealPath) ||
            path.basename(current) === 'node_modules'
        ) {
            visited.push(current);
            break;
        }
        visited.push(current);
        const info = await readPackageInfo(current);
        if (info) {
            found = info;
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    for (const dir of visited) cache.set(dir, found);
    return found;
}

/**
 * Reads a text file and normalizes it to LF line endings with trimmed outer whitespace.
 * Returns `null` if the file does not exist, is not a regular file, or is empty.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readLicenseText(filePath) {
    let text;
    try {
        text = await readFile(filePath, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EISDIR') || hasErrorCode(error, 'ENOTDIR')) {
            return null;
        }
        throw error;
    }
    const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Collects standalone license and notice files from a package root directory.
 * @param {PackageInfo} pkg
 * @returns {Promise<PackageLicenses | null>}
 */
async function readPackageLicenses(pkg) {
    const relativePaths = await listLicenseFiles(pkg.dir);
    const seeMatch = pkg.license ? SEE_LICENSE_PATTERN.exec(pkg.license) : null;
    const referenced = seeMatch ? referencedLicensePath(pkg.dir, seeMatch[1]) : undefined;
    if (referenced && !relativePaths.some((existing) => existing.toLowerCase() === referenced.toLowerCase())) {
        relativePaths.unshift(referenced);
    }

    /** @type {LicenseDocument[]} */
    const documents = [];
    for (const relative of relativePaths) {
        const text = await readLicenseText(path.join(pkg.dir, relative));
        if (text !== null) documents.push({ name: relative, text });
    }
    if (documents.length === 0) return null;

    return {
        name: pkg.name,
        version: pkg.version,
        license: seeMatch ? undefined : pkg.license,
        documents,
    };
}

/**
 * Lists a package root's license files, then its notice files, each sorted case-insensitively.
 * @param {string} dir Package root directory.
 * @returns {Promise<string[]>}
 */
async function listLicenseFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    /** @type {string[]} */
    const licenseNames = [];
    /** @type {string[]} */
    const noticeNames = [];
    for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (LICENSE_FILE_PATTERN.test(entry.name) && !CODE_FILE_PATTERN.test(entry.name)) {
            licenseNames.push(entry.name);
        } else if (NOTICE_FILE_PATTERN.test(entry.name)) {
            noticeNames.push(entry.name);
        }
    }
    const byLowerCase = (/** @type {string} */ left, /** @type {string} */ right) =>
        compareStrings(left.toLowerCase(), right.toLowerCase());
    return [...licenseNames.sort(byLowerCase), ...noticeNames.sort(byLowerCase)];
}

/**
 * Resolves the file a `SEE LICENSE IN <file>` license field points to, relative to the package root
 * with `/` separators, or `undefined` if it points outside the package.
 * @param {string} dir Package root directory.
 * @param {string} reference The `<file>` part of the license field.
 * @returns {string | undefined}
 */
function referencedLicensePath(dir, reference) {
    const referenced = path.resolve(dir, reference.trim());
    if (!isInsideDirectory(dir, referenced)) return undefined;
    return path.relative(dir, referenced).replaceAll('\\', '/');
}

/**
 * Formats collected third-party package licenses into the contents of `THIRD-PARTY-LICENSES.txt`.
 * @param {PackageLicenses[]} packages
 * @returns {string}
 */
export function formatThirdPartyLicenses(packages) {
    return (
        packages
            .map((pkg) => {
                const identifier = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
                const heading = pkg.license ? `${identifier} (${pkg.license})` : identifier;
                const body =
                    pkg.documents.length === 1
                        ? pkg.documents[0].text
                        : pkg.documents.map((doc) => `--- ${doc.name} ---\n\n${doc.text}`).join('\n\n');
                return `${HEADER_DIVIDER}\n${heading}\n${HEADER_DIVIDER}\n\n${body}`;
            })
            .join('\n\n') + '\n'
    );
}

/**
 * Collects standalone license and notice files for every third-party package bundled in `metafiles`.
 * Packages without license or notice files are skipped.
 * @param {string} root Plugin project root.
 * @param {Metafile[]} metafiles Metafiles returned by esbuild for the plugin's bundles.
 * @returns {Promise<PackageLicenses[]>} Sorted, deduplicated third-party package licenses.
 */
export async function collectThirdPartyLicenses(root, metafiles) {
    const rootRealPath = await realpath(root);
    /** @type {Map<string, PackageInfo | null>} */
    const dirCache = new Map();
    /** @type {Map<string, PackageInfo>} */
    const packagesByDir = new Map();

    for (const inputPath of collectBundledInputs(metafiles)) {
        let realInput;
        try {
            realInput = await realpath(path.resolve(root, inputPath));
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) continue;
            throw error;
        }
        const pkg = await findOwningPackage(path.dirname(realInput), rootRealPath, dirCache);
        if (pkg && !packagesByDir.has(pkg.dir)) packagesByDir.set(pkg.dir, pkg);
    }

    /** @type {PackageLicenses[]} */
    const collected = [];
    /** @type {Set<string>} */
    const seenContent = new Set();
    for (const pkg of packagesByDir.values()) {
        const entry = await readPackageLicenses(pkg);
        if (!entry) continue;
        const key = JSON.stringify([entry.name, entry.version, entry.documents.map((doc) => doc.text)]);
        if (seenContent.has(key)) continue;
        seenContent.add(key);
        collected.push(entry);
    }

    collected.sort(
        (left, right) => compareStrings(left.name, right.name) || compareStrings(left.version, right.version)
    );
    return collected;
}

/**
 * Writes `<dist>/THIRD-PARTY-LICENSES.txt` when any bundled third-party package includes a license
 * or notice file. Returns the written file path, or `null` when nothing was written.
 * @param {string} root Plugin project root.
 * @param {string} dist Plugin `dist/` output directory.
 * @param {Metafile[]} metafiles Metafiles returned by esbuild for the plugin's bundles.
 * @returns {Promise<string | null>}
 */
export async function writeThirdPartyLicenses(root, dist, metafiles) {
    const packages = await collectThirdPartyLicenses(root, metafiles);
    if (packages.length === 0) return null;
    const outputPath = path.join(dist, THIRD_PARTY_LICENSES_FILE);
    await writeFile(outputPath, formatThirdPartyLicenses(packages), 'utf8');
    return outputPath;
}
