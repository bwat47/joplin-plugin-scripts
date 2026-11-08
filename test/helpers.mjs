import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { list } from 'tar';

/**
 * Creates a temporary plugin project with matching package.json and manifest versions and a
 * prebuilt `dist/`. The directory is removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ directory: string, manifest: { id: string, version: string, categories: string[] } }>}
 */
export async function projectFixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'joplin-plugin-scripts-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'src'));
    await mkdir(path.join(directory, 'dist'));
    const manifest = { id: 'test.plugin', version: '1.2.3', categories: ['productivity'] };
    await writeFile(path.join(directory, 'src/manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'dist/manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'dist/index.js'), '/* bundled plugin */');
    await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ name: 'joplin-plugin-test', version: '1.2.3', keywords: ['joplin-plugin'] })
    );
    return { directory, manifest };
}

/**
 * Writes `files` (relative path to contents) under `directory`, creating parent directories.
 * @param {string} directory
 * @param {{ [path: string]: string }} files
 */
export async function writeFiles(directory, files) {
    for (const [relative, contents] of Object.entries(files)) {
        const filePath = path.join(directory, relative);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents);
    }
}

/**
 * Returns the sorted entry paths of a tar archive.
 * @param {string} file
 * @returns {Promise<string[]>}
 */
export async function archiveEntries(file) {
    /** @type {string[]} */
    const entries = [];
    await list({ file, onReadEntry: (entry) => entries.push(entry.path) });
    return entries.sort();
}
