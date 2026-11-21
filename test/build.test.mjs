import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { hasErrorCode } from '../lib/errors.mjs';
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
            "import { delimiter } from 'path';\n" +
            "import { DatabaseSync } from 'node:sqlite';\n" +
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => [sep, delimiter, DatabaseSync] });\n',
        'src/contentScripts/editor.ts':
            "import { EditorView } from '@codemirror/view';\n" +
            'export default () => ({ plugin: () => EditorView });\n',
        'src/styles.css': 'body {}',
        'src/index.test.ts': 'test',
        'src/fixtures/example.md': '# fixture',
        'dist/stale.js': 'removed by the build',
    });
    // esbuild logs to stderr, so stdout holds only the confirmation.
    assert.equal(runCli(directory, 'build'), `Created ${path.join('publish', 'test.plugin.jpl')} (v1.2.3).\n`);

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
    // Preserve both prefixed and bare built-ins, including modules that require the prefix.
    assert.deepEqual(requires, ['node:path', 'path', 'node:sqlite']);

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

test('ships only the bundle for a JSX webview script, not its source', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({ webviewScripts: ['dialog/dialog.jsx'] }),
        'src/index.ts': 'export {};\n',
        'src/dialog/dialog.jsx': '/** @jsx h */\nconst h = (tag) => tag;\nwindow.element = <div />;\n',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['dialog/dialog.js', 'index.js', 'manifest.json']);
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

test("applies shared build options to every bundle, below each bundle type's own options", async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
            webviewScripts: ['dialog/dialog.ts'],
            buildOptions: { target: 'es2015' },
            contentScriptBuildOptions: { target: 'es2020' },
        }),
        'src/index.ts': 'export const value = (a?: { b: number }) => a?.b;\n',
        'src/contentScripts/editor.ts': 'export default (a?: { b: number }) => a?.b;\n',
        'src/dialog/dialog.ts':
            'declare const window: { value?: number };\n' +
            'const read = (a?: { b: number }) => a?.b;\n' +
            'window.value = read({ b: 1 });\n',
    });
    runCli(directory, 'build');

    // es2015 lowers optional chaining; es2020 keeps it.
    assert.doesNotMatch(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), /\?\./);
    assert.doesNotMatch(await readFile(path.join(directory, 'dist/dialog/dialog.js'), 'utf8'), /\?\./);
    assert.match(await readFile(path.join(directory, 'dist/contentScripts/editor.js'), 'utf8'), /\?\./);
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

test('passes an update-version argument through and rejects extra arguments', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'package-lock.json': JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }),
    });
    assert.match(runCli(directory, 'update-version', 'minor'), /Updated version to 1\.3\.0\./);
    assert.throws(() => runCli(directory, 'update-version', 'minor', 'extra'), /Usage: joplin-plugin-scripts/);
    assert.throws(() => runCli(directory, 'build', 'extra'), /Usage: joplin-plugin-scripts/);
});

test('bundles standalone third-party package licenses into THIRD-PARTY-LICENSES.txt', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        LICENSE: 'Plugin root license (excluded)',
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
        }),
        'src/index.ts':
            "import { mainHelper } from 'main-lib';\n" +
            "import { bare } from 'no-license-lib';\n" +
            'export const result = [mainHelper(), bare()];\n',
        'src/contentScripts/editor.ts':
            "import { EditorView } from '@codemirror/view';\n" +
            "import { renderWidget } from 'widget-lib';\n" +
            'export default () => ({ view: EditorView, widget: renderWidget() });\n',
        'node_modules/main-lib/package.json': JSON.stringify({ name: 'main-lib', version: '1.2.0', license: 'MIT' }),
        'node_modules/main-lib/LICENSE': 'MIT License for main-lib\n',
        'node_modules/main-lib/index.js': 'export const mainHelper = () => "main";\n',
        'node_modules/widget-lib/package.json': JSON.stringify({
            name: 'widget-lib',
            version: '0.5.0',
            license: 'BSD-3-Clause',
        }),
        'node_modules/widget-lib/LICENSE.md': 'BSD License for widget-lib\n',
        'node_modules/widget-lib/index.js': 'export const renderWidget = () => "widget";\n',
        'node_modules/no-license-lib/package.json': JSON.stringify({
            name: 'no-license-lib',
            version: '1.0.0',
            license: 'MIT',
        }),
        'node_modules/no-license-lib/index.js': 'export const bare = () => "bare";\n',
        'node_modules/@codemirror/view/package.json': JSON.stringify({
            name: '@codemirror/view',
            version: '6.0.0',
            license: 'MIT',
        }),
        'node_modules/@codemirror/view/LICENSE': 'External CodeMirror license (excluded)\n',
        'node_modules/@codemirror/view/index.js': 'export class EditorView {}\n',
        'node_modules/unused-lib/package.json': JSON.stringify({
            name: 'unused-lib',
            version: '1.0.0',
            license: 'MIT',
        }),
        'node_modules/unused-lib/LICENSE': 'Unused license (excluded)\n',
        'node_modules/unused-lib/index.js': 'export const unused = true;\n',
    });

    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['THIRD-PARTY-LICENSES.txt', 'contentScripts/editor.js', 'index.js', 'manifest.json']);

    const licenses = await readFile(path.join(directory, 'dist/THIRD-PARTY-LICENSES.txt'), 'utf8');
    assert.match(licenses, /main-lib@1\.2\.0 \(MIT\)[\s\S]*MIT License for main-lib/);
    assert.match(licenses, /widget-lib@0\.5\.0 \(BSD-3-Clause\)[\s\S]*BSD License for widget-lib/);
    assert.doesNotMatch(licenses, /Plugin root license/);
    assert.doesNotMatch(licenses, /no-license-lib/);
    assert.doesNotMatch(licenses, /External CodeMirror license/);
    assert.doesNotMatch(licenses, /Unused license/);
});

