import assert from 'node:assert/strict';
import test from 'node:test';

import { describeInvalidWindowsName, invalidWindowsName, pathCollisionKey } from '../lib/paths.mjs';

test('gives paths that name one file on Windows or macOS the same collision key', () => {
    assert.equal(pathCollisionKey('img/Logo.PNG'), pathCollisionKey('img/logo.png'));
    // `é` as one code point (NFC) and as `e` plus a combining acute accent (NFD).
    assert.equal(pathCollisionKey('café.png'), pathCollisionKey('café.png'));
    assert.equal(pathCollisionKey('CAFÉ.png'), pathCollisionKey('café.png'));
    assert.notEqual(pathCollisionKey('cafe.png'), pathCollisionKey('café.png'));
});

test('accepts names Windows can extract unchanged', () => {
    for (const name of ['index.js', 'img/logo.png', 'a b/c-d_e.f.txt', 'console.js', 'com10.txt', 'lpt.js', 'café']) {
        assert.equal(invalidWindowsName(name), undefined, name);
    }
});

test('returns the first name Windows cannot extract unchanged', () => {
    /** @type {[string, string][]} */
    const cases = [
        ['img\\logo.png', 'img\\logo.png'],
        ...[...'<>:"|?*'].map(
            (character) => /** @type {[string, string]} */ ([`img/a${character}b.png`, `a${character}b.png`])
        ),
        ['a\u0001b.png', 'a\u0001b.png'],
        ['notes./a.txt', 'notes.'],
        ['img/logo.png ', 'logo.png '],
        ['CON', 'CON'],
        ['dir/nul.txt', 'nul.txt'],
        ['aux .tar.gz', 'aux .tar.gz'],
        ['com1.js', 'com1.js'],
        ['LPT¹', 'LPT¹'],
        ['a:b/c?d', 'a:b'],
    ];
    for (const [relativePath, expected] of cases)
        assert.equal(invalidWindowsName(relativePath), expected, relativePath);
});

test('quotes the invalid name so control characters and trailing spaces are visible', () => {
    assert.match(describeInvalidWindowsName('a\u0001b.png'), /because of the name "a\\u0001b\.png" \(/);
    assert.match(describeInvalidWindowsName('logo.png '), /because of the name "logo\.png " \(/);
});
