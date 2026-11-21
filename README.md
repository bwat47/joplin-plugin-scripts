# @bwat47/joplin-plugin-scripts

Build and package Joplin plugins with esbuild. Replaces the standard `generator-joplin` Webpack setup and reads esbuild options from `plugin.config.json`. The package manages the bundler and its dependencies, so each plugin only needs an npm script to invoke the build.

- [Installation](#installation)
- [Commands](#commands)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Migrating from the standard Webpack setup](#migrating-from-the-standard-webpack-setup)
- [Testing a plugin's bundles](#testing-a-plugins-bundles)
- [Development](#development)

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

esbuild does not check types, so the suggested `dist` script runs `tsc --noEmit` before building. This type-checking step requires TypeScript installed as a development dependency in your plugin project; it is not required by the build command itself.

## Commands

Commands run from the plugin project root, which npm scripts do automatically.

| Command          | Purpose                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `build`          | Validate, bundle, and package the plugin into `publish/`.                                                                  |
| `update-version` | Update versions in `package.json`, `src/manifest.json`, and `package-lock.json` (if present).                              |
| `update-api`     | Replace `api/` with the latest `generator-joplin` API and warn about category or content-script external list differences. |

Run `joplin-plugin-scripts --version` (or `-v`) to print the installed `@bwat47/joplin-plugin-scripts` version. Use `--help` (or `-h`) to show usage.

### `build`

`build [--dev] [--sourcemap] [--no-minify] [--analyze]` bundles the plugin, copies runtime assets from `src/` to `dist/`, and packages `publish/<id>.jpl` and `publish/<id>.json`. Validation and bundling run before `dist/` and `publish/` are cleared, so failed builds leave previous outputs untouched. On success, it prints the archive path and version, e.g. `Created publish/com.example.plugin.jpl (v1.2.3).` (with a mode tag such as `, dev` when debug flags are active).

Flags can be combined in any order (pass them through npm with `--`, e.g. `npm run dist -- --dev`):

- `--dev`: disables minification, emits inline sourcemaps for all bundles, and changes the default `process.env.NODE_ENV` from `"production"` to `"development"` (an explicit `define["process.env.NODE_ENV"]` in `plugin.config.json` still takes precedence).
- `--sourcemap`: emits inline sourcemaps for all bundles, overriding `plugin.config.json`.
- `--no-minify`: disables minification for all bundles, overriding `plugin.config.json`.
- `--analyze`: prints esbuild's bundle-size breakdown for the main bundle and any `extraScripts` or `webviewScripts`. This covers esbuild-bundled outputs, not copied runtime assets.

License handling:

- Generates `dist/THIRD-PARTY-LICENSES.txt` when any bundled third-party package includes a standalone license or notice file.
- `THIRD-PARTY-LICENSES.txt` is reserved: the build fails if `src/` contains a file or directory with that name (in any letter case) that would be copied.

### `update-version`

`update-version [patch|minor|major|<x.y.z>]` defaults to a patch increment. `minor` and `major` increment that part and reset the parts after it (`1.3.7` → `1.4.0` for `minor`). An explicit `x.y.z` version must be higher than the current one. Pass arguments through npm with `--`:

```sh
npm run updateVersion          # Increment the patch version
npm run updateVersion -- minor # Increment the minor version
npm run updateVersion -- 2.0.0 # Set an explicit higher version
```

### `update-api`

Run `update-api` from the plugin project root. Before contacting the registry, it checks that `package.json` includes `joplin-plugin` in its `keywords` array and that `src/manifest.json` contains a valid plugin `id`.

Downloads `generator-joplin` directly from the registry in `npm_config_registry` (set by npm scripts), or `registry.npmjs.org`, and verifies its integrity hash. npm itself is not needed; registry authentication and proxy settings in `.npmrc` are not used.

## Project layout

- `src/index.ts`: main entry point, bundled to `dist/index.js`.
- `src/manifest.json`: Joplin plugin metadata.
- `package.json`: npm package metadata and scripts.
- `api/`: resolved through `tsconfig.json` `paths` (`api` and `api/*`).

### Asset copying

Other files in `src/` are copied to `dist/` (only directories containing a copied file are created), skipping:

- TypeScript and JSX sources
- Scripts listed in `extraScripts` or `webviewScripts`
- JavaScript test and benchmark files (`*.test.js`, `*.spec.js`, and `*.bench.js`, including `.mjs` and `.cjs`)
- Anything under `fixtures/`, `__tests__/`, `__benchmarks__/`, `__mocks__/`, `__fixtures__/`, or `__snapshots__/`
- Paths listed in [`excludeAssets`](#excluded-assets)
- Dotfiles and dot-directories (e.g. `.DS_Store`)

Symlinks in `src/` are followed: their targets are copied as regular files and directories, so shared assets can be linked in. Broken links are skipped.

Generated bundle files (bundles, imported CSS, sourcemaps, and `file`-loader assets) replace runtime assets at the exact same `dist/` path, except `manifest.json`. To keep archives portable across Windows, macOS, and Linux, the build fails on conflicting `dist/` paths (including case-only, Unicode-equivalent, file/directory, or differing multi-bundle outputs), bundle outputs outside `dist/`, or names Windows cannot extract. Rename the conflicting asset or add it to [`excludeAssets`](#excluded-assets).

### Project requirements

- `src/manifest.json` and `package.json` must each contain a JSON object with a non-empty string `version`, and the versions must match.
- The package name must start with `joplin-plugin-`, and `keywords` must be an array that includes `joplin-plugin`.
- The manifest `id` must be a string. If present, `categories` must be an array of strings, and `screenshots` must be an array of objects with a string `src`.
- A local screenshot `src` (anything other than an `http://` or `https://` URL) must be a relative path to a `.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp` file (any letter case) of at most 1 MB. It must stay inside the project root after resolving symlinks.

## Configuration

An optional `plugin.config.json` at the project root registers extra scripts and overrides build options:

```json
{
    "extraScripts": ["contentScripts/codeMirror.ts"],
    "webviewScripts": ["dialog/dialog.ts"],
    "excludeAssets": ["testing", "contentScript/testing"],
    "buildOptions": { "target": "es2015" },
    "mainBuildOptions": { "external": ["jsdom"] },
    "contentScriptBuildOptions": { "sourcemap": "inline" },
    "webviewScriptBuildOptions": { "minify": false }
}
```

### Scripts

- `extraScripts`: content scripts registered with `joplin.contentScripts.register` (CodeMirror and Markdown-it plugins), relative to `src/`.
- `webviewScripts`: scripts loaded into a dialog or panel with `addScript`, relative to `src/`. Each must initialize itself. Plain `.js`, `.mjs`, and `.cjs` files in `src/` are copied automatically and don't need listing if they already work as standalone scripts. List them here if they need dependency bundling or syntax transformation.

Both lists accept `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, and `.tsx` files. Each listed script builds to the same path under `dist/` with a `.js` extension. Output paths must be unique (case-insensitively and across Unicode normalizations), and `dist/index.js` is reserved for the main bundle. Script and `excludeAssets` paths accept `/` or `\` separators on all platforms and are normalized to `/`.

### Excluded assets

`excludeAssets` lists file or directory paths relative to `src/` to skip when copying runtime assets to `dist/` (e.g. `["testing", "contentScript/testing", "testUtils"]`). Each entry matches that exact path and anything inside it. `manifest.json` cannot be excluded.

### Build options

`buildOptions` sets shared esbuild options for all bundles. `mainBuildOptions`, `contentScriptBuildOptions`, and `webviewScriptBuildOptions` override those settings for their respective bundle types.

By default, bundles are minified, target ES2020, and define `process.env.NODE_ENV` as `"production"`.

| Bundle                            | Options key                 | Default platform | Format              | Default externals                                                     |
| --------------------------------- | --------------------------- | ---------------- | ------------------- | --------------------------------------------------------------------- |
| Main                              | `mainBuildOptions`          | `node`           | CommonJS            | None                                                                  |
| Content script (`extraScripts`)   | `contentScriptBuildOptions` | `browser`        | CommonJS            | Joplin's CodeMirror and Lezer packages, to share the host's instances |
| Webview script (`webviewScripts`) | `webviewScriptBuildOptions` | `browser`        | Self-contained IIFE | None                                                                  |

- `target`: to support older runtimes, set `target` in `buildOptions` (e.g. `"es2015"`). The build ignores `compilerOptions.target` in `tsconfig.json`. The [esbuild target](https://esbuild.github.io/api/#target) controls emitted syntax only; it does not polyfill newer APIs such as `Object.fromEntries`, so test on the Joplin versions and platforms you support.
- `alias`: relative targets resolve from the project root.
- `define`: `process.env.NODE_ENV` stays `"production"` unless overridden, because `define` entries merge (see [Option merging](#option-merging)).
- `external`: desktop-only plugins can list Node built-ins in `contentScriptBuildOptions.external` (e.g. `["fs"]`) to keep them as runtime `require` calls.
- `platform`: plugins that target mobile can set `"platform": "browser"` in `mainBuildOptions` so unresolved Node built-in imports fail the build and dependency resolution prefers browser entry points where provided. Content Scripts default to `"platform": "browser"`, Desktop-only plugins can set `"platform": "node"` in `contentScriptBuildOptions` to match the joplin generator and prefer Node entry points during dependency resolution.
- `sourcemap`: for debugging, prefer `"inline"`. Setting it to `true` writes `.js.map` files into `dist/` that ship in the `.jpl`.

#### Option merging

Map-style options (`define`, `alias`, `loader`, `banner`, `footer`, and `supported`) merge entry by entry across the defaults, `buildOptions`, and each bundle type's options, so a bundle type can add or override entries without dropping the shared ones. An inherited entry can be replaced but not removed. All other options, including arrays, replace the shared value.

#### Restrictions

- All option groups reserve `absWorkingDir`, `entryPoints`, `outfile`, `outdir`, `write`, `format`, `plugins`, `bundle`, and `packages`.
- `buildOptions` and `webviewScriptBuildOptions` cannot set `platform` or `external`. Webview scripts always use `browser` and bundle all dependencies because they have no runtime `require`.
- `contentScriptBuildOptions.external` extends the CodeMirror and Lezer externals; those defaults cannot be removed.

## Migrating from the standard Webpack setup

1. Follow [Installation](#installation) to install the package and replace the npm scripts.
2. Add the [Joplin API path mappings](#resolve-the-joplin-api-through-typescript-paths).
3. Align the TypeScript and build targets so type checking matches what ships: set `compilerOptions.target` to `"ES2020"` to match this build's default, or lower `buildOptions.target` to match your existing TypeScript target (see [Build options](#build-options)).
4. [Translate any Webpack overrides, loaders, or plugins](#translate-webpack-overrides-to-esbuild-options).
5. Run `npm run dist` and test the plugin in Joplin. Once the migration succeeds, remove the obsolete Webpack configuration, scripts, and development dependencies that your project no longer uses.

### Resolve the Joplin API through TypeScript paths

Add these mappings to your existing `tsconfig.json` `compilerOptions` so `api` and `api/types` imports resolve for both TypeScript and esbuild:

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

Remove `baseUrl` ([deprecated in TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#deprecated---baseurl)) and make all path targets relative to the declaring `tsconfig.json`. Add explicit mappings for any other imports that relied on `baseUrl`.

### Translate Webpack overrides to esbuild options

`webpackOverrides` is not supported. Replace it in `plugin.config.json` with equivalent esbuild options:

| Webpack setting         | esbuild equivalent                                    |
| ----------------------- | ----------------------------------------------------- |
| `resolve.alias`         | `buildOptions.alias`, or suitable tsconfig `paths`    |
| `devtool`               | `buildOptions.sourcemap`                              |
| `optimization.minimize` | `buildOptions.minify`                                 |
| `externals`             | `mainBuildOptions.external`, using esbuild's syntax   |
| Loaders and plugins     | Require an equivalent approach; they cannot be reused |

External packages remain runtime imports and are not included in the archive, so they must be available in Joplin's plugin runtime.

esbuild handles TypeScript, JSX, CSS, and JSON imports itself, and the `loader` option covers raw text and binary assets (e.g. `{ ".svg": "text", ".woff2": "dataurl" }`). Note these differences from common Webpack setups:

- A bundle that imports CSS writes it to a `.css` file next to the bundle, e.g. `dist/dialog/dialog.css`, instead of injecting it like `style-loader`. Load it in the dialog or panel with `addScript`.
- Imported non-TypeScript assets in `src/` (such as `.css`, `.json`, or `loader`-handled files) are still copied to `dist/` by [Asset copying](#asset-copying); add them to [`excludeAssets`](#excluded-assets) if they are only used through imports.
- esbuild plugins cannot be configured. For Sass, Tailwind, or similar tools, run the tool before the build and write its output into `src/` (and add that output to `.gitignore`). The build then copies the output to `dist/`. Output written directly to `dist/` is deleted.

See [Build options](#build-options) for shared and per-bundle settings and restrictions.

## Testing a plugin's bundles

The package exports the same esbuild options the build uses, so plugin tests can build bundles in memory. Run this example from the plugin project root:

```js
import { createBuildOptions, readPluginConfig } from '@bwat47/joplin-plugin-scripts';
import { build } from 'esbuild';

const root = process.cwd(); // Absolute path to the plugin project root.
const { mainBuildOptions } = await readPluginConfig(root);
const result = await build({ ...createBuildOptions(root, mainBuildOptions), write: false });
```

Additional exports:

- `createContentScriptBuildOptions`
- `createWebviewScriptBuildOptions`
- `contentScriptExternals`
- `PluginScriptsError` (for expected configuration and validation errors)

The `create*BuildOptions` functions always keep their own entry point, output file, format, and bundling. They do not check the other reserved options, which `readPluginConfig` rejects, so options such as `write: false` can be passed for in-memory builds.

## Development

```sh
npm test
npm run typecheck
npm run lint            # Oxlint, plus fallow dead-code and complexity checks
npm run format
```

To try a change in a plugin before publishing, run `npm pack` here and `npm install -D ../joplin-plugin-scripts/bwat47-joplin-plugin-scripts-<version>.tgz` in the plugin.
