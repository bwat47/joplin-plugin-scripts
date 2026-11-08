import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { archiveEntries, projectFixture, writeFiles } from './helpers.mjs';

const cli = fileURLToPath(new URL('../bin/joplin-plugin-scripts.mjs', import.meta.url));

/**
 * Runs the CLI in a fixture project.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
function runCli(cwd, ...args) {
    return execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

test('builds and packages a plugin with an extra script, runtime assets, and main build overrides', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
            mainBuildOptions: { external: ['optional-dependency'] },
        }),
        'src/index.ts':
            "import { sep } from 'node:path';\n" +
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => sep });\n',
        'src/contentScripts/editor.ts':
            "import { EditorView } from '@codemirror/view';\n" +
            'export default () => ({ plugin: () => EditorView });\n',
        'src/styles.css': 'body {}',
        'src/index.test.ts': 'test',
        'src/fixtures/example.md': '# fixture',
        'dist/stale.js': 'removed by the build',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['contentScripts/editor.js', 'index.js', 'manifest.json', 'styles.css']);

    /** @type {string[]} */
    const requires = [];
    let registered = false;
    // eslint-disable-next-line sonarjs/code-eval -- Executes only the bundle this test just built, with a controlled host stub.
    runInNewContext(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), {
        joplin: {
            plugins: {
                register: (/** @type {{ onStart?: unknown }} */ plugin) =>
                    (registered = typeof plugin.onStart === 'function'),
            },
        },
        require: (/** @type {string} */ name) => requires.push(name) && { sep: '/' },
    });
    assert.equal(registered, true);
    // Node built-ins keep the bare names Joplin's plugin runtime expects.
    assert.deepEqual(requires, ['path']);

    const contentScript = await readFile(path.join(directory, 'dist/contentScripts/editor.js'), 'utf8');
    assert.match(contentScript, /require\("@codemirror\/view"\)/);
});

test('builds webview scripts that run as plain scripts without module, exports, or require', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({ webviewScripts: ['dialog/dialog.ts'] }),
        'src/index.ts':
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => undefined });\n',
        'src/dialog/dialog.ts':
            "import { label } from './label';\n" +
            'declare const window: { initialized: string };\n' +
            'export function initialize(): void { window.initialized = label; }\n' +
            'initialize();\n' +
            'export default initialize;\n',
        'src/dialog/label.ts': "export const label = 'ready';\n",
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['dialog/dialog.js', 'index.js', 'manifest.json']);
    // A dialog's <script> context: globals only, no CommonJS bindings.
    /** @type {{ initialized?: string }} */
    const window = {};
    // eslint-disable-next-line sonarjs/code-eval -- Executes only the bundle this test just built, with a controlled host stub.
    runInNewContext(await readFile(path.join(directory, 'dist/dialog/dialog.js'), 'utf8'), { window });
    assert.equal(window.initialized, 'ready');
});

test('applies content-script and webview-script build options only to their own scripts', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
            webviewScripts: ['dialog/dialog.ts'],
            contentScriptBuildOptions: { sourcemap: 'inline' },
            webviewScriptBuildOptions: { define: { __LABEL__: '"from-config"' } },
        }),
        'src/index.ts': 'export {};\n',
        'src/contentScripts/editor.ts':
            'declare const __LABEL__: string;\n' +
            "export default () => (typeof __LABEL__ === 'undefined' ? 'none' : __LABEL__);\n",
        'src/dialog/dialog.ts':
            'declare const __LABEL__: string;\n' +
            'declare const window: { label: string };\n' +
            'window.label = __LABEL__;\n',
    });
    runCli(directory, 'build');

    const contentScript = await readFile(path.join(directory, 'dist/contentScripts/editor.js'), 'utf8');
    const webviewScript = await readFile(path.join(directory, 'dist/dialog/dialog.js'), 'utf8');
    assert.match(contentScript, /sourceMappingURL=data:/);
    assert.doesNotMatch(contentScript, /from-config/);
    assert.doesNotMatch(webviewScript, /sourceMappingURL/);
    /** @type {{ label?: string }} */
    const window = {};
    // eslint-disable-next-line sonarjs/code-eval -- Executes only the bundle this test just built, with a controlled host stub.
    runInNewContext(webviewScript, { window });
    assert.equal(window.label, 'from-config');
});

