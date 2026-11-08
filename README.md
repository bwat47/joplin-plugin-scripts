# @bwat47/joplin-plugin-scripts

Shared build tooling for Joplin plugins: an esbuild-based replacement for the
generator-joplin Webpack config and its scripts.

## Installation

```sh
npm install -D @bwat47/joplin-plugin-scripts
```

```json
"scripts": {
    "typecheck": "tsc --noEmit",
    "dist": "npm run typecheck && joplin-plugin-scripts build",
    "updateVersion": "joplin-plugin-scripts update-version",
    "updateApi": "joplin-plugin-scripts update-api"
}
```

esbuild does not check types, so `dist` runs `tsc --noEmit` before building.

## Commands

Commands run from the plugin project root, which npm scripts do automatically.

- `build`: validates the project, clears `dist/` and `publish/`, copies runtime assets
  from `src/`, bundles, and writes `publish/<id>.jpl` and `<id>.json`.
- `update-version`: increments the patch version across `package.json`,
  `src/manifest.json`, and `package-lock.json`.
- `update-api`: replaces `api/` with the latest generator-joplin API, and warns if the
  category or content-script external lists here differ. Downloads generator-joplin
  directly from the registry in `npm_config_registry` (set by npm scripts), or
  registry.npmjs.org, and verifies its integrity hash. npm itself is not needed;
  registry authentication and proxy settings in `.npmrc` are not used.

## Project layout

- `src/index.ts`: main entry point, bundled to `dist/index.js` for the Node platform.
  `node:` imports are rewritten to bare names for Joplin's plugin runtime.
- `src/manifest.json` and `package.json`: versions must match; the package name starts
  with `joplin-plugin-` and `keywords` includes `joplin-plugin`.
- `api/`: resolved through `tsconfig.json` `paths` (`api` and `api/*`).
- Other files in `src/` are copied to `dist/`, except TypeScript sources, `*.test.*` /
  `*.spec.*` files, and anything under `fixtures/` or `__tests__/` directories.

## Configuration

An optional `plugin.config.json` at the project root registers extra scripts and
overrides build options:

```json
{
    "extraScripts": ["contentScripts/codeMirror.ts"],
    "webviewScripts": ["dialog/dialog.ts"],
    "mainBuildOptions": { "external": ["jsdom"] },
    "contentScriptBuildOptions": { "sourcemap": "inline" },
    "webviewScriptBuildOptions": { "minify": false }
}
```

### Scripts

- `extraScripts`: content scripts registered with `joplin.contentScripts.register`
  (CodeMirror and Markdown-it plugins), relative to `src/`. Each is bundled for the browser
  as CommonJS to the same path under `dist/` with a `.js` extension. Joplin's CodeMirror
  and Lezer packages stay external so they share the host's instances.
- `webviewScripts`: scripts loaded into a dialog or panel with `addScript`, relative to
  `src/`. Each builds as a self-contained IIFE and must initialize itself. Plain `.js`
  files in `src/` are copied automatically and don't need listing.

Output paths must be unique (compared case-insensitively), and `dist/index.js` is
reserved for the main bundle.

### Build options

`mainBuildOptions`, `contentScriptBuildOptions`, and `webviewScriptBuildOptions` merge
esbuild options over the defaults for the main bundle, every content script, and every
webview script, respectively. Every bundle is minified, targets ES2020, and defines
`process.env.NODE_ENV` as `"production"`. The main bundle and content scripts are
CommonJS; webview scripts are IIFEs.

- `target`: the standard joplin plugin generator [targets ES2015](https://github.com/laurent22/joplin/blob/dev/packages/generator-joplin/generators/app/templates/tsconfig.json).
  To support older runtimes, override `target` for each bundle type (e.g. `"es2015"`).
  The build ignores `compilerOptions.target` in `tsconfig.json`. The
  [esbuild target](https://esbuild.github.io/api/#target) controls emitted syntax only; it
  does not polyfill newer APIs such as `Object.fromEntries`, so test on the Joplin versions
  and platforms you support.
- `alias`: relative targets resolve from the project root.
- `define`: entries merge individually, so `process.env.NODE_ENV` stays `"production"`
  unless overridden.
- `external`: content-script entries extend the CodeMirror and Lezer externals, which
  cannot be removed. Webview scripts cannot set `external`, because they have no runtime
  `require`.
- `sourcemap`: for debugging, prefer `"inline"`. Setting it to `true` writes `.js.map`
  files into `dist/` that ship in the `.jpl`.

Options that control inputs, outputs, and bundling mode (such as `entryPoints`, `outfile`,
`format`, `plugins`, and `bundle`) are reserved. Content and webview scripts also cannot
set `platform`.

## Migrating from the standard Webpack setup

### Resolve the Joplin API through TypeScript paths

Add these mappings to your existing `tsconfig.json` `compilerOptions` so `api` and
`api/types` imports resolve for both TypeScript and esbuild:

```json
{
    "compilerOptions": {
        "paths": {
            "api": ["./api/index.ts"],
            "api/*": ["./api/*"]
        }
    }
}
```

Remove `baseUrl` ([deprecated in TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#deprecated---baseurl))
and make all path targets relative to the declaring `tsconfig.json`. Add explicit
mappings for any other imports that relied on `baseUrl`.

### Align the TypeScript target with the build target

The generator's `tsconfig.json` sets `"target": "ES2015"`, while this build emits ES2020 by default
(see [Build options](#build-options)). To keep type checking in line with what ships, set
`compilerOptions.target` to `"ES2020"`, or lower each bundle type's build `target` to match.

### Translate Webpack overrides to esbuild options

`webpackOverrides` is not supported. Replace it in `plugin.config.json` with
equivalent esbuild options:

| Webpack setting         | esbuild equivalent                                     |
| ----------------------- | ------------------------------------------------------ |
| `resolve.alias`         | `mainBuildOptions.alias`, or suitable tsconfig `paths` |
| `devtool`               | `mainBuildOptions.sourcemap`                           |
| `optimization.minimize` | `mainBuildOptions.minify`                              |
| `externals`             | `mainBuildOptions.external`, using esbuild's syntax    |
| Loaders and plugins     | Require an equivalent approach; they cannot be reused  |

External packages remain runtime imports and are not included in the archive, so they
must be available in Joplin's plugin runtime.

The standard setup applies `webpackOverrides` to both main and content-script
builds. Here, `mainBuildOptions` affects only the main bundle. Move settings that
should also apply to content scripts into `contentScriptBuildOptions`.

## Testing a plugin's bundles

The package exports the same esbuild options the build uses, so plugin tests can build
in memory and run the result:

```js
import { createBuildOptions, readPluginConfig } from '@bwat47/joplin-plugin-scripts';
import { build } from 'esbuild';

const { mainBuildOptions } = await readPluginConfig(root);
const result = await build({ ...createBuildOptions(root, mainBuildOptions), write: false });
```

Also exported: `createContentScriptBuildOptions`, `createWebviewScriptBuildOptions`,
`contentScriptExternals`, and `PluginScriptsError` for expected configuration and validation errors.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run format
```

To try a change in a plugin before publishing, run `npm pack` here and
`npm install -D ../joplin-plugin-scripts/bwat47-joplin-plugin-scripts-<version>.tgz` in the plugin.

Release: bump `version`, then `npm publish --access public` (`prepublishOnly` runs type checking,
lint, format check, and tests; `prepack` then generates the declarations).
