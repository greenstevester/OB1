# ft-bookmarks-import

Import your X/Twitter bookmarks (via [`fieldtheory-cli`](https://github.com/) — the `ft` CLI) into your **Obsidian vault** and **Open Brain** in one pass.

For each bookmark the importer:

1. writes one `.md` into `<VAULT>/<SUBDIR>/` with an `open_brain_id` frontmatter key — the same contract the `obsidian-open-brain` plugin uses, so the plugin treats these as its own notes;
2. calls `capture_note` over MCP, so the bookmark is also a searchable, embedded brain note.

`note_id` is a stable UUID derived from the tweetId, so **re-running is idempotent** in both places: vault files overwrite, and the server's `replaceNoteChunks` dedupes by `note_id`. Failed pushes (e.g. a transient `-32001` embed timeout) are retried (`TRIES`, default 3); the `.md` is always written first, so a push failure never loses data.

## Run

```bash
bun install            # installs @modelcontextprotocol/sdk
ft sync                # pull the latest bookmarks from X into ft's local DB (optional)

# DEV (safe default: :9300 / thoughts_dev / /tmp vault)
bun run import-ft-bookmarks.ts

# PROD (explicit — writes to the real brain + your live vault)
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
KEY=$(jq -r '.mcpServers["open-brain-steve"].env.BRAIN_KEY' "$CFG") \
TARGET=http://10.0.0.127:9301/mcp KEY="$KEY" \
VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents" \
SUBDIR="X Bookmarks" bun run import-ft-bookmarks.ts
```

## Env

| Var | Default | Meaning |
|---|---|---|
| `TARGET` | `http://10.0.0.127:9300/mcp` | MCP endpoint (`:9300` dev, `:9301` prod) |
| `KEY` | `dev-smoke-key` | `x-brain-key` (prod: source from `claude_desktop_config.json`, never paste) |
| `VAULT` | `/tmp/ft-vault-test` | Obsidian vault root |
| `SUBDIR` | `X Bookmarks` | folder under the vault for the notes |
| `LIMIT` | `100000` | cap on bookmarks (set small for a test batch) |
| `TRIES` | `3` | push retries per bookmark |
| `CALL_TIMEOUT_MS` | `120000` | per-`capture_note` timeout |

> The prod brain write lands in the same `thoughts` table the plugin uses; `:9301` (merkheap-mcp) and the `:8000` edge function are equivalent front doors.
