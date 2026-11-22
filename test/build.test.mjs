import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { hasErrorCode } from '../lib/errors.mjs';
import { archiveEntries, projectFixture, writeFiles } from './helpers.mjs';

/** @import { TestContext } from 'node:test' */

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

test('bundles .mts, .cts, .mjs, and .cjs entry points to .js without copying their sources', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.mts', 'contentScripts/viewer.cts'],
            webviewScripts: ['./dialog/panel.mjs', 'dialog/legacy.cjs'],
        }),
        'src/index.ts': 'export {};\n',
        'src/contentScripts/editor.mts': 'export default () => ({ plugin: () => "mts" });\n',
        'src/contentScripts/viewer.cts': 'export default () => ({ plugin: () => "cts" });\n',
        'src/dialog/panel.mjs': 'window.panel = "mjs";\n',
        'src/dialog/legacy.cjs': 'window.legacy = "cjs";\n',
        'src/dialog/standalone.mjs': 'export const keep = true;\n',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, [
        'contentScripts/editor.js',
        'contentScripts/viewer.js',
        'dialog/legacy.js',
        'dialog/panel.js',
        'dialog/standalone.mjs',
        'index.js',
        'manifest.json',
    ]);
});

test('treats backslashes in script paths as separators on every platform', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({ webviewScripts: ['dialog\\panel.mjs'] }),
        'src/index.ts': 'export {};\n',
        'src/dialog/panel.mjs': 'window.panel = true;\n',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['dialog/panel.js', 'index.js', 'manifest.json']);
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
        [{ extraScripts: ['a/../index.ts'] }, /Invalid script path/],
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

test('prints the package version for --version and -v', async (t) => {
    const { directory } = await projectFixture(t);
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(runCli(directory, '--version'), `${version}\n`);
    assert.equal(runCli(directory, '-v'), `${version}\n`);
    assert.throws(() => runCli(directory, '--version', 'extra'), /Usage: joplin-plugin-scripts <command>/);
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

test('prints bundle-size analysis for all bundles when --analyze is passed', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
            webviewScripts: ['dialog/dialog.ts'],
        }),
        'src/index.ts': "import { helper } from './helper';\nexport const value = helper();\n",
        'src/helper.ts': "export const helper = () => 'hello';\n",
        'src/contentScripts/editor.ts': 'export default () => ({ plugin: () => "editor" });\n',
        'src/dialog/dialog.ts': 'declare const window: { ready: boolean };\nwindow.ready = true;\n',
    });

    const output = runCli(directory, 'build', '--analyze');
    assert.match(output, /dist\/index\.js/);
    assert.match(output, /src\/helper\.ts/);
    assert.match(output, /dist\/contentScripts\/editor\.js/);
    assert.match(output, /dist\/dialog\/dialog\.js/);
    assert.match(
        output,
        new RegExp(`Created ${path.join('publish', 'test.plugin.jpl').replace(/\\/g, '\\\\')} \\(v1\\.2\\.3\\)\\.\n$`)
    );
    // Non-TTY stdout must not contain ANSI escape sequences.
    assert.equal(output.includes('\u001b['), false);

    assert.throws(() => runCli(directory, 'build', '--unknown'), /Usage: joplin-plugin-scripts/);
    assert.throws(() => runCli(directory, 'build', '--analyze', 'extra'), /Usage: joplin-plugin-scripts/);
});

