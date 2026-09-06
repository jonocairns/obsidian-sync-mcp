# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

> [!IMPORTANT]
> [`jonocairns/obsidian-sync-mcp`](https://github.com/jonocairns/obsidian-sync-mcp) is the canonical repository and release line for this fork. Changes may be proposed upstream when they are useful and narrowly scoped, but upstream acceptance is not a release gate. Fork releases are currently distributed through GitHub and GHCR; `npx obsidian-sync-mcp` still installs the upstream npm package.

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-24_LTS-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent access to your Obsidian vault over MCP. Run it locally against your vault files, or pair it with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and deploy to the cloud so it works even when your machine is off.

> **Example:** From your phone, ask your AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## How it works

The server connects to your vault in two ways:

- **Filesystem mode** — reads `.md` files directly from your vault folder. No database needed.
- **CouchDB mode** — reads from a CouchDB database, locally or in the cloud. Your vault syncs to CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), the community Obsidian plugin (600k+ downloads). The MCP server reads from CouchDB directly using [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — the same library that powers the plugin — for proper chunk handling and E2E encryption support.

Both modes expose the same MCP tools over HTTP, so any MCP-compatible agent can connect: Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Choose your setup

| Need it always available? | Have LiveSync? | Go to |
|---|---|---|
| Yes | Yes | [Setup A](#a-deploy-mcp-to-the-cloud) — add MCP alongside your existing CouchDB |
| Yes | No | [Setup B](#b-deploy-everything-to-the-cloud) — CouchDB + MCP + LiveSync from scratch |
| No | — | [Setup C](#c-run-on-your-machine) — filesystem or CouchDB, source or Docker |

---

## A. Deploy MCP to the cloud

You already have LiveSync and CouchDB on an always-on server. You just need the MCP server deployed alongside it.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/jonocairns/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 2 (MCP only)
```

The script asks for your CouchDB connection details, vault name, and encryption passphrase.

**Or run the Docker image on any always-on server:**

```bash
docker run -p 127.0.0.1:8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e COUCHDB_URL=https://your-couchdb:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=yourpassword \
  -e COUCHDB_DATABASE=obsidian -e VAULT_NAME=MyVault \
  -e COUCHDB_PASSPHRASE=your-encryption-passphrase \
  -e COUCHDB_OBFUSCATE_PROPERTIES=false \
  -e MCP_AUTH_TOKEN=yourpassword \
  -e BASE_URL=https://your-server-url \
  ghcr.io/jonocairns/obsidian-sync-mcp:v0.8.0@sha256:c11b001536d327618e763d15d1dc168fe2244fe89c35b5db85f3959fb6d92d5c
```

Set `COUCHDB_PASSPHRASE` if you use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings. Set `BASE_URL` to your public URL (required for OAuth callbacks when agents connect over HTTPS).

Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `https://your-server:8787/mcp` (Docker behind HTTPS).

See [Cost](#cost-flyio) for Fly.io pricing.

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

## B. Deploy everything to the cloud

Starting fresh — no LiveSync yet. Deploy CouchDB and MCP together, then set up LiveSync in Obsidian.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/jonocairns/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 1 (CouchDB + MCP)
```

The script generates credentials, creates the database, and deploys. Save the credentials it prints.

**Or with Docker Compose on any always-on server:**

```bash
git clone --recursive https://github.com/jonocairns/obsidian-sync-mcp.git
cd obsidian-sync-mcp

cat > .env <<EOF
COUCHDB_PASSWORD=changeme
MCP_AUTH_TOKEN=choose-a-separate-strong-password
VAULT_NAME=MyVault
EOF

docker compose up -d
```

**After deployment:**

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it with the credentials from the setup output
2. Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or the HTTPS
   endpoint of the reverse proxy in front of Docker
3. The `MCP_AUTH_TOKEN` is the password you enter when an agent connects

Compose binds CouchDB and MCP to `127.0.0.1` by default. Put an HTTPS reverse
proxy or tunnel in front of the ports for remote access. Set
`BIND_ADDRESS=0.0.0.0` only on a trusted network; keep `MCP_AUTH_TOKEN` enabled.

```
Always-on server
├── CouchDB + persistent storage
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    AI agents
```

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

### Cost (Fly.io)

Applies to both Setup A and Setup B.

| Component | Cost |
|---|---|
| CouchDB + MCP VM (shared, 512MB) | ~$3-4/month (kept alive by LiveSync) |
| MCP-only VM (shared, 256MB) | ~$0-2/month (suspends when idle) |
| 1GB persistent volume | ~$0.15/month |

As of March 2026, Fly.io [may waive charges under $5/month](https://community.fly.io/t/bill-clarification-under-5-usd-of-usage-bill-charges-are-waived/26366), which could make this effectively free with a shared IPv4. Either way, cheaper than Obsidian Sync ($4/month) and you own the data.

---

## C. Run on your machine

Run the MCP server locally. Works with filesystem mode (reads vault files directly) or CouchDB mode (if you have LiveSync). Machine must stay on for agents to reach it. Until the fork has its own npm package, build a source checkout once before using `pnpm start`:

```bash
git clone --recursive https://github.com/jonocairns/obsidian-sync-mcp.git
cd obsidian-sync-mcp
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

**Filesystem mode (simplest):**

```bash
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
pnpm start
```

**CouchDB mode (if you have LiveSync):**

```bash
COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
COUCHDB_PASSPHRASE=your-encryption-passphrase \
COUCHDB_OBFUSCATE_PROPERTIES=false \
VAULT_NAME=MyVault \
pnpm start
```

Omit `COUCHDB_PASSPHRASE` if you don't use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings.

**Or with Docker:**

```bash
docker run -p 127.0.0.1:8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e VAULT_PATH=/vault -v ~/Documents/MyVault:/vault \
  -e VAULT_NAME=MyVault \
  ghcr.io/jonocairns/obsidian-sync-mcp:v0.8.0@sha256:c11b001536d327618e763d15d1dc168fe2244fe89c35b5db85f3959fb6d92d5c
```

Your MCP endpoint is `http://localhost:8787/mcp`.

**Want remote access?** Add a tunnel (machine must stay on):

```bash
cloudflared tunnel --url http://localhost:8787    # free
tailscale funnel 8787                             # or Tailscale
ngrok http 8787                                   # or ngrok
```

Set `BASE_URL` to the tunnel URL when using authentication.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read canonical Markdown plus an authoritative opaque version |
| `create_note` | Create a Markdown note only when the path is absent |
| `edit_note` | Conditionally edit with `replace_all`, `append`, `prepend_body`, or exact-one `replace_once` |
| `list_folders` | List all folders in the vault with note counts — use to discover folder names |
| `list_tags` | List all tags in the vault with counts — use to discover tags before filtering |
| `list_notes` | List notes with timestamps. Filter by folder, name, tag, or date. Sort by name or modified. |
| `search_notes` | Ranked full-text search across titles, aliases, headings, tags, and note bodies, with snippets and folder/tag/date filters |
| `delete_note` | Conditionally delete using an authoritative version |
| `move_note` | Conditionally move using an authoritative source version and absent destination |
| `get_note_metadata` | Get metadata, graph links, index freshness, and an authoritative opaque version |

The six single-note tools return both deterministic text and validated
`structuredContent` under an advertised MCP `outputSchema`. The structured
status is one of `ok`, `conflict`, `committed_with_conflict`, `partial`,
`indeterminate`, or `error`, with stable error codes, explicit effects, and
recovery guidance. Note-identifying successful results include a separate
[Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI).
Listing and search contracts remain unchanged in 0.9.

> "Add a bullet point to my daily note." "Find my notes about the MCP server and fix the typo in the second one."

### Migrating clients to 0.9

Version 0.9 deliberately removes `write_note`; there is no compatibility
alias. Clients must:

1. Use `create_note(path, content)` for create-only writes. An existing path
   returns `DESTINATION_EXISTS`; a CouchDB tombstone returns
   `RESTORE_REQUIRED`.
2. Read `result.version` from `read_note` or `get_note_metadata` immediately
   before `edit_note`, `delete_note`, or `move_note`, then pass it as
   `version`. Versions are opaque, backend-bound, path-bound, and must never be
   parsed or persisted as a durable identifier.
3. For whole-note replacement, call `edit_note` with
   `operation: "replace_all"`. The other operations concatenate or replace
   exactly the supplied strings; the server does not add or normalize newlines.
   `replace_once` also requires `old_text` and rejects zero or multiple
   matches.
4. Branch on `structuredContent.status`, not human-readable text. On
   `conflict`, follow `recovery` and normally read again before deciding
   whether to retry. On `partial` or `indeterminate`, inspect every effect
   and authoritatively read all affected paths before another mutation.

Local files use in-process writer serialization and atomic replacement, but
external filesystem writers cannot participate in the same compare-and-swap;
results therefore disclose `concurrency: "best_effort"`. CouchDB uses the
current winning revision for strict compare-and-swap and discloses
`concurrency: "strict_winner_cas"`. A move creates the absent destination
first and conditionally deletes the source second, so a failed second step is
reported as `partial` rather than pretending the move was atomic.

For local vaults, `timestamps.created` uses filesystem birth time when the
platform exposes it and falls back to inode change time otherwise. Atomic
replacement swaps in a new inode, so platforms such as Linux cannot preserve
the original birth time across an edit; `created` may therefore advance after
an MCP edit. Existing file permissions are preserved across local edits and
moves, while newly created notes default to mode `0600`.

CouchDB notes with existing conflict branches remain readable, but all MCP
mutations return `PRE_EXISTING_CONFLICT` until those branches are reconciled
outside this six-tool surface. This is an intentional 0.9 limitation.

---

## Authentication

Set `MCP_AUTH_TOKEN` to a password to enable authentication:

```bash
MCP_AUTH_TOKEN=mysecretpassword pnpm start
```

The server includes a self-contained OAuth 2.1 provider. When an agent connects:

1. A browser window opens with a password page
2. Enter the `MCP_AUTH_TOKEN` password
3. The agent gets an access token and refreshes it transparently

Dynamic client registration supports public clients (`none`) and confidential
clients (`client_secret_post`). Confidential clients must authenticate with
their issued client secret whenever they exchange an authorization code or
refresh a token; public clients use S256 PKCE and rotating refresh tokens.

The session is shared across all your Claude interfaces (Desktop, Web, Mobile) and persists across server restarts. You'll need to re-enter the password after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`).

For non-OAuth clients (curl, MCP Inspector, custom agents), you can also pass the token directly as `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local use or behind a private network.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Filesystem mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | CouchDB mode | — | CouchDB server URL |
| `COUCHDB_USER` | CouchDB mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | CouchDB mode | — | CouchDB password (required) |
| `COUCHDB_DATABASE` | CouchDB mode | `obsidian` | CouchDB database name |
| `COUCHDB_PASSPHRASE` | CouchDB mode | — | LiveSync E2E encryption passphrase (must match plugin setting) |
| `COUCHDB_OBFUSCATE_PROPERTIES` | CouchDB mode | `false` | Set to `true` if "Obfuscate Properties" is enabled in LiveSync (obfuscates file paths, sizes, dates in the database). For existing vaults the actual setting is auto-detected at startup; this value only decides the format for a brand-new empty database |
| `VAULT_NAME` | Both | `MyVault` | Display name used for Obsidian deep links and the established OAuth-token path. Search identity comes from the filesystem root or CouchDB URL + database. |
| `MCP_AUTH_TOKEN` | Optional | — | Password for authentication |
| `BASE_URL` | Optional | `http://localhost:PORT` | Public URL (for OAuth callbacks when using a tunnel) |
| `PORT` | Optional | `8787` | HTTP port |
| `HOST` | Optional | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |
| `MCP_ALLOWED_HOSTS` | Optional | — | Comma-separated extra `Host` values accepted in no-auth mode (e.g. `192.168.1.5,mybox.local`). No-auth mode rejects any other Host to block browser DNS-rebinding; localhost is always allowed. Ignored when `MCP_AUTH_TOKEN` is set. |
| `DATA_DIR` | Optional | `~/.obsidian-mcp` | Directory for the SQLite search index and auth tokens |
| `FULL_TEXT_SEARCH` | Optional | `auto` | Disk-backed SQLite full-text search: `auto` and `true` enable it; `false` disables it. When `COUCHDB_PASSPHRASE` is set, the local index is encrypted with a backend-specific derived key. Note: `false` also disables index persistence — metadata is rebuilt in memory on every startup, and CouchDB mode replays the full `_changes` feed each time. |
| `MCP_STATELESS` | Optional | `false` | Set to `true` to serve each Streamable HTTP request independently without issuing a server session ID. This avoids session affinity for clients or proxies that open a fresh connection per tool call. Leave disabled for compatibility with clients that depend on session state. |
| `LOG_LEVEL` | Optional | — | Set to `debug` for verbose logging (library logs, change feed, index sync) |
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before auth session expires |
| `READ_ONLY` | Optional | `false` | Set to `true` to disable all write tools (`create_note`, `edit_note`, `delete_note`, `move_note`). Only read tools are exposed via MCP. Useful when sharing the server with multiple AI clients and write access should be opt-in. |
| `WRITE_FOLDERS` | Optional | — | Comma-separated list of vault-relative folders where writes are allowed (e.g. `MCP,Inbox`). When set, the whole vault stays readable but `create_note`, `edit_note`, `delete_note`, and `move_note` refuse paths outside these folders (`move_note` requires both source and destination to be writable). Enforced server-side, unlike `MCP_INSTRUCTIONS`. Matching is case-sensitive and folder-boundary-aware (`MCP` matches `MCP/note.md` but not `MCP-private/note.md`). Ignored when `READ_ONLY=true`; unset means the whole vault is writable. |
| `MCP_INSTRUCTIONS` | Optional | — | Extra text appended to the server's MCP `instructions` (the string clients inject into the system prompt). Use this to bake vault-specific conventions into the server — e.g. folder structure, naming rules, folders to avoid — so they apply across every MCP client without per-client config. Best-effort: not all clients respect `instructions`. |
| `MCP_INSTRUCTIONS_FILE` | Optional | — | Path to a file (e.g. markdown) whose contents are appended to the MCP `instructions`. Easier than `MCP_INSTRUCTIONS` for multi-line conventions. If both are set, the file wins and `MCP_INSTRUCTIONS` is ignored (with a startup warning). Missing/unreadable file or files larger than 32 KB are fatal startup errors. **Store this file somewhere only the service user can write (e.g. `chmod 600`)** — its contents land in every MCP session's system prompt, so write access to it = prompt-injection access to every client. |

Set `VAULT_PATH` for filesystem mode or `COUCHDB_URL` for CouchDB mode.

`MCP_STATELESS=true` changes how the current Streamable HTTP transport manages
requests; it is not the later MCP transport-protocol migration on the fork
roadmap. Requests must be self-contained in stateless mode, and the server does
not retain client session state between them.

`FULL_TEXT_SEARCH=auto` is the upstream default and currently has the same
enablement behaviour as `true`: both expose `search_notes` and persist the
SQLite index. `true` does not force encryption; encryption follows the source
vault. An encrypted LiveSync vault always gets an encrypted index, while a local
or unencrypted CouchDB vault gets plaintext SQLite. `false` removes
`search_notes`, keeps metadata only in memory, and leaves any existing index file
untouched for rollback or later re-enablement.

For LiveSync E2E-encrypted vaults, the full-text index uses SQLCipher-compatible
AES-256 page encryption with per-page authentication. The CouchDB passphrase is
first hardened with scrypt, then domain-separated with HKDF into a dedicated index
key, and is never written to the database. Search v2 uses a separate index file,
so the previous index remains available if you roll back the Docker tag. Search
contents are decrypted only while the MCP process is running and unlocked.

Search storage and encryption are scoped to the actual backend (canonical
`VAULT_PATH`, or credential-free `COUCHDB_URL` plus `COUCHDB_DATABASE`), so two
backends with the same `VAULT_NAME` cannot share results or a CouchDB checkpoint.
The index is stored at
`DATA_DIR/backends/<backend-hash>/full-text-index-v2.sqlite` with owner-only
permissions. It contains note text and metadata and must be treated as a derived
vault copy. Encrypted indexes keep SQLite rollback journals and schema backups
encrypted; local and unencrypted-vault indexes do not.

The first upgrade from the name-scoped prototype performs a clean rebuild and
leaves the old index intact because its backend ownership cannot be verified.
Filesystem restarts read only new or mtime-changed note bodies, remove deleted
paths, and persist newer mtimes even when content is unchanged. Index-backed
tools warn while a build or catch-up can make results, counts, or backlinks
incomplete.

Changing `VAULT_PATH`, the credential-free CouchDB URL, or `COUCHDB_DATABASE`
selects a different backend directory and rebuilds without reusing another
vault's checkpoint. A changed or wrong passphrase fails startup without
overwriting the encrypted index. An incompatible schema or embedded backend
identity is renamed to a timestamped `.bak` before a clean rebuild. A
plaintext-to-encrypted upgrade re-keys the active SQLite file, but old snapshots
or backups may still retain plaintext and must be expired separately.

To roll back, stop the candidate cleanly and start the previous image against
the same vault and persistent `DATA_DIR`. Search v2 uses a separate file and
does not delete the prior release's index. Do not delete or migrate either index
until the previous image has opened successfully; a rebuild affects only the
derived index, never the source vault.

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
VAULT_PATH=~/Documents/MyVault pnpm start &
pnpm dlx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect.

---

## How to update

| How you run it | How to update |
|---|---|
| Source checkout | `git pull`, then `pnpm install --frozen-lockfile && pnpm build` |
| Fly.io | `git pull`, enter the relevant `deploy/mcp-*` directory, run `. ../mcp-image.env`, then `fly deploy --build-arg "MCP_IMAGE=$MCP_IMAGE"`. The manifest selects an immutable reviewed image. If you lost the fly.toml, run `fly config save --app your-app-name` first. |
| Docker | Pull the reviewed version-and-digest pair from the release notes, then restart |

**Upgrading to v0.8.1 or later:** the container now runs as the unprivileged
`node` user (uid 1000). A `DATA_DIR` volume created by an earlier root-running
image is owned by root, so the server exits at startup with `Cannot write to
DATA_DIR`. Hand the volume over once:

```bash
docker run --rm -v mcp-data:/data alpine chown -R 1000:1000 /data
```

For a bind mount, `sudo chown -R 1000:1000 <host-path>` instead; on a Fly.io
machine, `fly ssh console -C "chown -R 1000:1000 /data"`. The index and auth
tokens survive — only ownership changes.

On Unraid, chown the appdata path mapped to `/data` to Unraid's own account and
run the container as that account, so the Docker Safe New Permissions tool
cannot revert it: `chown -R 99:100 /mnt/user/appdata/<share>` from the terminal,
then add `--user 99:100` to Extra Parameters in the container template (Advanced
View). This image has no `PUID`/`PGID` entrypoint — `--user` is what selects the
account.

---

## Known limitations

- **Single vault per instance.** Each server connects to one vault. For multiple vaults, run multiple instances on different ports.
- **Single machine on Fly.io.** Auth state is in-memory, so multiple machines break the OAuth flow. The setup script enforces this automatically.
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, last write wins.
- **Text only.** Binary attachments are not exposed through MCP tools.
- **Deep links depend on the client.** Obsidian `obsidian://` deep links are included in every tool response. They work on Claude Mobile and in browsers, but some clients (Claude Desktop) may not render them as clickable links.
- **Node 24 LTS required.** Native dependencies must match the runtime platform and architecture.
- **Source checkouts use pnpm with a seven-day dependency cooldown.** Dependency
  lifecycle scripts are denied unless their exact package version is reviewed in
  `pnpm-workspace.yaml`; unreviewed scripts fail the install.
- **Setup script requires bash.** The `deploy/setup.sh` script works on macOS and Linux. On Windows, use WSL or Git Bash.

---

## Safety

This server gives an AI agent read/write access to your Obsidian vault.

**Agents can modify and delete notes.** Keep backups. Use tool approval deliberately.

**Authentication is optional.** Always set `MCP_AUTH_TOKEN` when exposing to the internet.

**Use HTTPS in production.** Use a tunnel or deploy behind a reverse proxy.

This software is provided as-is under the [MIT license](https://github.com/jonocairns/obsidian-sync-mcp/blob/main/LICENSE). You are responsible for what agents do with your vault.

---

## Development

With Node 24 LTS installed:

```bash
git clone --recursive https://github.com/jonocairns/obsidian-sync-mcp.git
cd obsidian-sync-mcp
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test      # unit tests
pnpm test:e2e  # integration tests
```

### Nix and direnv

The repository includes a Nix flake that provides Node 24 LTS. If you use
[direnv](https://direnv.net/) with [nix-direnv](https://github.com/nix-community/nix-direnv)
and its shell hook installed, allow the checked-in environment once and it will
load whenever you enter the repository:

```bash
direnv allow
pnpm install --frozen-lockfile
```

Without direnv, enter the same development environment manually:

```bash
nix develop
```

Then use the same `pnpm build`, `pnpm test`, and `pnpm test:e2e` commands
shown above.

### Dependency policy

pnpm 11 is pinned in `package.json`. `pnpm-workspace.yaml` rejects dependency
versions published less than seven days ago, including transitive dependencies,
and fails closed when registry publication times are missing. Four exact
versions carried over from the npm lockfile are temporarily grandfathered; no
other versions of those packages are exempt.

Dependency lifecycle scripts are denied by default. The exact locked esbuild
and macOS fsevents versions are allowed to build. The tldjs informational
postinstall and better-sqlite3's implicit source build are explicitly denied;
the latter uses its bundled prebuild. Any new unreviewed build script fails the
install. Review and update `allowBuilds` deliberately when a dependency upgrade
changes one of these versions.

### Commits and releases

This repository uses Conventional Commit prefixes to calculate releases:

| Prefix | Version effect |
| --- | --- |
| `fix:` or `perf:` | Patch |
| `feat:` | Minor |
| Any supported prefix with `!` or a `BREAKING CHANGE:` footer | Minor before 1.0; major from 1.0 onward |
| `docs:`, `test:`, `ci:`, `build:`, `style:`, `refactor:`, `revert:`, `deps:`, ordinary `chore:` | No release by themselves |

Scopes are encouraged when they add context. User-visible dependency,
container, or delivery fixes must use an appropriate fix prefix, such as
`fix(deps):`, `fix(container):`, or `fix(delivery):`; a plain `chore:` will not
publish them.

After every push to `main`, all CI gates run before Release Please can create or
update its release PR. Merge that PR when the accumulated changes are ready to
ship. The merged commit runs the same CI gates again; only after they pass does
Release Please create the `vX.Y.Z` tag and initial GitHub Release. The workflow
then verifies the tag against `package.json`, uploads the package archive to the
existing release, publishes the stable multi-architecture GHCR image, and adds
its immutable digest reference to the release notes. npm publication is not
enabled. Updates to `deploy/mcp-image.env` or README digest pins remain separate,
reviewed, non-releasing pull requests.

Repository administrators must enable **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests** so the
repository `GITHUB_TOKEN` can maintain the release PR. Keep squash-merge commit
titles Conventional because Release Please reads the commit history on `main`.

---

## License

MIT — see [LICENSE](https://github.com/jonocairns/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [es617/obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp) — the upstream project this fork builds on
- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [CouchDB](https://couchdb.apache.org/) — document database
- [Fly.io](https://fly.io/) — deployment platform
