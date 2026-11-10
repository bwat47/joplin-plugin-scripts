# @bwat47/joplin-plugin-scripts

Shared build tooling for Joplin plugins: an esbuild-based replacement for the
generator-joplin Webpack config and its scripts.

## Installation

Requires Node.js 22+. The scripts run as JavaScript and do not require TypeScript.

```sh
npm install -D @bwat47/joplin-plugin-scripts
```

Add or replace these scripts in your plugin's `package.json`:

```json
"scripts": {
    "typecheck": "tsc --noEmit",
    "dist": "npm run typecheck && joplin-plugin-scripts build",
    "updateVersion": "joplin-plugin-scripts update-version",
    "updateApi": "joplin-plugin-scripts update-api"
}
```

esbuild does not check types, so the suggested `dist` script runs `tsc --noEmit` before
building. This type-checking step requires TypeScript installed as a development
dependency in your plugin project; it is not required by the build command itself.

## Commands

Commands run from the plugin project root, which npm scripts do automatically.

- `build`: validates the project, clears `dist/` and `publish/`, copies runtime assets
  from `src/`, bundles, and writes `publish/<id>.jpl` and `<id>.json`.
- `update-version [patch|minor|major|<x.y.z>]`: updates the version across
  `package.json`, `src/manifest.json`, and `package-lock.json`. With no argument it
  increments the patch version; `minor` and `major` increment that part and reset the
  parts after it (`1.3.7` → `1.4.0`); an explicit `x.y.z` version must be higher than
  the current one. Pass the argument through npm with `--`, e.g.
  `npm run updateVersion -- minor`.
- `update-api`: replaces `api/` with the latest generator-joplin API, and warns if this
  package's category or content-script external lists differ from the generator's.

`update-api` downloads generator-joplin directly from the registry in
`npm_config_registry` (set by npm scripts), or registry.npmjs.org, and verifies its
integrity hash. npm itself is not needed; registry authentication and proxy settings
in `.npmrc` are not used.

## Project layout

- `src/index.ts`: main entry point, bundled to `dist/index.js` for the Node platform.
  `node:` imports are rewritten to bare names for Joplin's plugin runtime.
- `src/manifest.json` and `package.json`: versions must match; the package name starts
  with `joplin-plugin-` and `keywords` includes `joplin-plugin`.
- `api/`: resolved through `tsconfig.json` `paths` (`api` and `api/*`).
- Other files in `src/` are copied to `dist/`, except TypeScript and JSX sources, `*.test.*` /
  `*.spec.*` files, and anything under `fixtures/` or `__tests__/` directories.

## Configuration

An optional `plugin.config.json` at the project root registers extra scripts and
overrides build options:

```json
{
    "extraScripts": ["contentScripts/codeMirror.ts"],
    "webviewScripts": ["dialog/dialog.ts"],
    "buildOptions": { "target": "es2015" },
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
  files in `src/` are copied automatically and don't need listing if they already work
  as standalone scripts. List them here if they need dependency bundling or syntax
  transformation.

Output paths must be unique (compared case-insensitively), and `dist/index.js` is
reserved for the main bundle.

### Build options

`buildOptions` sets shared esbuild options for all bundles.
`mainBuildOptions`, `contentScriptBuildOptions`, and `webviewScriptBuildOptions`
override those settings for their respective bundle types.

By default, bundles are minified, target ES2020, and define
`process.env.NODE_ENV` as `"production"`. The main bundle uses CommonJS;
see [Scripts](#scripts) for content-script and webview-script formats.

`platform` and `external` cannot be set in `buildOptions`.
Restrictions for individual bundle types are described below.

- `target`: to support older runtimes, set `target` in `buildOptions` (e.g. `"es2015"`).
  The build ignores `compilerOptions.target` in `tsconfig.json`. The
  [esbuild target](https://esbuild.github.io/api/#target) controls emitted syntax only; it
  does not polyfill newer APIs such as `Object.fromEntries`, so test on the Joplin versions
  and platforms you support.
- `alias`: relative targets resolve from the project root.
- `define`: `process.env.NODE_ENV` stays `"production"` unless overridden, because
  `define` entries merge (see below).
- `external`: content-script entries extend the CodeMirror and Lezer externals, which
  cannot be removed. Webview scripts cannot set `external`, because they have no runtime
  `require`.
- `sourcemap`: for debugging, prefer `"inline"`. Setting it to `true` writes `.js.map`
  files into `dist/` that ship in the `.jpl`.

Map-style options (`define`, `alias`, `loader`, `banner`, `footer`, and `supported`) merge
entry by entry across the defaults, `buildOptions`, and each bundle type's options, so a bundle
type can add or override entries without dropping the shared ones. An inherited entry can be
replaced but not removed. All other options, including arrays, replace the shared value.

Options that control inputs, outputs, and bundling mode (such as `entryPoints`, `outfile`,
`format`, `plugins`, and `bundle`) are reserved. Content and webview scripts also cannot
set `platform`.

## Migrating from the standard Webpack setup

1. Follow [Installation](#installation) to install the package and replace the npm scripts.
2. Add the [Joplin API path mappings](#resolve-the-joplin-api-through-typescript-paths)
   and [align the TypeScript target](#align-the-typescript-target-with-the-build-target).
3. [Translate any Webpack overrides](#translate-webpack-overrides-to-esbuild-options).
4. Run `npm run dist` and test the plugin in Joplin. Once the migration succeeds,
   remove the obsolete Webpack configuration, scripts, and development dependencies
   that your project no longer uses.

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

The generator's `tsconfig.json` [targets ES2015](https://github.com/laurent22/joplin/blob/dev/packages/generator-joplin/generators/app/templates/tsconfig.json), while this build emits ES2020 by default
(see [Build options](#build-options)). To keep type checking in line with what ships, set
`compilerOptions.target` to `"ES2020"`, or lower the build `target` in `buildOptions` to match.

### Translate Webpack overrides to esbuild options

`webpackOverrides` is not supported. Replace it in `plugin.config.json` with
equivalent esbuild options:

| Webpack setting         | esbuild equivalent                                    |
| ----------------------- | ----------------------------------------------------- |
| `resolve.alias`         | `buildOptions.alias`, or suitable tsconfig `paths`    |
| `devtool`               | `buildOptions.sourcemap`                              |
| `optimization.minimize` | `buildOptions.minify`                                 |
| `externals`             | `mainBuildOptions.external`, using esbuild's syntax   |
| Loaders and plugins     | Require an equivalent approach; they cannot be reused |

External packages remain runtime imports and are not included in the archive, so they
must be available in Joplin's plugin runtime.

See [Build options](#build-options) for shared and per-bundle settings and restrictions.

## Testing a plugin's bundles

The package exports the same esbuild options the build uses, so plugin tests can build
bundles in memory. Run this example from the plugin project root:

```js
import { createBuildOptions, readPluginConfig } from '@bwat47/joplin-plugin-scripts';
import { build } from 'esbuild';

const root = process.cwd(); // Absolute path to the plugin project root.
const { mainBuildOptions } = await readPluginConfig(root);
const result = await build({ ...createBuildOptions(root, mainBuildOptions), write: false });
```

Also exported: `createContentScriptBuildOptions`, `createWebviewScriptBuildOptions`,
`contentScriptExternals`, and `PluginScriptsError` for expected configuration and validation errors.

The `create*BuildOptions` functions always keep their own entry point, output file, format, and
bundling, and the main bundle keeps its `node:` import rewrite. They do not check the other
reserved options, which `readPluginConfig` rejects, so options such as `write: false` can be
passed for in-memory builds.

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