test('supports --dev to disable minification, inline sourcemaps, and default NODE_ENV to development', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            extraScripts: ['contentScripts/editor.ts'],
            webviewScripts: ['dialog/dialog.ts'],
            buildOptions: { minify: true, sourcemap: false, define: { __CUSTOM__: '"kept"' } },
            contentScriptBuildOptions: { define: { 'process.env.NODE_ENV': '"custom-env"' } },
        }),
        'src/index.ts':
            'declare const __CUSTOM__: string;\n' +
            'function readableMainHelper(longParameterName: string) { return `${longParameterName}:${process.env.NODE_ENV}:${__CUSTOM__}`; }\n' +
            'export const result = readableMainHelper("main");\n',
        'src/contentScripts/editor.ts':
            'function readableContentHelper(longParameterName: string) { return `${longParameterName}:${process.env.NODE_ENV}`; }\n' +
            'export default () => readableContentHelper("content");\n',
        'src/dialog/dialog.ts':
            'declare const window: { env?: string };\n' +
            'function readableDialogHelper(longParameterName: string) { return `${longParameterName}:${process.env.NODE_ENV}`; }\n' +
            'window.env = readableDialogHelper("dialog");\n',
    });

    const output = runCli(directory, 'build', '--dev', '--analyze');
    assert.match(output, /dist\/index\.js/);
    assert.match(
        output,
        new RegExp(
            `Created ${path.join('publish', 'test.plugin.jpl').replace(/\\/g, '\\\\')} \\(v1\\.2\\.3, dev\\)\\.\n$`
        )
    );

    // Inline sourcemaps must not add .js.map files to the archive.
    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['contentScripts/editor.js', 'dialog/dialog.js', 'index.js', 'manifest.json']);

    const mainBundle = await readFile(path.join(directory, 'dist/index.js'), 'utf8');
    const contentBundle = await readFile(path.join(directory, 'dist/contentScripts/editor.js'), 'utf8');
    const webviewBundle = await readFile(path.join(directory, 'dist/dialog/dialog.js'), 'utf8');

    for (const [bundle, helperName] of [
        [mainBundle, 'readableMainHelper'],
        [contentBundle, 'readableContentHelper'],
        [webviewBundle, 'readableDialogHelper'],
    ]) {
        assert.match(bundle, /sourceMappingURL=data:/);
        assert.match(bundle, new RegExp(`function ${helperName}\\(longParameterName\\)`));
    }

    assert.match(mainBundle, /"development"/);
    assert.match(mainBundle, /"kept"/);
    assert.match(webviewBundle, /"development"/);
    // Explicit NODE_ENV in plugin.config.json takes precedence over --dev's default.
    assert.match(contentBundle, /"custom-env"/);
    assert.doesNotMatch(contentBundle, /"development"/);
});

test('supports composable --sourcemap and --no-minify flags without changing NODE_ENV', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            mainBuildOptions: {
                minify: true,
                minifyIdentifiers: true,
                minifySyntax: true,
                minifyWhitespace: true,
                sourcemap: false,
            },
        }),
        'src/index.ts':
            'function readableHelper(longParameterName: string) { return [longParameterName, process.env.NODE_ENV, true]; }\n' +
            'export const result = readableHelper("ok");\n',
    });

    const sourcemapOutput = runCli(directory, 'build', '--sourcemap');
    assert.equal(sourcemapOutput, `Created ${path.join('publish', 'test.plugin.jpl')} (v1.2.3, sourcemap).\n`);
    const sourcemapBundle = await readFile(path.join(directory, 'dist/index.js'), 'utf8');
    assert.match(sourcemapBundle, /sourceMappingURL=data:/);
    assert.doesNotMatch(sourcemapBundle, /longParameterName/);
    assert.match(sourcemapBundle, /"production"/);

    const noMinifyOutput = runCli(directory, 'build', '--no-minify');
    assert.equal(noMinifyOutput, `Created ${path.join('publish', 'test.plugin.jpl')} (v1.2.3, no-minify).\n`);
    const noMinifyBundle = await readFile(path.join(directory, 'dist/index.js'), 'utf8');
    assert.doesNotMatch(noMinifyBundle, /sourceMappingURL/);
    // Granular minify* config flags must all be overridden: identifiers, whitespace, and syntax (`true`, not `!0`).
    assert.match(
        noMinifyBundle,
        /function readableHelper\(longParameterName\) \{\n\s+return \[longParameterName, "production", true\];/
    );

    const combinedOutput = runCli(directory, 'build', '--no-minify', '--sourcemap');
    assert.equal(
        combinedOutput,
        `Created ${path.join('publish', 'test.plugin.jpl')} (v1.2.3, sourcemap, no-minify).\n`
    );
    const combinedBundle = await readFile(path.join(directory, 'dist/index.js'), 'utf8');
    assert.match(combinedBundle, /sourceMappingURL=data:/);
    assert.match(
        combinedBundle,
        /function readableHelper\(longParameterName\) \{\n\s+return \[longParameterName, "production", true\];/
    );

    assert.throws(() => runCli(directory, 'build', '--minify'), /Usage: joplin-plugin-scripts/);
    assert.throws(() => runCli(directory, 'build', '--dev=true'), /Usage: joplin-plugin-scripts/);
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

/**
 * Asserts that `build` fails with `expected` and leaves the previous `dist/` and `publish/` output untouched.
 * @param {string} directory Fixture project, as created by `projectFixture`.
 * @param {RegExp} expected
 * @param {string} [message]
 */
async function assertBuildFailsKeepingOutput(directory, expected, message) {
    await writeFiles(directory, { 'publish/previous.jpl': 'previous archive' });
    assert.throws(() => runCli(directory, 'build'), expected, message);
    assert.equal(await readFile(path.join(directory, 'dist/index.js'), 'utf8'), '/* bundled plugin */', message);
    assert.equal(await readFile(path.join(directory, 'publish/previous.jpl'), 'utf8'), 'previous archive', message);
}

test('rejects a src asset named like the generated license file before clearing existing output', async (t) => {
    for (const name of ['THIRD-PARTY-LICENSES.txt', 'third-party-licenses.TXT']) {
        const { directory } = await projectFixture(t);
        await writeFiles(directory, { 'src/index.ts': 'export {};\n', [`src/${name}`]: 'Hand-written licenses\n' });
        await assertBuildFailsKeepingOutput(
            directory,
            /conflicts with the generated dist\/THIRD-PARTY-LICENSES\.txt.*; rename it or add it to excludeAssets in plugin\.config\.json\./,
            name
        );
    }
});

test('leaves existing output untouched when bundling fails', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, { 'src/index.ts': 'export const broken = ;\n' });
    await assertBuildFailsKeepingOutput(directory, /Bundling failed/);
});