test('rejects a src asset named like the generated license file before clearing existing output', async (t) => {
    const { directory } = await projectFixture(t);
    for (const name of ['THIRD-PARTY-LICENSES.txt', 'third-party-licenses.TXT']) {
        await writeFiles(directory, {
            [`src/${name}`]: 'Hand-written licenses\n',
            'publish/previous.jpl': 'previous archive',
        });
        assert.throws(() => runCli(directory, 'build'), /conflicts with the generated dist\/THIRD-PARTY-LICENSES\.txt/);
        assert.equal(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), '/* bundled plugin */');
        assert.equal(await readFile(path.join(directory, 'publish/previous.jpl'), 'utf8'), 'previous archive');
        await rm(path.join(directory, 'src', name));
    }
});

test('copies only runtime asset files, following directory symlinks and skipping dot-entries', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'src/index.ts':
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => undefined });\n',
        'src/commands/command.ts': 'export {};',
        'src/.DS_Store': 'finder metadata',
        'src/.cache/asset.css': 'cached',
        'src/images/icon.svg': '<svg/>',
        'shared/theme.css': 'shared theme',
        'shared/fonts/font.woff2': 'font',
    });
    const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(path.join(directory, 'shared'), path.join(directory, 'src/shared'), dirLink);
    // A link to an ancestor must not recurse forever.
    await symlink(path.join(directory, 'src'), path.join(directory, 'src/images/loop'), dirLink);
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    const expected = ['images/icon.svg', 'index.js', 'manifest.json', 'shared/fonts/font.woff2', 'shared/theme.css'];
    assert.deepEqual(
        entries.filter((entry) => !entry.startsWith('images/loop/')),
        expected
    );

    // dist/ matches the archive: no empty directories, dotfiles, or symlinks.
    const distEntries = await readdir(path.join(directory, 'dist'), { recursive: true });
    assert.equal(distEntries.includes('commands'), false);
    assert.equal(distEntries.includes('.DS_Store'), false);
    assert.equal(distEntries.includes('.cache'), false);
    for (const entry of distEntries) {
        assert.equal((await lstat(path.join(directory, 'dist', entry))).isSymbolicLink(), false, entry);
    }
    assert.equal(await readFile(path.join(directory, 'dist/shared/theme.css'), 'utf8'), 'shared theme');
});

test('follows file symlinks and skips broken file symlinks when copying runtime assets', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'src/index.ts':
            'declare const joplin: { plugins: { register(p: object): void } };\n' +
            'joplin.plugins.register({ onStart: async () => undefined });\n',
        'src/images/icon.svg': '<svg/>',
        'shared/theme.css': 'shared theme',
    });
    try {
        await symlink(path.join(directory, 'shared/theme.css'), path.join(directory, 'src/images/theme.css'), 'file');
    } catch (error) {
        // Windows needs Developer Mode or elevation for file symlinks.
        if (hasErrorCode(error, 'EPERM')) return t.skip('file symlinks unavailable');
        throw error;
    }
    await symlink(path.join(directory, 'missing.css'), path.join(directory, 'src/broken.css'), 'file');
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['images/icon.svg', 'images/theme.css', 'index.js', 'manifest.json']);
    assert.equal((await lstat(path.join(directory, 'dist/images/theme.css'))).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(directory, 'dist/images/theme.css'), 'utf8'), 'shared theme');
});

test('copies runtime assets while excluding TypeScript, JSX, tests, benchmarks, and fixtures', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'src/index.ts': 'export {};\n',
        'src/diffPreview/styles.css': 'body {}',
        'src/worker.js': 'self.onmessage = () => {};',
        'src/view.tsx': 'export const view = null;',
        'src/dialog.jsx': 'export const dialog = null;',
        'src/worker.mts': 'export {};',
        'src/config.cts': 'export {};',
        'src/types.d.ts': 'export type X = string;',
        'src/render.test.js': 'test',
        'src/render.spec.mjs': 'test',
        'src/helper.test.cjs': 'test',
        'src/render.bench.js': 'bench',
        'src/render.bench.mjs': 'bench',
        'src/helper.bench.cjs': 'bench',
        'src/__tests__/example.json': '{}',
        'src/__benchmarks__/sample.md': '# bench',
        'src/__mocks__/joplin.js': 'module.exports = {};',
        'src/__fixtures__/sample.json': '{}',
        'src/__snapshots__/render.test.ts.snap': 'exports = {};',
        'src/formatter/fixtures/example/input.md': '# fixture',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['diffPreview/styles.css', 'index.js', 'manifest.json', 'worker.js']);
});

test('excludes configured src-relative asset paths without affecting other locations', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            excludeAssets: ['testing', 'contentScript/testing', 'devHelper.js', 'notes[1]'],
        }),
        'src/index.ts': 'export {};\n',
        'src/testing/helper.js': 'module.exports = {};',
        'src/testing/nested/data.json': '{}',
        'src/contentScript/testing/mock.json': '{}',
        'src/contentScript/styles.css': 'body {}',
        'src/other/testing/keep.json': '{}',
        'src/devHelper.js': 'console.log("dev");',
        'src/notes[1]/scratch.txt': 'ignored',
        'src/notes1/keep.txt': 'kept',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, [
        'contentScript/styles.css',
        'index.js',
        'manifest.json',
        'notes1/keep.txt',
        'other/testing/keep.json',
    ]);
});
