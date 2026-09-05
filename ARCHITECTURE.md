# Architecture

## Overview

```
Obsidian (phone/desktop)
    ↕ LiveSync plugin
CouchDB (cloud or local)
    ↕ DirectFileManipulator (livesync-commonlib)
MCP Server (this project)
    ↕ MCP protocol over HTTP
AI Agents (Claude, Copilot, custom)
```

The MCP server sits between CouchDB (or the local filesystem) and AI agents. It provides tools for interacting with an Obsidian vault.

## Modes

### Filesystem mode (`VAULT_PATH`)
- Reads `.md` files directly from a vault directory
- File watcher (debounced, 100ms per path) detects external edits
- Startup: opens the SQLite index, diffs mtimes against filesystem, reads only changed files

### CouchDB mode (`COUCHDB_URL`)
- Uses `DirectFileManipulator` from [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) to read/write CouchDB documents
- Handles E2E encryption (decrypt on read, encrypt on write) when `COUCHDB_PASSPHRASE` is set
- Handles chunk reassembly (large notes are split into chunks by LiveSync)
- Startup: opens the SQLite index and catches up via CouchDB `_changes` from its stored `since` sequence
- Live watcher: `_changes` feed with `live: true` for real-time updates

## MCP transport

FastMCP serves MCP over Streamable HTTP at `/mcp`. The default is sessionful
transport for broad client compatibility. With `MCP_STATELESS=true`, FastMCP
creates an isolated transport for each request and does not issue or retain an
MCP session ID. This is useful behind clients and proxies that do not preserve
session affinity.

Stateless mode is an operational compatibility and latency option within the
current transport. It is deliberately separate from the future protocol-level
transport modernization on the fork roadmap.

## Search indexes (`src/search.ts`, `src/full-text-search.ts`)

A `SearchIndex` facade uses in-memory maps only when `FULL_TEXT_SEARCH=false`.
The default path keeps durable search and metadata in one SQLite database:

```
notes         ─── path, mtime, content hash, title, normalized lookup fields
note_aliases  ─── exact and prefix alias lookup
note_tags     ─── exact tag filtering and counts
note_links    ─── outgoing links plus indexed backlink targets
chunks        ─── heading-level passages with hierarchy breadcrumbs
index_meta    ─── CouchDB `since` checkpoint
notes_fts     ─── compact metadata candidate lane
chunks_fts    ─── one Porter-stemmed passage index
```

Markdown is split at headings; oversized sections are divided at paragraph
boundaries with no overlap. Search combines exact SQL title/alias/path matches,
metadata FTS, and stemmed passage BM25 using reciprocal-rank fusion. Passage
matches are grouped to one best chunk per note before the final limit, avoiding
long-note result flooding. Bodies are not retained in the JavaScript heap.

`FULL_TEXT_SEARCH=auto` (the default) and `true` enable FTS for every vault.
When a CouchDB passphrase is configured, scrypt first makes passphrase guessing
expensive and HKDF then derives a backend-specific index key. The database uses
SQLCipher-compatible AES-256 encryption with authenticated pages. Local and
unencrypted remote vaults use ordinary SQLite because their source notes are
already plaintext at rest. `FULL_TEXT_SEARCH=false` disables the tool and all
index persistence, leaving an existing SQLite file untouched.

### Persistence

Search v2 is stored at
`DATA_DIR/backends/<backend-hash>/full-text-index-v2.sqlite` with mode `0600`.
The hash comes from the canonical filesystem root or the credential-free
CouchDB URL plus database name—not `VAULT_NAME`. That opaque identity is also
stored in SQLite and included in encrypted-index key derivation, preventing
results or a CouchDB checkpoint from being reused for another backend.
SQLite incrementally commits metadata and content; there is no JSON
snapshot or five-minute search-index save timer. CouchDB changes and their
sequence checkpoint commit in the same bounded transaction, with an event-loop
yield between batches. An incompatible schema is renamed to a timestamped
`.bak` file before a clean rebuild.

SQLite uses `DELETE` journaling and in-memory temporary tables. Encrypted index
rollback journals contain encrypted pages, and encrypted schema/identity backups
remain encrypted. The database, live journal, migration outputs, and backups are
covered by plaintext-marker and `0600` permission tests. Plaintext-to-encrypted
re-keying cannot erase copies retained by external snapshots or backups.

The old `full-text-index.sqlite` file and the prototype
`DATA_DIR/<vault-name-hash>/full-text-index-v2.sqlite` are deliberately
untouched. Because the prototype cannot prove its backend ownership, this
release rebuilds once instead of importing it. OAuth tokens remain at their
established path, so the search migration does not force reauthentication.

### Startup flow

**CouchDB mode:**
```
Open v2 SQLite index
  ↓ (has since?)
catchUp(since) via _changes feed
  → process updates (searchIndex.update)
  → process deletes (searchIndex.remove)
  → atomically commit updates and new since every batch
  ↓
Start live _changes watcher (since: current)
  → updates since on each change
```

**Filesystem mode:**
```
Open v2 SQLite index
  ↓
Diff mtimes against filesystem
  → remove stale entries (deleted files)
  → read only changed/new files
  ↓
Start fs.watch (debounced, reads through vault.readNote for symlink safety)
```

**No persisted index (first startup or corrupted):**
```
CouchDB: catchUp(since: "0") → replays all changes
Filesystem: full scan of all .md files
```

