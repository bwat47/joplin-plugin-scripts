import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { packagePlugin, readProject } from '../lib/packagePlugin.mjs';
import { archiveEntries, projectFixture, writeFiles } from './helpers.mjs';

test('packages the runtime files at archive root, without dotfiles, with matching publish metadata', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    await mkdir(path.join(directory, 'dist/empty'));
    await writeFiles(directory, {
        'dist/assets/example.css': 'body {}',
        'dist/assets/.DS_Store': 'finder metadata',
        'dist/.cache/state.json': '{}',
    });
    await packagePlugin(directory, manifest);
    const publish = path.join(directory, 'publish');
    assert.deepEqual((await readdir(publish)).sort(), ['test.plugin.jpl', 'test.plugin.json']);
    const archive = path.join(publish, 'test.plugin.jpl');
    assert.deepEqual(await archiveEntries(archive), ['assets/example.css', 'index.js', 'manifest.json']);
    const info = JSON.parse(await readFile(path.join(publish, 'test.plugin.json'), 'utf8'));
    const hash = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
    assert.deepEqual(info, { ...manifest, _publish_hash: `sha256:${hash}`, _publish_commit: '' });
});

test('records the main branch for a detached HEAD in publish metadata', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    const commit = 'a'.repeat(40);
    t.mock.method(childProcess, 'execFileSync', (command, args) => {
        assert.equal(command, 'git');
        return Buffer.from(args.includes('--abbrev-ref') ? 'HEAD\n' : `${commit}\n`);
    });
    syncBuiltinESMExports();
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    await packagePlugin(directory, manifest);
    const info = JSON.parse(await readFile(path.join(directory, 'publish/test.plugin.json'), 'utf8'));
    assert.equal(info._publish_commit, `main:${commit}`);
});

test('packages a registered extra script at its runtime path', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    await writeFiles(directory, { 'dist/contentScripts/codeMirror.js': 'exports.default = () => ({});' });
    await packagePlugin(directory, manifest, ['contentScripts/codeMirror.js']);
    assert.deepEqual(await archiveEntries(path.join(directory, 'publish/test.plugin.jpl')), [
        'contentScripts/codeMirror.js',
        'index.js',
        'manifest.json',
    ]);
});

test('rejects incomplete builds', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    await assert.rejects(packagePlugin(directory, manifest, ['contentScripts/missing.js']), { code: 'ENOENT' });
    await rm(path.join(directory, 'dist/index.js'));
    await assert.rejects(packagePlugin(directory, manifest), { code: 'ENOENT' });
});

test('propagates archive write failures', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    await writeFile(path.join(directory, 'publish'), 'blocks output directory');
    await assert.rejects(packagePlugin(directory, manifest));
});

test('validates the plugin ID, versions, package name, categories, and local screenshots', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    await readProject(directory);
    for (const [change, message] of [
        [{ id: 'bad id' }, /plugin ID/],
        [{ version: '9.0.0' }, /versions must match/],
        [{ categories: ['unknown'] }, /categories/],
        [{ categories: ['editor', 'editor'] }, /categories/],
        [{ screenshots: [{}] }, /specify src/],
        [{ screenshots: [{ src: 'shot.svg' }] }, /Unsupported screenshot type/],
        [{ screenshots: [{ src: 'missing.png' }] }, /ENOENT/],
    ]) {
        await writeFile(path.join(directory, 'src/manifest.json'), JSON.stringify({ ...manifest, ...change }));
        await assert.rejects(readProject(directory), message);
    }
    await writeFile(path.join(directory, 'src/manifest.json'), JSON.stringify(manifest));
    await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.2.3', keywords: ['joplin-plugin'] })
    );
    await assert.rejects(readProject(directory), /Package name must start with joplin-plugin-/);
});
