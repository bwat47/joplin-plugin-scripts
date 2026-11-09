import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    contentScriptExternals,
    createBuildOptions,
    createContentScriptBuildOptions,
    createWebviewScriptBuildOptions,
    isRuntimeAsset,
    readPluginConfig,
} from '../lib/buildConfig.mjs';
import { projectFixture } from './helpers.mjs';

const root = path.resolve('/project');

test('copies runtime assets while excluding TypeScript, tests, and fixtures', () => {
    for (const relative of ['manifest.json', 'diffPreview/styles.css', 'worker.js']) {
        assert.equal(isRuntimeAsset(root, path.join(root, 'src', relative)), true, relative);
    }
    for (const relative of [
        'index.ts',
        'view.tsx',
        'worker.mts',
        'config.cts',
        'types.d.ts',
        'render.test.js',
        'render.spec.mjs',
        '__tests__/example.json',
        'formatter/fixtures',
        'formatter/fixtures/example/input.md',
    ]) {
        assert.equal(isRuntimeAsset(root, path.join(root, 'src', relative)), false, relative);
    }
});

test('reads an optional plugin config with defaults', async (t) => {
    const { directory } = await projectFixture(t);
    assert.deepEqual(await readPluginConfig(directory), {
        extraScripts: [],
        webviewScripts: [],
        mainBuildOptions: {},
        contentScriptBuildOptions: {},
        webviewScriptBuildOptions: {},
    });
    const config = {
        extraScripts: ['contentScripts/a.ts'],
        webviewScripts: ['dialog/b.ts'],
        mainBuildOptions: { external: ['jsdom'] },
        contentScriptBuildOptions: { minify: false },
        webviewScriptBuildOptions: { sourcemap: 'inline' },
    };
    await writeFile(path.join(directory, 'plugin.config.json'), JSON.stringify(config));
    assert.deepEqual(await readPluginConfig(directory), config);
});

test('explains a malformed plugin config', async (t) => {
    const { directory } = await projectFixture(t);
    const configPath = path.join(directory, 'plugin.config.json');
    /** @type {[string, RegExp][]} */
    const cases = [
        ['{', /Could not read .*plugin\.config\.json/],
        ['[]', /must contain a JSON object/],
        [JSON.stringify({ extraScript: [] }), /unknown keys: extraScript/],
        [JSON.stringify({ extraScripts: 'contentScripts/a.ts' }), /"extraScripts" must be an array/],
        [JSON.stringify({ webviewScripts: [1] }), /"webviewScripts" must be an array/],
        [JSON.stringify({ extraScripts: ['a.ts'], webviewScripts: ['a.js'] }), /more than one script .*dist\/a\.js/],
        [JSON.stringify({ mainBuildOptions: [] }), /"mainBuildOptions" must be an object/],
        [JSON.stringify({ mainBuildOptions: { outfile: 'x.js' } }), /cannot set outfile/],
        [JSON.stringify({ mainBuildOptions: { write: false } }), /cannot set write/],
        [JSON.stringify({ mainBuildOptions: { format: 'esm' } }), /cannot set format/],
        [JSON.stringify({ mainBuildOptions: { plugins: [], minify: false } }), /cannot set plugins\./],
        [JSON.stringify({ mainBuildOptions: { define: 'x' } }), /"mainBuildOptions\.define" must be an object/],
        [JSON.stringify({ mainBuildOptions: { define: { __DEBUG__: false } } }), /"mainBuildOptions\.define" must be/],
        [JSON.stringify({ mainBuildOptions: { external: 'jsdom' } }), /"mainBuildOptions\.external" must be an array/],
        [JSON.stringify({ contentScriptBuildOptions: [] }), /"contentScriptBuildOptions" must be an object/],
        [
            JSON.stringify({ contentScriptBuildOptions: { format: 'esm' } }),
            /"contentScriptBuildOptions" cannot set format/,
        ],
        [JSON.stringify({ contentScriptBuildOptions: { platform: 'node' } }), /cannot set platform/],
        [
            JSON.stringify({ contentScriptBuildOptions: { external: [1] } }),
            /"contentScriptBuildOptions\.external" must/,
        ],
        [
            JSON.stringify({ webviewScriptBuildOptions: { define: { A: 1 } } }),
            /"webviewScriptBuildOptions\.define" must/,
        ],
        [JSON.stringify({ webviewScriptBuildOptions: { external: ['x'] } }), /cannot set external/],
        [JSON.stringify({ webviewScriptBuildOptions: { outfile: 'x.js' } }), /cannot set outfile/],
    ];
    for (const [text, message] of cases) {
        await writeFile(configPath, text);
        await assert.rejects(readPluginConfig(directory), message, text);
    }
});

test('rejects options that would leave runtime requires in any bundle', async (t) => {
    const { directory } = await projectFixture(t);
    const configPath = path.join(directory, 'plugin.config.json');
    for (const key of ['buildOptions', 'mainBuildOptions', 'contentScriptBuildOptions', 'webviewScriptBuildOptions']) {
        for (const [option, value] of /** @type {[string, unknown][]} */ ([
            ['bundle', false],
            ['packages', 'external'],
        ])) {
            const text = JSON.stringify({ [key]: { [option]: value } });
            await writeFile(configPath, text);
            await assert.rejects(readPluginConfig(directory), new RegExp(`"${key}" cannot set ${option}\\.`), text);
        }
    }
});