During a build or catch-up, every index-backed tool response (`search_notes`,
`list_notes`, `list_folders`, `list_tags`, and backlinks from
`get_note_metadata`) explicitly identifies incomplete or stale data.

### Fault tolerance
- Wrong passphrase: startup fails without deleting or overwriting the encrypted index
- Incompatible schema: archive the old database as `.bak`, then rebuild from the vault
- Backend identity missing/mismatch: archive the database as `.bak`, discard its checkpoint, and rebuild
- DB nuked (invalid `since`): `catchUp` errors, clears index, rebuilds from `since: "0"`
- Volume nuked: no persisted index, full rebuild; auth tokens lost (users re-authenticate)
- Crash during catch-up: the last committed SQLite checkpoint resumes the next run
- Rollback: stop cleanly and start the previous image with the same vault and
  `DATA_DIR`; the v2 file does not replace or remove the prior release's index

## Vault Backend (`src/vault-backend.ts`)

Interface shared by both modes:

```typescript
interface VersionedNoteBackend {
    readonly concurrency: "best_effort" | "strict_winner_cas";
    readVersioned(path: string): Promise<BackendReadResult>;
    createVersioned(path: string, bytes: Uint8Array): Promise<BackendMutationResult>;
    replaceVersioned(path: string, version: string, bytes: Uint8Array): Promise<BackendMutationResult>;
    deleteVersioned(path: string, version: string): Promise<BackendMutationResult>;
    moveVersioned(from: string, to: string, version: string): Promise<BackendMutationResult>;
}

interface VaultBackend extends VersionedNoteBackend {
    // Collection/index maintenance surface:
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    watchChanges?(callback): void;          // live changes
    catchUp?(since, callback): Promise<string>; // CouchDB only
}
```

### LocalVault (`src/vault-local.ts`)
- Version tokens bind the canonical path, backend root, coherent stat identity, and content digest
- Exclusive creation and move destinations; atomic sibling-temp replacement
- Process-local writer serialization with externally visible `best_effort` concurrency
- `safePath()` resolves symlinks and blocks traversal, including absent targets
- `listNotesWithMtime()` uses glob + stat in parallel
- Filters `.obsidian/` directory

### CouchDB Vault (`src/vault.ts`)
- `DirectFileManipulator` for all CouchDB operations
- `validatePath()` blocks null bytes, `..`, absolute paths, length > 1000
- Winning-revision compare-and-swap with ordinary PouchDB writes rather than forced conflict creation
- Explicit tombstone and visible conflict-branch handling
- Destination-first moves with exact effects and honest partial or indeterminate outcomes
- `catchUp()` uses PouchDB `_changes` API directly (same selector as live watcher)
- `watchChanges()` uses `beginWatch` for live `_changes` feed
- Shared `docToChange()` and `mdFilter()` helpers for both catch-up and live watch

## Authentication (`src/auth.ts`)

Self-contained OAuth 2.1 provider with PKCE:

```
Agent connects → /oauth/authorize → password page → /oauth/approve
  → redirect with code → /oauth/token (PKCE verified) → access + refresh tokens
```

- Rate limiting with exponential backoff (capped at ~85 min)
- CSRF tokens rotated on each failed attempt
- Dynamic client registration supports public (`none`) and confidential (`client_secret_post`) clients; confidential client secrets are enforced for code exchange and refresh
- Authorization codes and refresh tokens are bound to the authenticated registered client
- Token persistence to disk (0600 permissions)
- Periodic cleanup of expired tokens and unused clients
- Also accepts static `Bearer <MCP_AUTH_TOKEN>` for non-OAuth clients

## Tools (`src/tools.ts`)

10 tools registered via FastMCP:

| Tool | Reads from | Writes to |
|---|---|---|
| `read_note` | vault | — |
| `create_note` | vault | vault + index |
| `edit_note` | vault | vault + index |
| `list_notes` | index (fallback: vault) | — |
| `list_folders` | index (fallback: vault) | — |
| `list_tags` | index | — |
| `search_notes` | disk-backed FTS index | — |
| `get_note_metadata` | vault + index (backlinks) | — |
| `move_note` | vault | vault + index |
| `delete_note` | vault | vault + index |

`write_note` is intentionally absent. The six single-note tools advertise a
strict structured output contract; collection and search results remain unchanged.

## Build (`tsup.config.ts`)

livesync-commonlib is a Deno-style TypeScript library compiled for Node via tsup/esbuild:

- `@lib/` alias → `lib/livesync-commonlib/src/`
- `@/` alias → `src/stubs/` (Node stubs for browser-only code)
- Extension resolution: tries `.ts`, then `/index.ts`
- Stubs: svelte, events, KeyValueDB, hub, logger (not used in headless mode)
- `pouchdb-browser` → `pouchdb-http` (no IndexedDB in Node)
- `bgWorker` → mock (no web workers in Node)
- Navigator polyfill in banner

## Dependencies

- **livesync-commonlib** (git submodule) — CouchDB document handling, chunk reassembly, E2E encryption
- **FastMCP** — MCP server framework
- **Hono** — HTTP framework (used by FastMCP, we add OAuth routes)
- **PouchDB** — CouchDB client (transitive via livesync-commonlib)
- **better-sqlite3-multiple-ciphers** — synchronous FTS5 and SQLCipher-compatible encrypted index storage
