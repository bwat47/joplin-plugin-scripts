#!/usr/bin/env node
import { buildPlugin } from '../lib/build.mjs';
import { PluginScriptsError } from '../lib/errors.mjs';
import { updateApi } from '../lib/updateApi.mjs';
import { updateVersion } from '../lib/updateVersion.mjs';

const USAGE = `Usage: joplin-plugin-scripts <command>

Run from a Joplin plugin project root (npm scripts do this automatically).

Commands:
  build           Bundle the plugin with esbuild and create publish/<id>.jpl
  update-version  Increment the patch version in package.json, src/manifest.json, and package-lock.json
  update-api      Replace api/ with the declarations from the latest generator-joplin`;

/** @type {Record<string, (root: string) => Promise<void>>} */
const commands = {
    build: async (root) => {
        await buildPlugin(root);
    },
    'update-version': async (root) => {
        console.info(`Updated version to ${await updateVersion(root)}.`);
    },
    'update-api': async (root) => {
        const { version, warnings } = await updateApi(root);
        console.info(`Updated api/ from generator-joplin ${version}. Review with: git diff api/`);
        for (const warning of warnings) console.warn(`WARNING: ${warning}`);
    },
};

const [command, ...rest] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
    console.info(USAGE);
    process.exit(0);
}
const run = Object.hasOwn(commands, command) ? commands[command] : undefined;
if (!run || rest.length > 0) {
    console.error(USAGE);
    process.exit(1);
}
try {
    await run(process.cwd());
} catch (error) {
    // Expected failures print only their message; anything else is a bug, so its stack is shown.
    if (!(error instanceof PluginScriptsError)) throw error;
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
}
