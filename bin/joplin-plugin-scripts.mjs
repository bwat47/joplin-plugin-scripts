#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildPlugin } from '../lib/build.mjs';
import { PluginScriptsError } from '../lib/errors.mjs';
import { updateApi } from '../lib/updateApi.mjs';
import { updateVersion } from '../lib/updateVersion.mjs';

const USAGE = `Usage: joplin-plugin-scripts <command> [arguments]

Run from a Joplin plugin project root (npm scripts do this automatically).

Commands:
  build [--dev] [--sourcemap] [--no-minify] [--analyze]
                  Bundle the plugin with esbuild and create publish/<id>.jpl
                  --dev        Disable minification, emit inline sourcemaps, and default NODE_ENV to "development"
                  --sourcemap  Emit inline sourcemaps for all bundles
                  --no-minify  Disable minification for all bundles
                  --analyze    Print an esbuild bundle-size breakdown for each bundle
  update-version [patch|minor|major|<x.y.z>]
                  Update the version in package.json, src/manifest.json, and package-lock.json (if present):
                  increment the patch (default), minor, or major part, or set an explicit higher version
  update-api      Replace api/ with the declarations from the latest generator-joplin`;

/**
 * Parses CLI flags for the `build` command, returning `undefined` on invalid flags or arguments.
 * @param {string[]} args
 * @returns {{ analyze: boolean, dev: boolean, sourcemap: boolean, noMinify: boolean } | undefined}
 */
function parseBuildArgs(args) {
    try {
        const { values } = parseArgs({
            args,
            options: {
                analyze: { type: 'boolean', default: false },
                dev: { type: 'boolean', default: false },
                sourcemap: { type: 'boolean', default: false },
                'no-minify': { type: 'boolean', default: false },
            },
            allowPositionals: false,
            strict: true,
        });
        return {
            analyze: Boolean(values.analyze),
            dev: Boolean(values.dev),
            sourcemap: Boolean(values.sourcemap),
            noMinify: Boolean(values['no-minify']),
        };
    } catch (error) {
        if (
            error instanceof TypeError &&
            'code' in error &&
            typeof error.code === 'string' &&
            error.code.startsWith('ERR_PARSE_ARGS_')
        ) {
            return undefined;
        }
        throw error;
    }
}

/**
 * Each command takes the project root and its arguments, and validates them with `maxArgs` and/or `isValidArgs`.
 * @type {Record<string, {
 *   maxArgs?: number,
 *   isValidArgs?: (args: string[]) => boolean,
 *   run: (root: string, args: string[]) => Promise<void>,
 * }>}
 */
const commands = {
    build: {
        isValidArgs: (args) => parseBuildArgs(args) !== undefined,
        run: async (root, args) => {
            const options = parseBuildArgs(args);
            if (!options) throw new Error('Invalid build arguments.');
            const { analyze, dev, sourcemap, noMinify } = options;
            const { archivePath, version, analysis } = await buildPlugin(root, {
                analyze,
                color: Boolean(process.stdout.isTTY),
                dev,
                sourcemap,
                minify: noMinify ? false : undefined,
            });
            if (analysis) console.info(analysis);
            const modeTags = dev ? ['dev'] : [...(sourcemap ? ['sourcemap'] : []), ...(noMinify ? ['no-minify'] : [])];
            const modeSuffix = modeTags.length > 0 ? `, ${modeTags.join(', ')}` : '';
            console.info(`Created ${path.relative(root, archivePath)} (v${version}${modeSuffix}).`);
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
if (
    !entry ||
    (entry.maxArgs !== undefined && args.length > entry.maxArgs) ||
    (entry.isValidArgs && !entry.isValidArgs(args))
) {
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
