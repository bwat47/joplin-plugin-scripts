// Public API for plugin projects' own build tests. The CLI in bin/ is the main entry point.
export {
    contentScriptExternals,
    createBuildOptions,
    createContentScriptBuildOptions,
    createWebviewScriptBuildOptions,
    readPluginConfig,
} from './buildConfig.mjs';
export { PluginScriptsError } from './errors.mjs';
