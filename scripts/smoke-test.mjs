// Packs this package, installs the tarball into a throwaway plugin project, and exercises what
// consumers get: the packed file list, the `bin` shim, a real build, the public import, and the
// shipped declarations. Run with `npm run test:package` (it needs npm_execpath).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { list } from 'tar';

import { writeFiles } from '../test/helpers.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath ?? '';
if (!npmCli) throw new Error('npm_execpath is not set; run this with `npm run test:package`.');
const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');

/**
 * Runs npm through the current Node binary, so no shell is needed on Windows.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} Standard output.
 */
function npm(cwd, ...args) {
    return execFileSync(process.execPath, [npmCli, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

const work = await mkdtemp(path.join(tmpdir(), 'joplin-plugin-scripts-smoke-'));
try {
    console.info('Packing...');
    const packDir = path.join(work, 'pack');
    await mkdir(packDir);
    npm(repoRoot, 'pack', '--pack-destination', packDir);
    const tarballs = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `Expected one tarball, found: ${tarballs.join(', ')}`);
    const tarball = path.join(packDir, tarballs[0]);

    /** @type {string[]} */
    const entries = [];
    await list({ file: tarball, onReadEntry: (entry) => entries.push(entry.path) });
    for (const required of [
        'package/package.json',
        'package/bin/joplin-plugin-scripts.mjs',
        'package/lib/index.mjs',
        'package/types/index.d.mts',
    ]) {
        assert.ok(entries.includes(required), `Tarball is missing ${required}`);
    }
    const unexpected = entries.filter((entry) => /^package\/(test|scripts|node_modules)\//.test(entry));
    assert.deepEqual(unexpected, [], 'Tarball contains files that should not ship');

    console.info('Installing into a plugin project...');
    const project = path.join(work, 'plugin');
    await writeFiles(project, {
        'package.json': JSON.stringify({
            name: 'joplin-plugin-smoke',
            version: '1.0.0',
            private: true,
            type: 'module',
            keywords: ['joplin-plugin'],
        }),
        'src/manifest.json': JSON.stringify({
            manifest_version: 1,
            id: 'smoke.test.plugin',
            app_min_version: '3.0',
            version: '1.0.0',
            name: 'Smoke Test',
            description: 'Packed-package smoke test',
            author: 'test',
            categories: ['productivity'],
        }),
        'src/index.ts':
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => {} });\n',
        'check-import.mjs':
            "import * as api from '@bwat47/joplin-plugin-scripts';\n" +
            "for (const name of ['createBuildOptions', 'createContentScriptBuildOptions', " +
            "'createWebviewScriptBuildOptions', 'readPluginConfig', 'PluginScriptsError']) {\n" +
            "    if (typeof api[name] !== 'function') throw new Error(`Missing export: ${name}`);\n" +
            '}\n' +
            "if (!Array.isArray(api.contentScriptExternals)) throw new Error('Missing export: contentScriptExternals');\n",
        'check-types.mts':
            "import { createBuildOptions, PluginScriptsError } from '@bwat47/joplin-plugin-scripts';\n" +
            "import type { BuildOptions } from 'esbuild';\n" +
            "const options: BuildOptions = createBuildOptions('.');\n" +
            "const error: Error = new PluginScriptsError('message');\n" +
            '// @ts-expect-error The root must be a string, so the declarations are not `any`.\n' +
            'createBuildOptions(1);\n' +
            'export { options, error };\n',
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                module: 'NodeNext',
                target: 'ES2022',
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                types: [],
            },
            files: ['check-types.mts'],
        }),
    });
    npm(project, 'install', '--save-dev', '--no-audit', '--no-fund', tarball);

    console.info('Running the CLI through its bin shim...');
    const help = npm(project, 'exec', '--no', '--', 'joplin-plugin-scripts', '--help');
    assert.match(help, /Usage: joplin-plugin-scripts/);
    npm(project, 'exec', '--no', '--', 'joplin-plugin-scripts', 'build');
    assert.ok(existsSync(path.join(project, 'publish/smoke.test.plugin.jpl')), 'Build did not create the .jpl');

    console.info('Importing the public API...');
    execFileSync(process.execPath, ['check-import.mjs'], { cwd: project, stdio: 'inherit' });

    console.info('Type-checking against the shipped declarations...');
    execFileSync(process.execPath, [tsc, '--project', 'tsconfig.json'], { cwd: project, stdio: 'inherit' });

    console.info('Packed-package smoke test passed.');
} finally {
    await rm(work, { recursive: true, force: true });
}
