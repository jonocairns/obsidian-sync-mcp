# Agent guidance

Non-obvious traps in this repo — things not evident from the file layout, `package.json` scripts, or README.

- **Commonlib is an external, exact-pinned npm dependency.** `src/commonlib-adapter.ts` uses its lower-level manager APIs for revision-checked writes and revision-pinned conflict reads. Keep `test/commonlib-contract.e2e.ts` passing when upgrading; changing imports alone loses concurrency guarantees. The application and Commonlib must resolve the same `octagonal-wheels` logger instance to suppress private paths.
- **PouchDB declarations merge a legacy global `Buffer`.** `typecheck/pouchdb-node.d.ts` preserves Node 24’s generic buffer and slice types; it is declaration-only. Do not replace the real Commonlib declarations with `any` shims.
- **`pnpm build` does not type-check.** tsup/esbuild strips types; a green build says nothing about type soundness. `pnpm typecheck` is the only type gate — run it before claiming a change compiles.
- **Releases are fully automated (Release Please + `cicd.yml`) — never do any of it by hand.** Don't bump `package.json` `version`, cut a `v*` tag, edit `CHANGELOG.md`, publish to npm/GHCR, or run `deploy/setup.sh` (Fly.io). The pre-push hook rejects a tag whose version ≠ `package.json`.
- **Fork-first.** `jonocairns/obsidian-sync-mcp` is the canonical release line; upstream acceptance is never a gate. Pull only focused upstream fixes, and don't let upstream reshape the roadmap.