test('rejects src assets that collide with generated files before clearing existing output', async (t) => {
    const editor = { 'src/contentScripts/editor.ts': 'export default () => ({ plugin: () => "editor" });\n' };
    const styled = { 'src/index.ts': "import './styles.css';\n", 'src/styles.css': 'a { color: red; }\n' };
    const cases = [
        [
            {},
            { 'src/Index.js': '' },
            /src\/Index\.js conflicts with the generated dist\/index\.js \(from src\/index\.ts\) \(names that differ only in letter case/,
        ],
        [
            { extraScripts: ['contentScripts/editor.ts'] },
            { ...editor, 'src/contentScripts/Editor.js': '' },
            /src\/contentScripts\/Editor\.js conflicts with the generated dist\/contentScripts\/editor\.js \(from src\/contentScripts\/editor\.ts\) \(names that differ only in letter case/,
        ],
        [
            { webviewScripts: ['dialog/panel.mjs'] },
            { 'src/dialog/panel.mjs': 'window.panel = true;\n', 'src/dialog/Panel.js': '' },
            /src\/dialog\/Panel\.js conflicts with the generated dist\/dialog\/panel\.js/,
        ],
        [
            {},
            { 'src/Third-Party-Licenses.txt/notes.md': '' },
            /the directory src\/Third-Party-Licenses\.txt\/ conflicts with the generated dist\/THIRD-PARTY-LICENSES\.txt \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
        [
            {},
            { 'src/index.js/readme.md': '' },
            /the directory src\/index\.js\/ conflicts with the generated dist\/index\.js \(from src\/index\.ts\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
        // Files esbuild generates besides the `.js` bundle are checked too.
        [
            {},
            { ...styled, 'src/index.css/notes.txt': '' },
            /the directory src\/index\.css\/ conflicts with the generated dist\/index\.css \(from src\/index\.ts\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
        [
            {},
            { ...styled, 'src/Index.css': '' },
            /src\/Index\.css conflicts with the generated dist\/index\.css \(from src\/index\.ts\) \(names that differ only in letter case/,
        ],
        [
            { mainBuildOptions: { loader: { '.png': 'file' }, assetNames: 'img/[name]' } },
            {
                'src/index.ts': "import logo from './logo.png';\nexport { logo };\n",
                'src/logo.png': 'image',
                'src/Img/other.png': 'other',
            },
            /the directory src\/Img\/ conflicts with the directory dist\/img\/ \(from src\/index\.ts\) \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
    ];
    for (const [config, files, expected] of /** @type {[object, Record<string, string>, RegExp][]} */ (cases)) {
        const { directory } = await projectFixture(t);
        await writeFiles(directory, {
            'plugin.config.json': JSON.stringify(config),
            'src/index.ts': 'export {};\n',
            ...files,
        });
        await assertBuildFailsKeepingOutput(directory, expected, Object.keys(files).join(', '));
    }
});

test('rejects generated files that collide across bundles, conflict with manifest.json, or leave dist/', async (t) => {
    const fileAssets = { loader: { '.png': 'file' }, assetNames: '[name]' };
    const twoLogos = (/** @type {string} */ first, /** @type {string} */ second) => ({
        'src/index.ts': `import logo from './a/${first}';\nexport { logo };\n`,
        'src/editor.ts': `import logo from './b/${second}';\nexport default () => ({ plugin: () => logo });\n`,
        [`src/a/${first}`]: 'first image',
        [`src/b/${second}`]: 'second image',
    });
    const cases = [
        [
            { buildOptions: fileAssets, extraScripts: ['editor.ts'] },
            twoLogos('logo.png', 'logo.png'),
            /The bundles for src\/index\.ts and src\/editor\.ts both generate dist\/logo\.png, with different contents/,
        ],
        [
            { buildOptions: fileAssets, extraScripts: ['editor.ts'] },
            twoLogos('Logo.png', 'logo.png'),
            /the generated dist\/logo\.png \(from src\/editor\.ts\) conflicts with the generated dist\/Logo\.png \(from src\/index\.ts\) \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); check the build options/,
        ],
        [
            {
                buildOptions: { loader: { '.png': 'file' } },
                mainBuildOptions: { assetNames: 'Img/[name]' },
                contentScriptBuildOptions: { assetNames: 'img/[name]' },
                extraScripts: ['editor.ts'],
            },
            twoLogos('a.png', 'b.png'),
            /the directory dist\/img\/ \(from src\/editor\.ts\) conflicts with the directory dist\/Img\/ \(from src\/index\.ts\) \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); check the build options/,
        ],
        [
            {
                buildOptions: { loader: { '.png': 'file' } },
                mainBuildOptions: { assetNames: 'caf\u00e9/[name]' },
                contentScriptBuildOptions: { assetNames: 'cafe\u0301/[name]' },
                extraScripts: ['editor.ts'],
            },
            twoLogos('a.png', 'b.png'),
            /the directory dist\/cafe\u0301\/ \(from src\/editor\.ts\) conflicts with the directory dist\/caf\u00e9\/ \(from src\/index\.ts\) \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); check the build options/,
        ],
        [
            { mainBuildOptions: { loader: { '.json': 'file' }, assetNames: '[name]' } },
            {
                'src/index.ts': "import other from './sub/manifest.json';\nexport { other };\n",
                'src/sub/manifest.json': '{"id":"other"}\n',
            },
            /the generated dist\/manifest\.json \(from src\/index\.ts\) conflicts with src\/manifest\.json; check the build options/,
        ],
        [
            { mainBuildOptions: { loader: { '.json': 'file' }, assetNames: '[name]' } },
            {
                'src/index.ts': "import other from './sub/Manifest.json';\nexport { other };\n",
                'src/sub/Manifest.json': '{"id":"other"}\n',
            },
            /the generated dist\/Manifest\.json \(from src\/index\.ts\) conflicts with src\/manifest\.json \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); check the build options/,
        ],
        [
            { mainBuildOptions: { loader: { '.png': 'file' }, assetNames: '../escaped/[name]' } },
            { 'src/index.ts': "import logo from './logo.png';\nexport { logo };\n", 'src/logo.png': 'image' },
            /The bundle for src\/index\.ts generates .*escaped.logo\.png, outside dist\//,
        ],
    ];
    for (const [config, files, expected] of /** @type {[object, Record<string, string>, RegExp][]} */ (cases)) {
        const { directory } = await projectFixture(t);
        await writeFiles(directory, { 'plugin.config.json': JSON.stringify(config), ...files });
        await assertBuildFailsKeepingOutput(directory, expected, JSON.stringify(config));
    }
});

test(
    'rejects src assets and generated files with names Windows cannot extract',
    { skip: process.platform === 'win32' && 'Windows cannot create these file names' },
    async (t) => {
        const excludable = 'rename it or add it to excludeAssets in plugin\\.config\\.json\\.';
        const cases = [
            [
                {},
                { 'src/img\\logo.png': 'image' },
                /src\/img\\logo\.png cannot be extracted on Windows because of the name "img\\\\logo\.png" \(.*\); rename it\./,
            ],
            [
                {},
                { 'src/img/a:b.png': 'image' },
                new RegExp(
                    `src/img/a:b\\.png cannot be extracted on Windows because of the name "a:b\\.png" .*; ${excludable}`
                ),
            ],
            [
                {},
                { 'src/notes /a.txt': '' },
                new RegExp(
                    `src/notes /a\\.txt cannot be extracted on Windows because of the name "notes " .*; ${excludable}`
                ),
            ],
            [
                {},
                { 'src/aux.json': '{}' },
                new RegExp(
                    `src/aux\\.json cannot be extracted on Windows because of the name "aux\\.json" .*; ${excludable}`
                ),
            ],
            [
                // esbuild turns backslashes in `[dir]` and in the template into `/`, but keeps them in `[name]`.
                { mainBuildOptions: { loader: { '.png': 'file' }, assetNames: '[name]' } },
                {
                    'src/index.ts': "import logo from './x\\\\y.png';\nexport { logo };\n",
                    'src/x\\y.png': 'image',
                },
                /The bundle for src\/index\.ts generates dist\/x\\y\.png, which cannot be extracted on Windows because of the name "x\\\\y\.png"/,
            ],
            [
                { mainBuildOptions: { loader: { '.png': 'file' }, assetNames: '[name]' } },
                { 'src/index.ts': "import logo from './x?y.png';\nexport { logo };\n", 'src/x?y.png': 'image' },
                /The bundle for src\/index\.ts generates dist\/x\?y\.png, which cannot be extracted on Windows because of the name "x\?y\.png"/,
            ],
        ];
        for (const [config, files, expected] of /** @type {[object, Record<string, string>, RegExp][]} */ (cases)) {
            const { directory } = await projectFixture(t);
            await writeFiles(directory, {
                'plugin.config.json': JSON.stringify(config),
                'src/index.ts': 'export {};\n',
                ...files,
            });
            await assertBuildFailsKeepingOutput(directory, expected, Object.keys(files).join(', '));
        }
    }
);

test(
    'skips excluded src assets with names Windows cannot extract',
    { skip: process.platform === 'win32' && 'Windows cannot create these file names' },
    async (t) => {
        const { directory } = await projectFixture(t);
        await writeFiles(directory, {
            'plugin.config.json': JSON.stringify({ excludeAssets: ['img/a:b.png', 'CON'] }),
            'src/index.ts': 'export {};\n',
            'src/img/a:b.png': 'image',
            'src/CON/notes.txt': '',
        });
        runCli(directory, 'build');

        const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
        assert.deepEqual(entries, ['index.js', 'manifest.json']);
    }
);

/**
 * Returns whether the temporary directory's file system keeps `name` and `variant` apart. If it
 * doesn't, marks `t` as skipped, since fixtures with both names cannot be created there.
 * @param {TestContext} t
 * @param {string} name
 * @param {string} variant A name that some file systems treat as `name`.
 * @param {string} reason Why the test is skipped otherwise.
 * @returns {Promise<boolean>}
 */
async function requireDistinctFileNames(t, name, variant, reason) {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, { [name]: '' });
    const same = await stat(path.join(directory, variant)).then(
        () => true,
        () => false
    );
    if (same) t.skip(reason);
    return !same;
}

/**
 * Like `requireDistinctFileNames`, for names that differ only in letter case.
 * @param {TestContext} t
 * @returns {Promise<boolean>}
 */
function requireCaseSensitiveFileSystem(t) {
    return requireDistinctFileNames(t, 'probe.txt', 'PROBE.txt', 'needs a case-sensitive file system');
}

test('rejects a src asset named like a generated directory without case', async (t) => {
    if (!(await requireCaseSensitiveFileSystem(t))) return;
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({ extraScripts: ['contentScripts/editor.ts'] }),
        'src/index.ts': 'export {};\n',
        'src/contentScripts/editor.ts': 'export default () => ({ plugin: () => "editor" });\n',
        'src/ContentScripts': '',
    });
    await assertBuildFailsKeepingOutput(
        directory,
        /src\/ContentScripts conflicts with the directory dist\/contentScripts\/ \(from src\/contentScripts\/editor\.ts\) \(names that differ only in letter case/
    );
});

test('rejects src assets that collide with each other without case', async (t) => {
    if (!(await requireCaseSensitiveFileSystem(t))) return;
    const cases = [
        [
            ['src/img/Logo.png', 'src/img/logo.png'],
            /src\/img\/logo\.png conflicts with src\/img\/Logo\.png \(names that differ only in letter case/,
        ],
        [
            ['src/Manifest.json'],
            /src\/Manifest\.json conflicts with src\/manifest\.json \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
        [
            ['src/assets', 'src/Assets/theme.css'],
            /src\/assets conflicts with the directory src\/Assets\/ \(names that differ only in letter case/,
        ],
        [
            ['src/Img/a.png', 'src/img/b.png'],
            /the directory src\/img\/ conflicts with the directory src\/Img\/ \(names that differ only in letter case or Unicode form can name one file on Windows or macOS\); rename it or add it to excludeAssets in plugin\.config\.json\./,
        ],
    ];
    for (const [assets, expected] of /** @type {[string[], RegExp][]} */ (cases)) {
        const { directory } = await projectFixture(t);
        await writeFiles(directory, {
            'src/index.ts': 'export {};\n',
            ...Object.fromEntries(assets.map((asset) => [asset, 'asset\n'])),
        });
        await assertBuildFailsKeepingOutput(directory, expected, assets.join(', '));
    }
});

test('rejects src assets whose names differ only in Unicode normalization', async (t) => {
    const nfc = 'café.png';
    const nfd = 'café.png';
    if (!(await requireDistinctFileNames(t, nfc, nfd, 'needs a normalization-sensitive file system'))) return;
    const { directory } = await projectFixture(t);
    await writeFiles(directory, { 'src/index.ts': 'export {};\n', [`src/${nfc}`]: 'one', [`src/${nfd}`]: 'two' });
    await assertBuildFailsKeepingOutput(
        directory,
        new RegExp(
            `src/${nfc} conflicts with src/${nfd} \\(names that differ only in letter case or Unicode form can name one file on Windows or macOS\\)`
        )
    );
});

test('writes generated files, replacing src assets at the same paths and sharing identical files', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            buildOptions: { loader: { '.png': 'file' }, assetNames: '[name]' },
            mainBuildOptions: { sourcemap: 'external' },
            extraScripts: ['editor.ts'],
            webviewScripts: ['webview/panel.ts'],
            excludeAssets: ['Index.js'],
        }),
        'src/index.ts': "import './styles.css';\nimport logo from './img/logo.png';\nexport { logo };\n",
        'src/styles.css': 'a { color: red; }\n',
        'src/index.css': 'stale\n',
        'src/index.js.map': 'stale\n',
        'src/webview/panel.ts': "import './panel.css';\n",
        'src/webview/panel.css': 'b { color: blue; }\n',
        'src/img/logo.png': 'image',
        'src/Index.js': 'stray\n',
        'src/editor.ts': "import logo from './img/logo.png';\nexport default () => ({ plugin: () => logo });\n",
        'src/editor.js': 'stray\n',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, [
        'editor.js',
        'img/logo.png',
        'index.css',
        'index.css.map',
        'index.js',
        'index.js.map',
        'logo.png',
        'manifest.json',
        'styles.css',
        'webview/panel.css',
        'webview/panel.js',
    ]);
    assert.match(await readFile(path.join(directory, 'dist/editor.js'), 'utf8'), /logo\.png/);
    assert.match(await readFile(path.join(directory, 'dist/index.css'), 'utf8'), /color/);
    assert.match(await readFile(path.join(directory, 'dist/index.js.map'), 'utf8'), /"mappings"/);
    // A bundle replaces the CSS it imports at its own output path, rather than failing the build.
    const panelCss = await readFile(path.join(directory, 'dist/webview/panel.css'), 'utf8');
    assert.match(panelCss, /^b\s*\{/);
    assert.notEqual(panelCss, 'b { color: blue; }\n');
    assert.equal(await readFile(path.join(directory, 'dist/logo.png'), 'utf8'), 'image');
});

test('writes a src asset once when a bundle generates an identical file at its path', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFiles(directory, {
        'plugin.config.json': JSON.stringify({
            buildOptions: { loader: { '.png': 'file' }, assetNames: '[dir]/[name]' },
        }),
        'src/index.ts': "import logo from './img/logo.png';\nexport { logo };\n",
        'src/img/logo.png': 'image',
    });
    runCli(directory, 'build');

    const entries = await archiveEntries(path.join(directory, 'publish/test.plugin.jpl'));
    assert.deepEqual(entries, ['img/logo.png', 'index.js', 'manifest.json']);
    assert.equal(await readFile(path.join(directory, 'dist/img/logo.png'), 'utf8'), 'image');
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
