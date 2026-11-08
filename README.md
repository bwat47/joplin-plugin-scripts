# @bwat47/joplin-plugin-scripts

Shared build tooling for Joplin plugins: an esbuild-based replacement for the
generator-joplin Webpack config and its scripts.

## Usage

```sh
npm install -D @bwat47/joplin-plugin-scripts
```

```json
"scripts": {
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
  `outfile`, and `outdir` cannot be overridden.

Script output paths must be unique after normalization. They are compared without case on
every platform, since the archive may be installed on a case-insensitive filesystem.
`dist/index.js` is reserved for the main bundle. Invalid paths and collisions are rejected
before existing build output is cleared.

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
npm run lint
npm run format
```

To try a change in a plugin before publishing, run `npm pack` here and
`npm install -D ../joplin-plugin-scripts/bwat47-joplin-plugin-scripts-<version>.tgz` in the plugin.

Release: bump `version`, then `npm publish --access public` (`prepublishOnly` runs lint,
format check, and tests).
