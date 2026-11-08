# @bwat47/joplin-plugin-scripts

Shared build tooling for Joplin plugins: an esbuild-based replacement for the
generator-joplin Webpack config and its scripts.

## Usage

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

Commands run from the plugin project root, which npm scripts do automatically.

| Command          | What it does                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`          | Validates the project, clears `dist/` and `publish/`, copies runtime assets from `src/`, bundles, and writes `publish/<id>.jpl` and `<id>.json`. |
| `update-version` | Increments the patch version in `package.json`, `src/manifest.json`, and `package-lock.json` together, or writes nothing.                        |
| `update-api`     | Replaces `api/` with the latest generator-joplin API and warns if the category or content-script external lists here differ.                     |

### Project layout expected

- `src/index.ts`: main entry point, bundled to `dist/index.js` for the Node platform.
  `node:` imports are rewritten to bare names for Joplin's plugin runtime.
- `src/manifest.json` and `package.json`: versions must match; the package name starts
  with `joplin-plugin-` and `keywords` includes `joplin-plugin`.
- `api/`: resolved through `tsconfig.json` `paths` (`api` and `api/*`).
- Other files in `src/` are copied to `dist/`, except TypeScript sources, `*.test.*` /
  `*.spec.*` files, and anything under `fixtures/` or `__tests__/` directories.

### `plugin.config.json` (optional)

```json
{
    "extraScripts": ["contentScripts/codeMirror.ts"],
    "webviewScripts": ["dialog/dialog.ts"],
    "mainBuildOptions": { "external": ["jsdom"] }
}
```

- `extraScripts`: content scripts registered with `joplin.contentScripts.register`
  (CodeMirror and Markdown-it plugins), relative to `src/`. Each is bundled for the browser
  as CommonJS to the same path under `dist/` with a `.js` extension. Joplin's CodeMirror
  and Lezer packages stay external so they share the host's instances.
- `webviewScripts`: scripts loaded into a dialog or panel with `addScript`, relative to
  `src/`. A webview loads them as plain `<script>` tags with no `module`, `exports`, or
  `require`, so each is bundled as a self-contained IIFE with nothing external. Exports
  are dropped, so the script must start itself, e.g. by calling its init function at the
  top level. Plain `.js` files in `src/` are copied as-is and don't need listing.
- `mainBuildOptions`: esbuild options merged over the main bundle's defaults. Relative
  `alias` targets resolve from the project root. `absWorkingDir`, `entryPoints`,
  `outfile`, `outdir`, `write`, `format`, and `plugins` cannot be overridden: packaging
  needs the bundle on disk, Joplin loads it as CommonJS, and the build's own esbuild
  plugin rewrites `node:` imports.
  `define` entries merge individually with the defaults, preserving
  `process.env.NODE_ENV` as `"production"` unless explicitly overridden.

Script output paths must be unique after normalization. They are compared without case on
every platform, since the archive may be installed on a case-insensitive filesystem.
`dist/index.js` is reserved for the main bundle. Invalid paths and collisions are rejected
before existing build output is cleared.

### Migrating from the standard Webpack setup

#### Resolve the Joplin API through TypeScript paths

The standard Webpack config aliases `api` to the project's `api/` directory. This
package instead reads the mappings in `tsconfig.json`. Add these entries to your
existing `compilerOptions` so imports such as `api` and `api/types` resolve for both
TypeScript and esbuild:

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

For TypeScript 6 and newer, use explicit `paths` mappings for these API imports
regardless of which bundler you use: [`baseUrl` is deprecated in TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#deprecated---baseurl).
Remove `baseUrl` when migrating, and make any other path targets relative to the
`tsconfig.json` that declares them. If other imports also rely on `baseUrl`, add
explicit mappings for those too.

Most existing Joplin plugins would need to add these mappings: the
[standard plugin template](https://github.com/laurent22/joplin/blob/dev/packages/generator-joplin/generators/app/templates/tsconfig.json)
uses `baseUrl: "."` without `paths`, and existing generated projects commonly use an
older TypeScript version. The mappings are therefore part of migrating to modern
TypeScript as well as configuring this build package.

#### Run type checking separately

The standard Webpack setup uses `ts-loader` to compile and check TypeScript.
esbuild transpiles and bundles TypeScript without checking types, so
`joplin-plugin-scripts build` alone can succeed even when the source has type errors.
Keep the separate `typecheck` step shown in the usage example. `tsc --noEmit` checks
the project without writing JavaScript into `dist/`.

When comparing build times, compare the complete `dist` commands so both include
type checking.

#### Translate Webpack overrides to esbuild options

`webpackOverrides` is not supported. Replace it in `plugin.config.json` with
equivalent esbuild options under `mainBuildOptions`. For example, Webpack's
`devtool: "source-map"` and `optimization.minimize: false` become:

```json
{
    "mainBuildOptions": {
        "sourcemap": true,
        "minify": false
    }
}
```

| Webpack setting         | esbuild equivalent                                     |
| ----------------------- | ------------------------------------------------------ |
| `resolve.alias`         | `mainBuildOptions.alias`, or suitable tsconfig `paths` |
| `devtool`               | `mainBuildOptions.sourcemap`                           |
| `optimization.minimize` | `mainBuildOptions.minify`                              |
| `externals`             | `mainBuildOptions.external`, using esbuild's syntax    |
| Loaders and plugins     | Require an equivalent approach; they cannot be reused  |

External dependencies remain runtime imports and must be available in Joplin's
plugin runtime; marking a package external does not include it in the archive.

The standard setup applies `webpackOverrides` to both main and content-script
builds. Here, `mainBuildOptions` affects only the main bundle; content scripts and
webview scripts use the fixed options described above. Review any customizations
that previously affected those scripts before migrating.

### Testing a plugin's bundles

The package exports the same esbuild options the build uses, so plugin tests can build
in memory and run the result:

```js
import { createBuildOptions, createContentScriptBuildOptions, readPluginConfig } from '@bwat47/joplin-plugin-scripts';

const { mainBuildOptions } = await readPluginConfig(root);
const result = await build({ ...createBuildOptions(root, mainBuildOptions), write: false });
```

`createWebviewScriptBuildOptions` and `contentScriptExternals` are also exported.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run format
```

To try a change in a plugin before publishing, run `npm pack` here and
`npm install -D ../joplin-plugin-scripts/bwat47-joplin-plugin-scripts-<version>.tgz` in the plugin.

JavaScript in `lib/`, `bin/`, and `test/` is checked with TypeScript in strict mode using
JSDoc annotations. Type checking emits no files; the scripts still run directly in Node.
`npm run build:types` generates `.d.mts` declarations for `lib/` into `types/` (git-ignored), so
plugins importing the public API get types; `npm pack` and `npm publish` run it via `prepack`.

Release: bump `version`, then `npm publish --access public` (`prepublishOnly` runs type checking,
lint, format check, and tests; `prepack` then generates the declarations).
