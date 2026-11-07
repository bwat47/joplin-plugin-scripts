// Public API for plugin projects' own build tests. The CLI in bin/ is the main entry point.
export {
    contentScriptExternals,
    createBuildOptions,
    createContentScriptBuildOptions,
    readPluginConfig,
} from './buildConfig.mjs';
