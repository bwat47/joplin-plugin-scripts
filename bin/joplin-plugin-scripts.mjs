#!/usr/bin/env node
import { buildPlugin } from '../lib/build.mjs';
import { PluginScriptsError } from '../lib/errors.mjs';
import { updateApi } from '../lib/updateApi.mjs';
import { updateVersion } from '../lib/updateVersion.mjs';

const USAGE = `Usage: joplin-plugin-scripts <command> [argument]

Run from a Joplin plugin project root (npm scripts do this automatically).

Commands:
  build           Bundle the plugin with esbuild and create publish/<id>.jpl
  update-version [patch|minor|major|<x.y.z>]
                  Update the version in package.json, src/manifest.json, and package-lock.json:
                  increment the patch (default), minor, or major part, or set an explicit higher version
  update-api      Replace api/ with the declarations from the latest generator-joplin`;

/**
 * Each command takes the project root and its arguments, and accepts at most `maxArgs` of them.
 * @type {Record<string, { maxArgs: number, run: (root: string, args: string[]) => Promise<void> }>}
 */
const commands = {
    build: {
        maxArgs: 0,
        run: async (root) => {
            await buildPlugin(root);
        },
    },
    'update-version': {
        maxArgs: 1,
        run: async (root, [release]) => {
            console.info(`Updated version to ${await updateVersion(root, release)}.`);
        },
    },
    'update-api': {
        maxArgs: 0,
        run: async (root) => {
            const { version, warnings } = await updateApi(root);
            console.info(`Updated api/ from generator-joplin ${version}. Review with: git diff api/`);
            for (const warning of warnings) console.warn(`WARNING: ${warning}`);
        },
    },
};

const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
    console.info(USAGE);
    process.exit(0);
}
const entry = Object.hasOwn(commands, command) ? commands[command] : undefined;
if (!entry || args.length > entry.maxArgs) {
    console.error(USAGE);
    process.exit(1);
}
try {
    await entry.run(process.cwd(), args);
} catch (error) {
    // Expected failures print only their message; anything else is a bug, so its stack is shown.
    if (!(error instanceof PluginScriptsError)) throw error;
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
}
