# Production Commonlib migration

Implemented on `codex/upstream-commonlib`, from
`c22cb2d2e29d4323d84c867755f2c4a2eb0050cc`. Prepared for pull-request review.
Verification date: 2026-09-09. Runtime: Node 24.19.0, pnpm 11.22.0.

## Implementation

- Exact `@vrtmrz/livesync-commonlib@0.1.23` in the main pnpm graph, with
  `octagonal-wheels@0.1.54` shared by the application and Commonlib.
- `src/commonlib-adapter.ts` delegates splitting, chunk IDs, chunk storage,
  encryption and decoding to upstream. Only final metadata commits and
  revision-consistent HTTP conflict snapshots are application-owned.
- Creates omit a base revision; replacements and soft deletions use the exact
  expected revision with ordinary CouchDB MVCC. Real 409s remain distinct from
  chunk failures. Reads decode at the conflict snapshot's exact revision.
- Removed the submodule, aliases, browser stubs, bundler rewrites, navigator
  polyfill, Commonlib-only direct dependencies, Commonlib any shims, and CI
  submodule checkout requirements. SQLite typing fixes are preserved.
- Editor and CLI checks share `tsconfig.json`; VS Code is pointed at the workspace TypeScript SDK.
- Real upstream declarations are used. `typecheck/pouchdb-node.d.ts` resolves
  PouchDB's legacy global Buffer merge with Node 24's generic backing-buffer and
  slice declarations. This does not change runtime code or erase library types.
- Promoted all 17 proof contracts into `pnpm test:couchdb`; added shared-logger
  redaction testing. CI now also tests a clean npm consumer, including executable
  installation, logger identity, application startup and health.

## Verification

| Check | Result |
| --- | --- |
| Frozen pnpm installation | Passed |
| Full `pnpm typecheck` | Passed against actual upstream declarations |
| `pnpm lint` | Passed |
| `pnpm build` | Passed |
| `pnpm test` | 226 passed, zero failed/skipped |
| `pnpm test:e2e` | 28 passed, zero failed/skipped |
| Existing CouchDB E2E | Passed |
| Commonlib contracts | 18 passed, zero failed/skipped |
| Clean packed pnpm consumer | Passed, offline production graph |
| Clean npm consumer | Passed, actual tarball install outside checkout |
| Shared logger privacy | Unit redaction check and both consumer identity checks passed |
| Docker | Root, MCP-only, and combined CouchDB image builds/health checks passed |
| ShellCheck / whitespace | Passed for the changed smoke script / diff |
| Upstream integrity | All 545 shipped files match the verified registry tarball |

The preceding agent's proof harness, plans, and original results are preserved
locally outside this changeset. Their historical success is not being substituted
for these production checks; the promoted contracts run through the ordinary
CouchDB test command. The old preparation script assumes pre-migration sources
and must not be applied to the migrated Vault.

The tarball integrity is
`sha512-hsaz2N04qNqM9HL0B+d5G/do1T0fe6Y4gVK3IueXvEnM6HM+3Jp17mdjbLn93FUOxkUVMcn4M+zIwPuppryVbw==`.
The only additional installed file is pnpm's generated
`node_modules/.bin/markdown-it` shim; upstream files are unmodified.

CouchDB checks used a new disposable local container and UUID-scoped synthetic
databases, with plaintext and encrypted/obfuscated configurations. No production
vault was accessed. Docker smoke containers were removed after their checks.
No deployment, publication, version bump, or release tag was performed.

## Release-age and advisory check

The user authorized exact-version age exceptions after an online release check.
The seven-day default remains unchanged; only the two reviewed versions were
added to `minimumReleaseAgeExclude`.

The npm metadata marks neither version deprecated. Exact-version OSV queries
returned no vulnerabilities, and the public GitHub advisory APIs returned no
published advisories for either repository. Recent issue/release listings and
web searches found no incident specific to these two releases. This is a quick
reported-issue check, not proof of safety or a security audit.

Sources checked:

- [Commonlib release](https://github.com/vrtmrz/livesync-commonlib/pull/137)
- [octagonal-wheels release](https://github.com/vrtmrz/fancy-kit/pull/54)
- [Commonlib advisories](https://github.com/vrtmrz/livesync-commonlib/security/advisories)
- [Fancy Kit advisories](https://github.com/vrtmrz/fancy-kit/security/advisories)
- [OSV query API](https://api.osv.dev/v1/query), using each exact npm package/version

The full production dependency audit reports six **moderate** advisories and no
high/critical findings. `pnpm audit --prod --audit-level=high` passes. These concern
`uuid@8.3.2`, `qs@6.15.2`, and `hono@4.13.2`, all already present in the baseline
lockfile. They remain dependency follow-up work; this migration does not claim to
remediate them. The findings are:

- [uuid buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
- [qs array-limit bypass](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
- [qs isBuffer denial of service](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)
- [Hono toSSG output path](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv)
- [Hono parseBody nesting](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)
- [Hono URL fragment parsing](https://github.com/advisories/GHSA-crvj-82cr-hjcx)

## Credentialed URL regression

The metadata fetch now removes URL userinfo before calling Node fetch, preserving
path prefixes and the explicit Authorization header. This matches PouchDB's
precedence for configured credentials. Five ordinary unit cases cover URL
normalization and segment encoding. A real CouchDB contract exercises legacy
write and versioned create/read/replace/move/delete with deliberately incorrect
embedded credentials and valid explicit credentials, with encryption enabled.
The credentialed unit cases and the CouchDB contract failed before the fix and
passed afterward. Typecheck, lint, build, all 226 unit tests, existing CouchDB
E2E, and all 18 contracts were rerun after this fix. HTTP, package, and Docker
results above are from the preceding migration verification.

## Remaining limits

Real Obsidian interoperability, historical encryption formats, and long-running
stability remain unverified. The native upstream reader/writer probe covers one
synthetic encrypted multi-chunk interchange, not a running Obsidian client.
Docker validation was on this host's architecture, not the release matrix.
The combined Dockerfile emitted its existing `InvalidDefaultArgInFrom` warning;
all three runtime health checks still passed. npm reported a blocked optional
`tldjs` postinstall; clean installation and startup passed without enabling it.
