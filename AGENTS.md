# Agent guidance

Non-obvious traps in this repo — things not evident from the file layout, `package.json` scripts, or README.

- **`lib/livesync-commonlib` is a git submodule reached via the `@lib/*` alias.** `build`, `test`, and `dev` resolve `@lib/*` from the submodule on disk (via tsconfig `paths`), so if one of them can't find `@lib/...` the submodule isn't initialized (`git submodule update --init --recursive`) — it's not a broken import. (`typecheck` resolves `@lib/*` through ambient shims in `typecheck/shims.d.ts` and doesn't need the submodule.)
- **`pnpm build` does not type-check.** tsup/esbuild strips types; a green build says nothing about type soundness. `pnpm typecheck` is the only type gate — run it before claiming a change compiles.
- **`pnpm typecheck` treats the submodule as an opaque `any` boundary** (`typecheck/shims.d.ts`). Don't try to make `lib/livesync-commonlib` itself type-check. When you add a new `@lib/*` import used in *type* position, add an `any` export to the shim or you'll get TS2709.
- **tsup rewrites some imports at bundle time** (`tsup.config.ts`): `pouchdb-browser`→`pouchdb-http`, `svelte`→stub, `bgWorker`→mock. Code that bundles cleanly may not resolve under plain `tsc`/`tsx`, and vice versa.
- **Releases are fully automated (Release Please + `cicd.yml`) — never do any of it by hand.** Don't bump `package.json` `version`, cut a `v*` tag, edit `CHANGELOG.md`, publish to npm/GHCR, or run `deploy/setup.sh` (Fly.io). The pre-push hook rejects a tag whose version ≠ `package.json`.
- **Fork-first.** `jonocairns/obsidian-sync-mcp` is the canonical release line; upstream acceptance is never a gate. Pull only focused upstream fixes, and don't let upstream reshape the roadmap.
