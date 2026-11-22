import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    collectThirdPartyLicenses,
    formatThirdPartyLicenses,
    THIRD_PARTY_LICENSES_FILE,
    writeThirdPartyLicenses,
} from '../lib/licenses.mjs';
import { projectFixture, writeFiles } from './helpers.mjs';

/** @import { ImportKind, Metafile } from 'esbuild' */

/**
 * Builds a minimal esbuild metafile from a list of output input paths and optional extra input metadata.
 * @param {string[]} outputInputs Paths contributing non-zero bytes to `dist/index.js`.
 * @param {Record<string, { bytes: number, imports?: { path: string, kind: ImportKind, external?: boolean }[] }>} [extraInputs]
 * @returns {Metafile}
 */
function createMetafile(outputInputs, extraInputs = {}) {
    /** @type {Metafile['inputs']} */
    const inputs = {};
    /** @type {Metafile['outputs'][string]['inputs']} */
    const outInputs = {};
    for (const inputPath of outputInputs) {
        inputs[inputPath] = { bytes: 100, imports: [] };
        outInputs[inputPath] = { bytesInOutput: 100 };
    }
    for (const [inputPath, meta] of Object.entries(extraInputs)) {
        inputs[inputPath] = { bytes: meta.bytes, imports: meta.imports ?? [] };
    }
    return {
        inputs,
        outputs: {
            'dist/index.js': {
                bytes: 200,
                inputs: outInputs,
                imports: [],
                exports: [],
            },
        },
    };
}

test('collects license and notice files, skips root license and packages without license files', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        LICENSE: 'Plugin root license (must not be included)',
        'src/index.ts': 'export {};\n',
        'node_modules/pkg-b/package.json': JSON.stringify({ name: 'pkg-b', version: '2.0.0', license: 'Apache-2.0' }),
        'node_modules/pkg-b/LICENSE.txt': 'Apache License 2.0\r\n',
        'node_modules/pkg-b/NOTICE': 'Pkg B Notice\n',
        'node_modules/pkg-b/index.js': 'export const b = 1;\n',
        'node_modules/pkg-a/package.json': JSON.stringify({ name: 'pkg-a', version: '1.0.0', license: 'MIT' }),
        'node_modules/pkg-a/LICENCE.md': 'MIT License for pkg-a\n',
        'node_modules/pkg-a/license.js': 'export const notALicense = true;\n',
        'node_modules/pkg-a/index.js': 'export const a = 1;\n',
        'node_modules/no-license/package.json': JSON.stringify({
            name: 'no-license',
            version: '1.0.0',
            license: 'MIT',
        }),
        'node_modules/no-license/index.js': 'export const c = 1;\n',
        'node_modules/unused/package.json': JSON.stringify({ name: 'unused', version: '1.0.0', license: 'MIT' }),
        'node_modules/unused/LICENSE': 'Unused license\n',
        'node_modules/unused/index.js': 'export const u = 1;\n',
    });

    const metafile = createMetafile([
        'src/index.ts',
        'node_modules/pkg-b/index.js',
        'node_modules/pkg-a/index.js',
        'node_modules/no-license/index.js',
    ]);
    const collected = await collectThirdPartyLicenses(directory, [metafile]);
    assert.deepEqual(collected, [
        {
            name: 'pkg-a',
            version: '1.0.0',
            license: 'MIT',
            documents: [{ name: 'LICENCE.md', text: 'MIT License for pkg-a' }],
        },
        {
            name: 'pkg-b',
            version: '2.0.0',
            license: 'Apache-2.0',
            documents: [
                { name: 'LICENSE.txt', text: 'Apache License 2.0' },
                { name: 'NOTICE', text: 'Pkg B Notice' },
            ],
        },
    ]);

    const formatted = formatThirdPartyLicenses(collected);
    assert.match(formatted, /pkg-a@1\.0\.0 \(MIT\)\n={80}\n\nMIT License for pkg-a\n/);
    assert.match(formatted, /pkg-b@2\.0\.0 \(Apache-2\.0\)\n={80}\n\n--- LICENSE\.txt ---\n\nApache License 2\.0/);
    assert.match(formatted, /--- NOTICE ---\n\nPkg B Notice\n$/);
    assert.doesNotMatch(formatted, /Plugin root license/);
    assert.doesNotMatch(formatted, /no-license/);
    assert.doesNotMatch(formatted, /unused/);
});

