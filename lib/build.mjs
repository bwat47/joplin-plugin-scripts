import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

import {
    createBuildOptions,
    createContentScriptBuildOptions,
    isRuntimeAsset,
    readPluginConfig,
} from './buildConfig.mjs';
import { packagePlugin, readProject } from './packagePlugin.mjs';

/**
 * Builds the plugin at `root`: validates the project, clears `dist/` and `publish/`, copies runtime
 * assets from `src/`, bundles the main entry point and extra scripts, and creates the `.jpl` archive.
 */
export async function buildPlugin(root) {
    const dist = path.join(root, 'dist');
    const publish = path.join(root, 'publish');
    const { manifest } = await readProject(root);
    const { extraScripts, mainBuildOptions } = await readPluginConfig(root);
    const extraBuilds = extraScripts.map((script) => createContentScriptBuildOptions(root, script));

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
        ...extraBuilds.map((options) => build(options)),
    ]);

    await packagePlugin(
        root,
        manifest,
        extraBuilds.map((options) => path.relative(dist, path.resolve(root, options.outfile)))
    );
}
