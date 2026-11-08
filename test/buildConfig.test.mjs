import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    createBuildOptions,
    createContentScriptBuildOptions,
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
    });
    const config = {
        extraScripts: ['contentScripts/a.ts'],
        webviewScripts: ['dialog/b.ts'],
        mainBuildOptions: { external: ['jsdom'] },
    };
    await writeFile(path.join(directory, 'plugin.config.json'), JSON.stringify(config));
    assert.deepEqual(await readPluginConfig(directory), config);
});

test('explains a malformed plugin config', async (t) => {
    const { directory } = await projectFixture(t);
    const configPath = path.join(directory, 'plugin.config.json');
    for (const [text, message] of [
        ['{', /Could not read .*plugin\.config\.json/],
        ['[]', /must contain a JSON object/],
        [JSON.stringify({ extraScript: [] }), /unknown keys: extraScript/],
        [JSON.stringify({ extraScripts: 'contentScripts/a.ts' }), /"extraScripts" must be an array/],
        [JSON.stringify({ webviewScripts: [1] }), /"webviewScripts" must be an array/],
        [JSON.stringify({ extraScripts: ['a.ts'], webviewScripts: ['a.js'] }), /more than one script .*dist\/a\.js/],
        [JSON.stringify({ mainBuildOptions: [] }), /"mainBuildOptions" must be an object/],
        [JSON.stringify({ mainBuildOptions: { outfile: 'x.js' } }), /cannot set outfile/],
    ]) {
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

test('maps content scripts to dist and rejects paths outside src', () => {
    const options = createContentScriptBuildOptions(root, 'contentScripts/codeMirror.ts');
    assert.deepEqual(options.entryPoints, ['src/contentScripts/codeMirror.ts']);
    assert.equal(options.outfile, 'dist/contentScripts/codeMirror.js');
    assert.equal(options.platform, undefined);
    for (const script of ['../outside.ts', path.resolve('/abs.ts'), 'styles.css']) {
        assert.throws(() => createContentScriptBuildOptions(root, script), /Invalid extra script path/, script);
    }
});