test('walks past subdirectory package.json stubs and resolves dual licenses', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'node_modules/@scope/lib/package.json': JSON.stringify({
            name: '@scope/lib',
            version: '3.1.4',
            license: '(MIT OR Apache-2.0)',
        }),
        'node_modules/@scope/lib/LICENSE-MIT': 'MIT text\n',
        'node_modules/@scope/lib/LICENSE-APACHE': 'Apache text\n',
        'node_modules/@scope/lib/dist/esm/package.json': JSON.stringify({ type: 'module' }),
        'node_modules/@scope/lib/dist/esm/index.js': 'export const x = 1;\n',
    });

    const metafile = createMetafile(['node_modules/@scope/lib/dist/esm/index.js']);
    const collected = await collectThirdPartyLicenses(directory, [metafile]);
    assert.deepEqual(collected, [
        {
            name: '@scope/lib',
            version: '3.1.4',
            license: '(MIT OR Apache-2.0)',
            documents: [
                { name: 'LICENSE-APACHE', text: 'Apache text' },
                { name: 'LICENSE-MIT', text: 'MIT text' },
            ],
        },
    ]);
});

test('recognizes common license filename variants and skips similarly named code files', async (t) => {
    const { directory } = await projectFixture(t);
    const licenseNames = [
        'COPYING.LESSER',
        'LICENSE-MIT.txt',
        'LICENSE.APACHE2',
        'LICENSE.BSD',
        'LICENSE.rst',
        'LICENSE_MIT',
        'UNLICENSE',
    ];
    const codeNames = ['license.cjs', 'license.d.ts', 'LICENSE.json', 'license.js.map', 'license.mjs', 'license.tsx'];
    await writeFiles(directory, {
        'node_modules/variants/package.json': JSON.stringify({ name: 'variants', version: '1.0.0' }),
        'node_modules/variants/index.js': 'export const v = 1;\n',
        'node_modules/variants/licenses-checker': 'not a license file\n',
        ...Object.fromEntries(licenseNames.map((name) => [`node_modules/variants/${name}`, `${name} text\n`])),
        ...Object.fromEntries(codeNames.map((name) => [`node_modules/variants/${name}`, 'export {};\n'])),
    });

    const metafile = createMetafile(['node_modules/variants/index.js']);
    const [collected] = await collectThirdPartyLicenses(directory, [metafile]);
    assert.deepEqual(
        collected.documents.map((doc) => doc.name),
        licenseNames
    );
});

test('supports SEE LICENSE IN references while ignoring paths outside the package root', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'secret.txt': 'do not read\n',
        'node_modules/custom-lic/package.json': JSON.stringify({
            name: 'custom-lic',
            version: '1.0.0',
            license: 'SEE LICENSE IN docs/LEGAL.txt',
        }),
        'node_modules/custom-lic/docs/LEGAL.txt': 'Custom legal text\n',
        'node_modules/custom-lic/index.js': 'export {};\n',
        'node_modules/traversal/package.json': JSON.stringify({
            name: 'traversal',
            version: '1.0.0',
            license: 'SEE LICENSE IN ../../secret.txt',
        }),
        'node_modules/traversal/index.js': 'export {};\n',
    });

    const metafile = createMetafile(['node_modules/custom-lic/index.js', 'node_modules/traversal/index.js']);
    const collected = await collectThirdPartyLicenses(directory, [metafile]);
    assert.deepEqual(collected, [
        {
            name: 'custom-lic',
            version: '1.0.0',
            license: undefined,
            documents: [{ name: 'docs/LEGAL.txt', text: 'Custom legal text' }],
        },
    ]);
});

