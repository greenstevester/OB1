# FT Bookmarks Import

Import your X/Twitter bookmarks into Open Brain via [`fieldtheory-cli`](https://github.com/greenstevester/fieldtheory-cli).

## Why this exists

Bookmarks are **not** included in the standard X data export, so the sibling `x-twitter-import` recipe (which handles tweets/DMs/Grok from the archive) cannot ingest them. `ft` scrapes bookmarks via your logged-in Chrome session and classifies them locally; this recipe reads that classified store and writes one thought per bookmark.

## What it does

- Reads bookmarks via `ft list --json --limit 9999`
- Maps each bookmark → one `thoughts` row with `source_type: x_twitter_bookmark`
- Embeds the tweet text + author + URL via OpenRouter
- Preserves ft's `primaryCategory`, `primaryDomain`, `folderNames`, `articleTitle/Text/Site`, and engagement counts in `payload.metadata`
- Idempotent — re-run after `ft sync` and only new bookmarks are written

## Prerequisites

- Working Open Brain setup
- `ft` installed and synced (`ft status` should show bookmarks counted)
- **Node.js 18+**
- **OpenRouter API key** for embedding generation
- Service-role key from your running Supabase stack

## Steps

1. `cd ft-bookmarks-import && npm install`
2. Copy `.env.example` to `.env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`
3. **Preview (no writes, no embeddings):**
   ```bash
   node import-ft-bookmarks.mjs --dry-run --limit 5
   ```
4. **Partial import** (validate end-to-end against 5 bookmarks first):
   ```bash
   node import-ft-bookmarks.mjs --limit 5
   ```
5. **Full backfill:**
   ```bash
   node import-ft-bookmarks.mjs
   ```

## Flags

- `--dry-run` — print what would be imported, no writes, no embeddings
- `--skip N` / `--limit N` — page through the source list
- `--folder <name>` — restrict to one ft bookmark folder (pass-through to `ft list --folder`)
- `--since <ISO date>` — only bookmarks with `syncedAt` after this date

## Troubleshooting

**"ft: command not found"** — install `fieldtheory-cli` from the [upstream repo](https://github.com/greenstevester/fieldtheory-cli) and ensure it's on `PATH`.

**"Failed to resolve host"** — `SUPABASE_URL` is using a hostname. Use the literal IPv4 (`100.97.178.87` for steve-stack); Node prefers IPv6 first and hangs on the AAAA path.

**Re-runs writing duplicates** — Should never happen. `content_fingerprint = sha256(tweetId)` is stable; OB1's `upsert_thought` dedupes on it. If you see this, check that `metadata.content_fingerprint` is being populated correctly.