test('rejects an unbundled webview script before building it with runtime requires', async (t) => {
    const { directory } = await projectFixture(t);
    // Unbundled, esbuild would build this as an IIFE calling require('./label'), which a webview lacks.
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            webviewScripts: ['dialog/dialog.ts'],
            webviewScriptBuildOptions: { bundle: false },
        }),
        'src/index.ts': 'export {};\n',
        'src/dialog/dialog.ts': "import { label } from './label';\nconsole.log(label);\n",
        'src/dialog/label.ts': "export const label = 'ready';\n",
    });
    assert.throws(() => runCli(directory, 'build'), /"webviewScriptBuildOptions" cannot set bundle/);
    assert.equal(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), '/* bundled plugin */');
});

test('fails the build before clearing output when the project is invalid', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, { 'plugin.config.json': '{ "extraScripts": "editor.ts" }' });
    assert.throws(() => runCli(directory, 'build'), /"extraScripts" must be an array/);
    assert.equal(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), '/* bundled plugin */');
});

test('rejects colliding script outputs before clearing existing bundles', async (t) => {
    const { directory } = await projectFixture(t);
    const reserved = /reserved for the main bundle/;
    const duplicate = /more than one script/;
    const cases = [
        [{ extraScripts: ['index.ts'] }, reserved],
        [{ webviewScripts: ['./index.jsx'] }, reserved],
        [{ extraScripts: ['INDEX.ts'] }, reserved],
        [{ extraScripts: ['editor.ts', './editor.js'] }, duplicate],
        [{ extraScripts: ['scripts/editor.ts'], webviewScripts: ['./scripts//editor.jsx'] }, duplicate],
        [{ extraScripts: ['scripts/editor.ts'], webviewScripts: ['scripts\\EDITOR.js'] }, duplicate],
        // A malformed path is reported as invalid, not as the collision it normalizes to.
        [{ extraScripts: ['a/../index.ts'] }, /Invalid extra script path/],
    ];
    for (const [config, expected] of cases) {
        await writeFiles(directory, {
            'plugin.config.json': JSON.stringify(config),
            'publish/previous.jpl': 'previous archive',
        });
        assert.throws(() => runCli(directory, 'build'), expected, JSON.stringify(config));
        assert.equal(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), '/* bundled plugin */');
        assert.equal(await readFile(path.join(directory, 'publish/previous.jpl'), 'utf8'), 'previous archive');
    }
});

test('prints usage for unknown commands', async (t) => {
    const { directory } = await projectFixture(t);
    assert.throws(() => runCli(directory, 'deploy'), /Usage: joplin-plugin-scripts <command>/);
    assert.match(runCli(directory, '--help'), /Commands:\n {2}build/);
});

/** Matches a stack frame line, e.g. `    at readProject (file:///lib/packagePlugin.mjs:1:1)`. */
const STACK_FRAME_PATTERN = /^ {4}at /m;

test('reports expected failures with a message and no stack trace', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    const outside = await mkdtemp(path.join(tmpdir(), 'joplin-plugin-scripts-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const cases = [
        [directory, { 'plugin.config.json': '{ "extraScripts": "editor.ts" }' }, /Error: .*"extraScripts" must be/],
        [directory, { 'src/manifest.json': '{ not json' }, /Error: .*manifest\.json is not valid JSON/],
        [
            directory,
            { 'src/index.ts': 'const = 1;' },
            /ERROR[\s\S]*Error: Bundling failed; see the esbuild errors above/,
        ],
        [outside, {}, /Error: .*package\.json not found; run this command from the plugin project root/],
    ];
    for (const [cwd, files, expected] of /** @type {[string, Record<string, string>, RegExp][]} */ (cases)) {
        // Each case starts from a valid project, so only its own file is broken.
        await writeFiles(directory, {
            'plugin.config.json': '{}',
            'src/index.ts': '',
            'src/manifest.json': JSON.stringify(manifest),
            ...files,
        });
        const { status, stderr } = spawnSync(process.execPath, [cli, 'build'], { cwd, encoding: 'utf8' });
        assert.equal(status, 1, stderr);
        assert.match(stderr, expected);
        assert.doesNotMatch(stderr, STACK_FRAME_PATTERN, stderr);
    }
});
