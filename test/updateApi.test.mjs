import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { create } from 'tar';

import { contentScriptExternals } from '../lib/buildConfig.mjs';
import { PluginScriptsError } from '../lib/errors.mjs';
import { VALID_CATEGORIES } from '../lib/packagePlugin.mjs';
import { compareGeneratorLists, replaceApi, updateApi } from '../lib/updateApi.mjs';
import { writeFiles } from './helpers.mjs';

/**
 * Builds text shaped like generator-joplin's webpack.config.js lists.
 * @param {string[]} categories
 * @param {string[]} externals
 * @returns {string}
 */
function generatorWebpackConfig(categories, externals) {
    const categoryEntries = categories.map((name) => `{'name':'${name}'}`).join(',');
    const externalEntries = externals.map((name) => `\t'${name}',\n`).join('');
    return (
        `const allPossibleCategories = [${categoryEntries}];\n` +
        `const externalContentScriptLibraries = [\n${externalEntries}];\n`
    );
}

test('reports no generator list warnings when categories and externals match', () => {
    assert.deepEqual(compareGeneratorLists(generatorWebpackConfig([...VALID_CATEGORIES], contentScriptExternals)), []);
});

test('warns when the generator categories or content-script externals differ', () => {
    const categories = [...VALID_CATEGORIES].filter((category) => category !== 'themes').concat('new category');
    const externals = [...contentScriptExternals, '@codemirror/new-package'];
    const warnings = compareGeneratorLists(generatorWebpackConfig(categories, externals));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /plugin categories.*missing new category; not in generator themes.*VALID_CATEGORIES/);
    assert.match(warnings[1], /content-script externals.*missing @codemirror\/new-package.*contentScriptExternals/);
});

test('warns when the generator lists cannot be found', () => {
    const warnings = compareGeneratorLists('module.exports = {};');
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => /Could not find/.test(warning)));
});

/**
 * Creates an API fixture removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function apiFixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'joplin-plugin-scripts-api-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'api'));
    await writeFile(path.join(directory, 'api/index.ts'), 'old');
    await writeFile(path.join(directory, 'api/Stale.d.ts'), 'stale');
    return directory;
}

test('replaces api/ with the generator copy and leaves no staging directories', async (t) => {
    const directory = await apiFixture(t);
    const source = path.join(directory, 'generator-api');
    await mkdir(path.join(source, 'types'), { recursive: true });
    await writeFile(path.join(source, 'index.ts'), 'new');
    await writeFile(path.join(source, 'types/index.ts'), 'types');
    await replaceApi(directory, source);
    assert.deepEqual((await readdir(path.join(directory, 'api'))).sort(), ['index.ts', 'types']);
    assert.equal(await readFile(path.join(directory, 'api/index.ts'), 'utf8'), 'new');
    assert.deepEqual((await readdir(directory)).sort(), ['api', 'generator-api']);
});

test('leaves api/ unchanged when the generator API is missing or cannot be copied', async (t) => {
    const directory = await apiFixture(t);
    await assert.rejects(replaceApi(directory, path.join(directory, 'missing')), { code: 'ENOENT' });
    const source = path.join(directory, 'generator-api');
    await mkdir(source);
    await writeFile(path.join(source, 'index.ts'), 'new');
    // Fail after part of the new API has been written to staging.
    /** @type {import('../lib/updateApi.mjs').CopyDirectory} */
    const failingCopy = async (from, to) => {
        await writeFile(path.join(to, 'index.ts'), 'partial');
        throw new Error('copy failed');
    };
    await assert.rejects(replaceApi(directory, source, failingCopy), /copy failed/);
    assert.deepEqual((await readdir(path.join(directory, 'api'))).sort(), ['Stale.d.ts', 'index.ts']);
    assert.equal(await readFile(path.join(directory, 'api/index.ts'), 'utf8'), 'old');
    assert.deepEqual((await readdir(directory)).sort(), ['api', 'generator-api']);
});

const REGISTRY = 'https://registry.test/';
const TARBALL_URL = 'https://registry.test/generator-joplin/-/generator-joplin-9.9.9.tgz';

/**
 * Packs a minimal generator-joplin tarball and returns its bytes.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<Buffer>}
 */
