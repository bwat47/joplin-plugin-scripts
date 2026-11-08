import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readProject } from '../lib/packagePlugin.mjs';
import { updateVersion } from '../lib/updateVersion.mjs';
import { projectFixture } from './helpers.mjs';

const syncedLock = JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } });

test('bumps package, manifest, and both lockfile versions together', async (t) => {
    const { directory } = await projectFixture(t);
    await writeFile(path.join(directory, 'package-lock.json'), syncedLock);
    assert.equal(await updateVersion(directory), '1.2.4');
    const { packageJson, manifest } = await readProject(directory);
    const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(packageJson.version, '1.2.4');
    assert.equal(manifest.version, '1.2.4');
    assert.equal(lock.version, '1.2.4');
    assert.equal(lock.packages[''].version, '1.2.4');
});

test('version bumps keep the lockfile indent and newline style', async (t) => {
    const lock = (/** @type {string} */ version) => ({
        name: 'joplin-plugin-test',
        version,
        packages: { '': { version }, 'node_modules/dep': { version: '1.2.3' } },
    });
    for (const [indent, newline] of [
        ['  ', '\n'],
        ['    ', '\n'],
        ['\t', '\n'],
        ['  ', '\r\n'],
        ['', ''],
    ]) {
        const format = (/** @type {string} */ version) =>
            `${JSON.stringify(lock(version), null, indent)}\n`.replaceAll('\n', newline);
        const { directory } = await projectFixture(t);
        const fixtureLock = path.join(directory, 'package-lock.json');
        await writeFile(fixtureLock, format('1.2.3'));
        await updateVersion(directory);
        assert.equal(await readFile(fixtureLock, 'utf8'), format('1.2.4'), JSON.stringify({ indent, newline }));
    }
});

test('version bumps change only the version in hand-formatted package.json and manifest', async (t) => {
    const { directory } = await projectFixture(t);
    const manifestText = (/** @type {string} */ version) =>
        `{\n    "manifest_version": 1,\n    "id": "test.plugin",\n    "version": "${version}",\n` +
        `    "categories": ["productivity", "editor"],\n    "promo_tile": {\n        "src": "promo.png"\n    }\n}\n`;
    const packageText = (/** @type {string} */ version) =>
        `{\n    "name": "joplin-plugin-test",\n    "version": "${version}",\n` +
        `    "keywords": [\n        "joplin-plugin"\n    ],\n    "devDependencies": { "dep": "1.2.3" }\n}\n`;
    await writeFile(path.join(directory, 'src/manifest.json'), manifestText('1.2.3'));
    await writeFile(path.join(directory, 'package.json'), packageText('1.2.3'));
    await writeFile(path.join(directory, 'package-lock.json'), syncedLock);
    await updateVersion(directory);
    assert.equal(await readFile(path.join(directory, 'src/manifest.json'), 'utf8'), manifestText('1.2.4'));
    assert.equal(await readFile(path.join(directory, 'package.json'), 'utf8'), packageText('1.2.4'));
});

test('version bumps write nothing when a version entry is ambiguous', async (t) => {
    const { directory, manifest } = await projectFixture(t);
    const ambiguousManifest = JSON.stringify({ ...manifest, nested: { version: '1.2.3' } });
    await writeFile(path.join(directory, 'src/manifest.json'), ambiguousManifest);
    await writeFile(path.join(directory, 'package-lock.json'), syncedLock);
    const packageText = await readFile(path.join(directory, 'package.json'), 'utf8');
    await assert.rejects(updateVersion(directory), /Expected one "version"/);
    assert.equal(await readFile(path.join(directory, 'package.json'), 'utf8'), packageText);
    assert.equal(await readFile(path.join(directory, 'src/manifest.json'), 'utf8'), ambiguousManifest);
    assert.equal(await readFile(path.join(directory, 'package-lock.json'), 'utf8'), syncedLock);
});

test('version bumps explain a lockfile without a root entry or out of sync, and write nothing', async (t) => {
    const { directory } = await projectFixture(t);
    const lockPath = path.join(directory, 'package-lock.json');
    const packageText = await readFile(path.join(directory, 'package.json'), 'utf8');
    for (const [lock, message] of [
        [{ version: '1.2.3' }, /no root package entry/],
        [{ version: '1.2.3', packages: { '': { version: '1.0.0' } } }, /do not match package\.json/],
        [{ version: '1.0.0', packages: { '': { version: '1.2.3' } } }, /do not match package\.json/],
    ]) {
        await writeFile(lockPath, JSON.stringify(lock));
        await assert.rejects(updateVersion(directory), message);
        assert.equal(await readFile(lockPath, 'utf8'), JSON.stringify(lock));
        assert.equal(await readFile(path.join(directory, 'package.json'), 'utf8'), packageText);
    }
});
