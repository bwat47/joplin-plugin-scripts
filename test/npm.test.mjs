import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PluginScriptsError } from '../lib/errors.mjs';
import { resolveNpmCommand } from '../lib/npm.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'joplin-npm-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, '');
    return { root, npmCli };
}

test('uses an existing npm-cli.js from npm scripts on either platform', async (t) => {
    const { npmCli } = await fixture(t);
    for (const platform of ['win32', 'linux']) {
        assert.deepEqual(resolveNpmCommand({ platform, npmExecPath: npmCli, searchPath: '' }), {
            file: process.execPath,
            args: [npmCli],
        });
    }
});

test('finds npm on Windows PATH independently of Yarn, pnpm, or missing npm_execpath', async (t) => {
    const { root, npmCli } = await fixture(t);
    for (const launcher of ['yarn.js', 'pnpm.cjs', 'pnpm.exe', 'missing/npm-cli.js', '']) {
        const npmExecPath = launcher ? path.join(root, launcher) : '';
        if (launcher && !launcher.includes('/')) await writeFile(npmExecPath, '');
        assert.deepEqual(resolveNpmCommand({ platform: 'win32', npmExecPath, searchPath: root }), {
            file: process.execPath,
            args: [npmCli],
        });
    }
});

test('supports Windows npm.exe shims and npm installed beside Node', async (t) => {
    const { root, npmCli } = await fixture(t);
    const nodePath = path.join(root, 'node.exe');
    assert.deepEqual(resolveNpmCommand({ platform: 'win32', npmExecPath: '', searchPath: '', nodePath }), {
        file: nodePath,
        args: [npmCli],
    });
    const npmExe = path.join(root, 'npm.exe');
    await writeFile(npmExe, '');
    assert.deepEqual(resolveNpmCommand({ platform: 'win32', npmExecPath: '', searchPath: root }), {
        file: npmExe,
        args: [],
    });
});

test('reports missing npm directly on Windows', () => {
    assert.throws(
        () =>
            resolveNpmCommand({
                platform: 'win32',
                npmExecPath: '',
                searchPath: '',
                nodePath: path.resolve('missing/node.exe'),
            }),
        (error) => error instanceof PluginScriptsError && /Could not find npm.*PATH/.test(error.message)
    );
});

test('uses npm from PATH on Unix regardless of another package manager launcher', () => {
    for (const npmExecPath of ['yarn.js', 'pnpm.cjs', '']) {
        assert.deepEqual(resolveNpmCommand({ platform: 'linux', npmExecPath }), { file: 'npm', args: [] });
    }
});

test('runs the resolved CLI with literal arguments and the requested working directory', async (t) => {
    const { root, npmCli } = await fixture(t);
    await writeFile(
        npmCli,
        "require('node:fs').writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));"
    );
    const args = ['pack', 'package with spaces', '--pack-destination', 'literal & destination'];
    const moduleUrl = new URL('../lib/npm.mjs', import.meta.url).href;
    execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import { runNpm } from ${JSON.stringify(moduleUrl)}; runNpm(process.argv.slice(1), process.cwd());`,
            ...args,
        ],
        {
            cwd: root,
            env: { ...process.env, npm_execpath: npmCli },
        }
    );
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'invocation.json'), 'utf8')), { args, cwd: root });
});
