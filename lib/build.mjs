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
import { packagePlugin, readProject } from './packagePlugin.mjs';

/**
 * Builds the plugin at `root`: validates the project, clears `dist/` and `publish/`, copies runtime
 * assets from `src/`, bundles the main entry point, extra scripts, and webview scripts, and creates
 * the `.jpl` archive.
 */
export async function buildPlugin(root) {
    const dist = path.join(root, 'dist');
    const publish = path.join(root, 'publish');
    const { manifest } = await readProject(root);
    const { extraScripts, webviewScripts, mainBuildOptions } = await readPluginConfig(root);
    const scriptBuilds = [
        ...extraScripts.map((script) => createContentScriptBuildOptions(root, script)),
        ...webviewScripts.map((script) => createWebviewScriptBuildOptions(root, script)),
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
    await Promise.all([
        build(createBuildOptions(root, mainBuildOptions)),
        ...scriptBuilds.map((options) => build(options)),
    ]);

    await packagePlugin(root, manifest, scriptOutputPaths(extraScripts, webviewScripts));
}