async function generatorTarball(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'joplin-plugin-scripts-generator-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const templates = 'package/generators/app/templates';
    await writeFiles(directory, {
        'package/package.json': JSON.stringify({ name: 'generator-joplin', version: '9.9.9' }),
        [`${templates}/api/index.ts`]: 'new',
        [`${templates}/webpack.config.js`]: generatorWebpackConfig([...VALID_CATEGORIES], contentScriptExternals),
    });
    const file = path.join(directory, 'generator.tgz');
    await create({ cwd: directory, file, gzip: true, portable: true }, ['package']);
    return readFile(file);
}

/**
 * Returns a fetch that serves the registry metadata and tarball, recording requested URLs.
 * @param {Buffer} tarball
 * @param {string} integrity
 * @returns {{ fetch: typeof fetch, requests: string[] }}
 */
function fakeRegistry(tarball, integrity) {
    /** @type {string[]} */
    const requests = [];
    /** @type {typeof fetch} */
    const fakeFetch = async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === 'https://registry.test/generator-joplin/latest') {
            return Response.json({ version: '9.9.9', dist: { tarball: TARBALL_URL, integrity } });
        }
        if (url === TARBALL_URL) return new Response(new Uint8Array(tarball));
        return new Response('not found', { status: 404, statusText: 'Not Found' });
    };
    return { fetch: fakeFetch, requests };
}

/** @param {Buffer} bytes */
function sha512Integrity(bytes) {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

test('downloads, verifies, and installs the latest generator API', async (t) => {
    const directory = await apiFixture(t);
    const tarball = await generatorTarball(t);
    const { fetch, requests } = fakeRegistry(tarball, `sha1-ignored ${sha512Integrity(tarball)}`);
    assert.deepEqual(await updateApi(directory, { registry: REGISTRY, fetch }), { version: '9.9.9', warnings: [] });
    assert.deepEqual(requests, ['https://registry.test/generator-joplin/latest', TARBALL_URL]);
    assert.deepEqual(await readdir(path.join(directory, 'api')), ['index.ts']);
    assert.equal(await readFile(path.join(directory, 'api/index.ts'), 'utf8'), 'new');
});

test('leaves api/ unchanged when the tarball fails its integrity check', async (t) => {
    const directory = await apiFixture(t);
    const tarball = await generatorTarball(t);
    for (const integrity of [sha512Integrity(Buffer.from('other')), '', 'sha1-abc']) {
        const { fetch } = fakeRegistry(tarball, integrity);
        await assert.rejects(updateApi(directory, { registry: REGISTRY, fetch }), PluginScriptsError);
    }
    assert.equal(await readFile(path.join(directory, 'api/index.ts'), 'utf8'), 'old');
});

test('reports HTTP and network failures as plugin script errors', async (t) => {
    const directory = await apiFixture(t);
    const { fetch } = fakeRegistry(Buffer.alloc(0), '');
    await assert.rejects(updateApi(directory, { registry: 'https://elsewhere.test', fetch }), {
        name: 'PluginScriptsError',
        message: /elsewhere\.test\/generator-joplin\/latest: HTTP 404 Not Found/,
    });
    /** @type {typeof fetch} */
    const offline = async () => {
        throw new TypeError('fetch failed');
    };
    await assert.rejects(updateApi(directory, { registry: REGISTRY, fetch: offline }), {
        name: 'PluginScriptsError',
        message: /Could not download .*: fetch failed/,
    });
});

test('reports metadata and tarball body failures as plugin script errors', async (t) => {
    const directory = await apiFixture(t);
    const metadataUrl = `${REGISTRY}generator-joplin/latest`;
    for (const failedUrl of [metadataUrl, TARBALL_URL]) {
        const cause = new TypeError('terminated');
        /** @type {typeof fetch} */
        const failingFetch = async (input) => {
            if (String(input) !== failedUrl) {
                return Response.json({ dist: { tarball: TARBALL_URL } });
            }
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(cause);
                    },
                })
            );
        };
        await assert.rejects(updateApi(directory, { registry: REGISTRY, fetch: failingFetch }), {
            name: 'PluginScriptsError',
            message: `Could not download ${failedUrl}: terminated`,
            cause,
        });
        assert.equal(await readFile(path.join(directory, 'api/index.ts'), 'utf8'), 'old');
    }
});
