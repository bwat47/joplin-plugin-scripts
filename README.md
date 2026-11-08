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
| `update-version` | Increments the patch version across `package.json`, `src/manifest.json`, and `package-lock.json`.                                                |
| `update-api`     | Replaces `api/` with the latest generator-joplin API and warns if the category or content-script external lists here differ.                     |

### Expected project layout

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
    "mainBuildOptions": { "external": ["jsdom"] },
    "contentScriptBuildOptions": { "sourcemap": "inline" },
    "webviewScriptBuildOptions": { "minify": false }
}
```

- `extraScripts`: content scripts registered with `joplin.contentScripts.register`
  (CodeMirror and Markdown-it plugins), relative to `src/`. Each is bundled for the browser
  as CommonJS to the same path under `dist/` with a `.js` extension. Joplin's CodeMirror
  and Lezer packages stay external so they share the host's instances.
- `webviewScripts`: scripts loaded into a dialog or panel with `addScript`, relative to
  `src/`. Each builds as a self-contained IIFE and must initialize itself. Plain `.js`
  files in `src/` are copied automatically and don't need listing.

Script output paths must be unique after normalization. They are compared without case on
every platform, since the archive may be installed on a case-insensitive filesystem.
`dist/index.js` is reserved for the main bundle. Invalid paths and collisions are rejected
before existing build output is cleared.

#### Advanced build options

Each option group merges esbuild options over the defaults for its bundle type:

| Option group                | Applies to           |
| --------------------------- | -------------------- |
| `mainBuildOptions`          | Main bundle only     |
| `contentScriptBuildOptions` | Every content script |
| `webviewScriptBuildOptions` | Every webview script |

- Relative `alias` targets resolve from the project root.
- `define` entries merge individually, preserving `process.env.NODE_ENV` as
  `"production"` unless explicitly overridden.
- Reserved options: `absWorkingDir`, `entryPoints`, `outfile`, `outdir`, `write`,
  `format`, `plugins`, `bundle`, and `packages`. Content and webview scripts also
  cannot override `platform`.
- `external` keeps packages as runtime imports. Content-script entries extend the
  CodeMirror and Lezer externals, which cannot be removed. Webview scripts cannot
  set `external`, because they have no runtime `require`.
- For debugging, prefer `"sourcemap": "inline"`. Setting it to `true` writes `.js.map`
  files into `dist/` that ship in the `.jpl`.

### Migrating from the standard Webpack setup

#### Resolve the Joplin API through TypeScript paths

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

#### Run type checking separately

esbuild does not check types. Keep `tsc --noEmit` before the build, as shown in Usage.

#### Translate Webpack overrides to esbuild options

`webpackOverrides` is not supported. Replace it in `plugin.config.json` with
equivalent esbuild options:

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
builds. Here, `mainBuildOptions` affects only the main bundle. Move settings that
should also apply to content scripts into `contentScriptBuildOptions`.

### Testing a plugin's bundles

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
