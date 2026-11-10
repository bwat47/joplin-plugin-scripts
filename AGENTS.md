# AGENTS.md

Shared build, packaging, version, and API-update scripts for Joplin plugins, published to npm as
`@bwat47/joplin-plugin-scripts`. See `README.md` for usage and configuration.

## Layout

- `bin/joplin-plugin-scripts.mjs`: CLI entry point (what plugins mainly use).
- `lib/*.mjs`: implementation; `lib/index.mjs` is the public API for plugins' own build tests.
- `test/*.test.mjs`: one test file per `lib` module; shared fixtures in `test/helpers.mjs`.
- `types/`: generated `.d.mts` declarations (gitignored). Never edit by hand.

## Conventions

- Plain ESM JavaScript (`.mjs`), Node >= 22. Don't convert files to TypeScript. Types come from JSDoc
  annotations, which `tsc` checks in strict mode (`checkJs`), so keep them accurate.
- Tests use the built-in `node:test` runner and `node:assert`. Don't add another test framework.
- Expected, user-facing failures throw `PluginScriptsError` (`lib/errors.mjs`); the CLI prints
  those without a stack trace. Anything else counts as a bug and is rethrown.
- Formatting is Prettier (4 spaces, single quotes, 120 columns, sorted imports). Run
  `npm run format` instead of formatting by hand.
- This is a shared package used by several plugins: treat changes to CLI commands, config options,
  build output, or exports as breaking, and update `README.md` when behavior changes.

## Line endings

- All text files use LF. Don't manually repair incidental CRLF changes. Git normalizes text to LF when staging; Prettier also normalizes files when formatting.

## Git

- Commit messages follow Conventional Commits (`fix(updateVersion): ...`, `feat: ...`).
- GitHub credentials are stored in the OS keyring. If `gh auth status` fails inside the sandbox, retry it with escalated permissions before asking me to authenticate.

## Verify

Run before finishing a change (the same checks as `prepublishOnly`):

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

Don't bump the version or publish unless asked.