test('merges shared build options under each bundle type, merging definitions individually', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFile(
        path.join(directory, 'plugin.config.json'),
        JSON.stringify({
            buildOptions: { target: 'es2015', sourcemap: 'inline', define: { __SHARED__: '1', __LABEL__: '"shared"' } },
            mainBuildOptions: { external: ['jsdom'] },
            contentScriptBuildOptions: { target: 'es2017' },
            webviewScriptBuildOptions: { define: { __LABEL__: '"webview"' } },
        })
    );
    const config = await readPluginConfig(directory);
    assert.deepEqual(config.mainBuildOptions, {
        target: 'es2015',
        sourcemap: 'inline',
        define: { __SHARED__: '1', __LABEL__: '"shared"' },
        external: ['jsdom'],
    });
    assert.deepEqual(config.contentScriptBuildOptions, {
        target: 'es2017',
        sourcemap: 'inline',
        define: { __SHARED__: '1', __LABEL__: '"shared"' },
    });
    assert.deepEqual(config.webviewScriptBuildOptions, {
        target: 'es2015',
        sourcemap: 'inline',
        define: { __SHARED__: '1', __LABEL__: '"webview"' },
    });
    assert.deepEqual(createBuildOptions(root, config.mainBuildOptions).define, {
        'process.env.NODE_ENV': '"production"',
        __SHARED__: '1',
        __LABEL__: '"shared"',
    });
    assert.equal(createWebviewScriptBuildOptions(root, 'dialog.ts', config.webviewScriptBuildOptions).target, 'es2015');
});

test('rejects shared build options that some bundle type may not set', async (t) => {
    const { directory } = await projectFixture(t);
    const configPath = path.join(directory, 'plugin.config.json');
    for (const [options, message] of /** @type {[object, RegExp][]} */ ([
        [[], /"buildOptions" must be an object/],
        [{ platform: 'node' }, /"buildOptions" cannot set platform\./],
        [{ external: ['jsdom'] }, /"buildOptions" cannot set external\./],
        [{ outfile: 'x.js' }, /"buildOptions" cannot set outfile\./],
        [{ define: { A: 1 } }, /"buildOptions\.define" must be an object of string replacements/],
    ])) {
        const text = JSON.stringify({ buildOptions: options });
        await writeFile(configPath, text);
        await assert.rejects(readPluginConfig(directory), message, text);
    }
});

test('merges main build overrides over the defaults', () => {
    const defaults = createBuildOptions(root);
    assert.equal(defaults.absWorkingDir, root);
    assert.deepEqual(defaults.entryPoints, ['src/index.ts']);
    assert.equal(defaults.outfile, 'dist/index.js');
    assert.equal(defaults.platform, 'node');
    const options = createBuildOptions(root, { external: ['jsdom'], minify: false });
    assert.deepEqual(options.external, ['jsdom']);
    assert.equal(options.minify, false);
    assert.equal(options.outfile, 'dist/index.js');
});

test('preserves default definitions when adding custom definitions and allows explicit overrides', () => {
    const options = createBuildOptions(root, { define: { __DEBUG__: 'false' } });
    assert.deepEqual(options.define, {
        'process.env.NODE_ENV': '"production"',
        __DEBUG__: 'false',
    });
    const overridden = createBuildOptions(root, { define: { 'process.env.NODE_ENV': '"development"' } });
    assert.deepEqual(overridden.define, { 'process.env.NODE_ENV': '"development"' });
});

test('defaults script build options when the config omits them', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFile(path.join(directory, 'plugin.config.json'), JSON.stringify({ extraScripts: ['a.ts'] }));
    const config = await readPluginConfig(directory);
    assert.deepEqual(config.contentScriptBuildOptions, {});
    assert.deepEqual(config.webviewScriptBuildOptions, {});
});

test('merges content-script overrides, keeping host libraries external and default definitions', () => {
    const options = createContentScriptBuildOptions(root, 'cs.ts', {
        minify: false,
        external: ['extra-lib', '@codemirror/view'],
        define: { __DEBUG__: 'true' },
    });
    assert.equal(options.minify, false);
    assert.equal(options.format, 'cjs');
    assert.deepEqual(options.external, [...contentScriptExternals, 'extra-lib']);
    assert.deepEqual(options.define, { 'process.env.NODE_ENV': '"production"', __DEBUG__: 'true' });
    assert.equal(options.outfile, 'dist/cs.js');
});

test('merges webview-script overrides while keeping a self-contained IIFE', () => {
    const options = createWebviewScriptBuildOptions(root, 'dialog.ts', { sourcemap: 'inline' });
    assert.equal(options.sourcemap, 'inline');
    assert.equal(options.format, 'iife');
    assert.deepEqual(options.external, []);
    assert.deepEqual(options.define, { 'process.env.NODE_ENV': '"production"' });
    // Content-script overrides are not part of a webview script's defaults.
    assert.deepEqual(createWebviewScriptBuildOptions(root, 'dialog.ts').sourcemap, undefined);
});

test('maps content scripts to dist and rejects paths outside src', () => {
    const options = createContentScriptBuildOptions(root, 'contentScripts/codeMirror.ts');
    assert.deepEqual(options.entryPoints, ['src/contentScripts/codeMirror.ts']);
    assert.equal(options.outfile, 'dist/contentScripts/codeMirror.js');
    assert.equal(options.platform, undefined);
    for (const script of ['../outside.ts', path.resolve('/abs.ts'), 'styles.css']) {
        assert.throws(() => createContentScriptBuildOptions(root, script), /Invalid extra script path/, script);
    }
});