test('deduplicates packages across metafiles and symlinks', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'store/shared/package.json': JSON.stringify({ name: 'shared', version: '1.0.0', license: 'ISC' }),
        'store/shared/LICENSE': 'ISC License\n',
        'store/shared/index.js': 'export const shared = true;\n',
    });
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await symlink(
        path.join(directory, 'store/shared'),
        path.join(directory, 'node_modules/shared'),
        process.platform === 'win32' ? 'junction' : 'dir'
    );

    const first = createMetafile(['node_modules/shared/index.js']);
    const second = createMetafile(['store/shared/index.js']);
    const collected = await collectThirdPartyLicenses(directory, [first, second]);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].name, 'shared');
});

test('includes non-empty CSS url-token assets and skips empty-loaded assets', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'src/styles.css': 'body {}',
        'node_modules/font-pkg/package.json': JSON.stringify({
            name: 'font-pkg',
            version: '1.0.0',
            license: 'OFL-1.1',
        }),
        'node_modules/font-pkg/LICENSE': 'SIL Open Font License\n',
        'node_modules/font-pkg/font.woff2': 'woff2-bytes',
        'node_modules/empty-pkg/package.json': JSON.stringify({ name: 'empty-pkg', version: '1.0.0', license: 'MIT' }),
        'node_modules/empty-pkg/LICENSE': 'Should not be included\n',
        'node_modules/empty-pkg/font.woff': 'woff-bytes',
    });

    const metafile = createMetafile(['src/styles.css'], {
        'src/styles.css': {
            bytes: 100,
            imports: [
                { path: 'node_modules/font-pkg/font.woff2', kind: 'url-token' },
                { path: 'node_modules/empty-pkg/font.woff', kind: 'url-token' },
            ],
        },
        'node_modules/font-pkg/font.woff2': { bytes: 500 },
        'node_modules/empty-pkg/font.woff': { bytes: 0 },
    });

    const collected = await collectThirdPartyLicenses(directory, [metafile]);
    assert.deepEqual(
        collected.map((pkg) => pkg.name),
        ['font-pkg']
    );
});

test('writeThirdPartyLicenses omits the output file when no third-party licenses exist', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        LICENSE: 'Plugin own license\n',
        'src/index.ts': 'export {};\n',
    });
    const dist = path.join(directory, 'dist');
    const written = await writeThirdPartyLicenses(directory, dist, [createMetafile(['src/index.ts'])]);
    assert.equal(written, null);
    await assert.rejects(readFile(path.join(dist, THIRD_PARTY_LICENSES_FILE), 'utf8'), { code: 'ENOENT' });
});

test('does not walk into an enclosing workspace root or past a node_modules boundary', async (t) => {
    const { directory: workspace } = await projectFixture(t);
    await writeFiles(workspace, {
        'package.json': JSON.stringify({ name: 'monorepo-root', version: '0.0.0', private: true }),
        LICENSE: 'Monorepo root license (must not be included)\n',
        'packages/shared/util.ts': 'export const helper = () => 1;\n',
        'packages/my-plugin/package.json': JSON.stringify({ name: 'joplin-plugin-my', version: '1.0.0' }),
        'packages/my-plugin/src/index.ts': 'export {};\n',
        'node_modules/hoisted-pkg/package.json': JSON.stringify({
            name: 'hoisted-pkg',
            version: '1.0.0',
            license: 'MIT',
        }),
        'node_modules/hoisted-pkg/LICENSE': 'MIT License for hoisted-pkg\n',
        'node_modules/hoisted-pkg/index.js': 'export const hoisted = true;\n',
        'node_modules/broken-pkg/index.js': 'export const broken = true;\n',
    });

    const pluginRoot = path.join(workspace, 'packages/my-plugin');
    const metafile = createMetafile([
        'src/index.ts',
        '../shared/util.ts',
        '../../node_modules/hoisted-pkg/index.js',
        '../../node_modules/broken-pkg/index.js',
    ]);
    const collected = await collectThirdPartyLicenses(pluginRoot, [metafile]);
    assert.deepEqual(collected, [
        {
            name: 'hoisted-pkg',
            version: '1.0.0',
            license: 'MIT',
            documents: [{ name: 'LICENSE', text: 'MIT License for hoisted-pkg' }],
        },
    ]);
});
