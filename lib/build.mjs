import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

import {
    createBuildOptions,
    createContentScriptBuildOptions,
    createWebviewScriptBuildOptions,
    isRuntimeAsset,
    readPluginConfig,
    scriptOutputPaths,
} from './buildConfig.mjs';
import { PluginScriptsError } from './errors.mjs';
import { packagePlugin, readProject } from './packagePlugin.mjs';

/**
 * Builds the plugin at `root`: validates the project, clears `dist/` and `publish/`, copies runtime
 * assets from `src/`, bundles the main entry point, extra scripts, and webview scripts, and creates
 * the `.jpl` archive.
 * @param {string} root Plugin project root.
 */
export async function buildPlugin(root) {
    const dist = path.join(root, 'dist');
    const publish = path.join(root, 'publish');
    const { manifest } = await readProject(root);
    const { extraScripts, webviewScripts, mainBuildOptions, contentScriptBuildOptions, webviewScriptBuildOptions } =
        await readPluginConfig(root);
    const scriptBuilds = [
        ...extraScripts.map((script) => createContentScriptBuildOptions(root, script, contentScriptBuildOptions)),
        ...webviewScripts.map((script) => createWebviewScriptBuildOptions(root, script, webviewScriptBuildOptions)),
    ];

    // Only these fixed, project-local output directories are removed.
    await rm(dist, { recursive: true, force: true });
    await rm(publish, { recursive: true, force: true });
    await mkdir(dist, { recursive: true });

    // Copy first so a JavaScript source asset cannot overwrite a compiled bundle.
    await cp(path.join(root, 'src'), dist, {
        recursive: true,
        filter: (source) => isRuntimeAsset(root, source),
    });
    // Wait for every bundle, so esbuild has printed all of its errors before the build stops.
    const results = await Promise.allSettled([
        build(createBuildOptions(root, mainBuildOptions)),
        ...scriptBuilds.map((options) => build(options)),
    ]);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) {
        // esbuild's own failures carry `errors` and have already been logged; anything else is unexpected.
        const unexpected = failures.find((failure) => !isEsbuildFailure(failure));
        if (unexpected) throw unexpected;
        throw new PluginScriptsError('Bundling failed; see the esbuild errors above.', { cause: failures[0] });
    }

    await packagePlugin(root, manifest, scriptOutputPaths(extraScripts, webviewScripts));
}

/**
 * Checks whether a rejected build is an esbuild `BuildFailure`, whose messages esbuild has already logged.
 * @param {unknown} error
 * @returns {boolean}
 */
function isEsbuildFailure(error) {
    return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}
