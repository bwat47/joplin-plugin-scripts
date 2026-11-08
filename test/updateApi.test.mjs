import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contentScriptExternals } from '../lib/buildConfig.mjs';
import { VALID_CATEGORIES } from '../lib/packagePlugin.mjs';
import { compareGeneratorLists, replaceApi } from '../lib/updateApi.mjs';

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
