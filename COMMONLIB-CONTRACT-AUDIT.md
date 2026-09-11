# Commonlib contract audit — 2026-09-11

Scope: the application's seam with the installed, exact-pinned
`@vrtmrz/livesync-commonlib@0.1.23`, not every feature in the library.
Source inspection was paired with real, disposable local CouchDB tests.
No production CouchDB or Obsidian vault was accessed for this audit.

Status: **all three findings fixed locally, not released or deployed**. The
original failure descriptions below record why the regressions exist; each
resolution describes the current implementation. Commonlib remains pinned to
0.1.23, with no edits to the installed dependency.

## Findings

### AUDIT-1: binary Markdown is decoded differently by reads and indexing

An encrypted `newnote` Markdown fixture reads correctly through
`Vault.readVersioned`, but `Vault.catchUp` emits its base64 representation.
`src/index-sync.ts:deriveContent` joins `data` without consulting
`type`/`datatype`; the versioned reader decodes binary chunks first.
The live watcher also uses this same content helper (source inspection;
the new reproduction exercises catch-up).

Impact: affected notes can be readable directly but unsearchable by their text.
This does not itself delete or rewrite the remote document. It is particularly
relevant to records written in the pre-PR-20 binary Markdown representation.

Resolution: `src/note-content.ts` supplies the shared byte decoder for direct
reads and index content. Both catch-up and live-watch binary/legacy fixtures
now emit the original Unicode text, not base64.

### AUDIT-2: metadata-free CouchDB tombstones do not remove indexed entries

The reproduction indexes a note, deletes it using CouchDB's document DELETE,
and resumes catch-up from the saved checkpoint. CouchDB returns a deletion
record without `path`, but catch-up emits no removal event and advances past
it. Direct reads and recreation correctly return `RESTORE_REQUIRED`.

Cause: catch-up depends on surviving path metadata before loading the entry.
An obfuscated document ID alone cannot be reversed into the original path.
The original Mango `type != leaf` selector also excluded missing `type`
fields entirely; adding explicit `_deleted: true` matching was necessary.
The native watcher's `isNoteEntry` also excludes tombstones without a note
`type` (source inspection, not a new live-watch reproduction).

Impact: an already-deleted note can remain in the persistent search index.
This is a failure to observe deletion, not a mechanism creating tombstones.
Normal LiveSync `deleted: true` records retaining metadata passed the feed test.

Resolution: use a tombstone-inclusive selector and retain document-ID-to-path
identity from handled notes and persisted index paths supplied at startup.
The live feed consults current index paths for unknown IDs too, covering tool
writes whose creation event was coalesced away before it was observed.
Catch-up and live watch share the same change handler. Unknown tombstones
with no indexed path require no removal; known ones remove their index entries.

`src/ordered-change-feed.ts` serializes asynchronous live processing and retries
from the last successfully handled sequence after failures. Failed decoding
no longer silently advances the catch-up checkpoint. Removal mappings survive
failed index callbacks, and case-alias removals checkpoint only on the final
callback. Shutdown drains active processing before closing the index.

### AUDIT-3: path-based reads silently empty legacy inline records

A `type: "notes"` fixture with inline base64 `data` is decoded correctly from
Commonlib's metadata-based loaded entry. The application's versioned path read
instead succeeds with an empty body.

In Commonlib's `EntryManagerImpls.js`, `getDBEntryMetaByPath` substitutes
`data: ""`, `type: "plain"`, and empty children for legacy records. Its later
`getDBEntryFromMeta` call therefore cannot take the legacy decoding branch.
The adapter's revision-pinned `getDBEntry` call uses this path.

Impact: silent read truncation for that legacy representation. A subsequent
move could copy the empty body and delete the source; that consequence follows
from the application's move implementation, not from a destructive reproduction.
The audit does not establish whether any production records use this format.

Resolution: load the exact revision with Commonlib's decrypted `getRaw` and
`getDBEntryFromMeta`, bypassing the lossy path-based metadata projection.
Authoritative reads and metadata reads now preserve legacy content. The
regression also moves a legacy note and verifies its complete destination body
before checking that the source requires restoration.

## Field and behavior coverage

| Seam | Evidence / outcome |
| --- | --- |
| `_rev`, revision-pinned bytes | Existing real-CouchDB read-race test passes. |
| `_conflicts`, `_deleted_conflicts` | Existing deleted-sibling test passes with the preceding local fix: deleted siblings change the version but do not block mutation. PouchDB still omits `_deleted_conflicts`; the adapter's HTTP metadata read is necessary. Genuine live-conflict refusal is covered by the separate obfuscation suite. |
| `deleted`, `_deleted` | Soft-delete feed removal and hard-tombstone read/recreate refusal pass in both modes. Metadata-free removals now pass during catch-up, restart and live watch. |
| `_id`, `path`, case handling | New tests pass for Unicode paths, listing identity, case-insensitive ID equivalence, and refusing creation through a case alias, in both modes. |
| `ctime`, `mtime`, `size` | New tests pass for exact native metadata readback, preserving ctime on replacement, and Unicode UTF-8 size / empty size, in both modes. |
| `type`, `datatype`, `data` | Native text, empty/multi-chunk interoperability, binary indexing and legacy inline loading pass. Blob MIME, not the nominal type argument, controls the write representation. |
| `children`, `eden` | New tests pass for inline-only Eden chunks, order and repeated child IDs in both modes. Existing large-file tests cover separately stored chunks. |
| Chunk-write return value | Existing injected `result: false` test prevents publication of file metadata. |
| Write/delete return values and CAS | Existing real interleaving tests pass: stale operations preserve the competing writer in both modes; false return versus thrown 409 is accounted for. |
| Move effects | Existing partial-move test preserves a concurrently changed source and reports the completed destination effect. Moves are not atomic. |
| Change sequences | Checkpoint/watch/restart tests pass, including hard deletion, failed loads and failed removals. Unit tests cover ordered processing, handler failures, transport retries and shutdown. |
| Encryption / connection options | Existing credential-override and native interoperability tests pass; new positive cases run with and without encryption/path obfuscation. Writes keep Eden/compression disabled. |

## Limits and remaining checks

- This is not an exhaustive Commonlib compatibility certification. It tests
  consumed properties and representative states, not all combinations.
- Numeric metadata is trusted and only nullish values receive defaults. This
  audit verifies valid metadata roundtrips, not rejection of malformed numbers
  or agreement with misleading stored sizes.
- Compression, hot packs, genuinely missing/corrupt chunks, untyped legacy
  documents and contradictory deletion flags need further fixtures.
- Failed entry loading is now covered with an injected failure. Library-level
  missing-chunk delivery timeouts and decryption-failure recovery remain outside
  that fixture's scope.
- The advertised CAS guarantee is **winner revision**, not an atomic compare of
  the whole revision tree. A new sibling arriving after precheck need not change
  the winner. The audit does not strengthen that guarantee.
- No claim is made about affected production files or client versions from these
  synthetic fixtures.

## Reproduction and result

Use an isolated CouchDB on `localhost:5985`, credentials `admin` / `test`, and
the CI-pinned CouchDB 3 image. Tests create and remove UUID-owned databases.
Never point these commands at the production vault database/server.

```sh
node --import tsx --test --test-timeout=120000 \
  --test-name-pattern='seam audit:' test/commonlib-contract.e2e.ts
node --import tsx --test --test-timeout=120000 test/commonlib-contract.e2e.ts
```

Original audit: **27 passing contracts and 3 reproduced failures**. After fixes:
**35 passing contracts, no TODOs or skips**, plus **228 passing unit tests** and
**34 passing HTTP/MCP tests**. All former TODO assertions are now required gates.

The separate `test/couchdb-obfuscation.e2e.ts` suite, project TypeScript check
(`tsc -p tsconfig.json`), build, lint and `git diff --check` also passed. The project
TypeScript configuration covers source/declarations, not E2E test files;
those tests were verified by execution.

## Existing index migration

The local search-index schema/content version is now 3. Opening a v2 cache
preserves it as a `.schema-v2-<timestamp>.bak` file and starts a fresh index with
an empty checkpoint. This ensures previously indexed base64 bodies, empty legacy
entries and missed tombstones are not carried forward merely because the remote
documents have not changed. A regression verifies the rebuild and backup.
This changes only derived local cache data; it does not rewrite remote notes,
restore tombstones, bump the application release version, or deploy anything.
