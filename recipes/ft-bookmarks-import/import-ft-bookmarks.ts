// ft (fieldtheory-cli, X/Twitter bookmarks) -> Obsidian vault notes + Open Brain.
//
// For each bookmark it (1) writes one `.md` into <VAULT>/<SUBDIR>/ with an
// `open_brain_id` frontmatter key — the same contract the obsidian-open-brain
// plugin uses — and (2) calls `capture_note` so the bookmark is both a real vault
// note AND a searchable, embedded brain note. `note_id` is a stable UUID derived
// from the tweetId, so re-running is idempotent in both places (files overwrite;
// `replaceNoteChunks` dedupes by note_id). Run `ft sync` first to pull the latest
// from X, then run this to import.
//
// DEV (safe default):
//   bun run import-ft-bookmarks.ts          # -> :9300 / thoughts_dev / /tmp vault
// PROD (explicit):
//   CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
//   KEY=$(jq -r '.mcpServers["open-brain-steve"].env.BRAIN_KEY' "$CFG") \
//   TARGET=http://10.0.0.127:9301/mcp KEY="$KEY" \
//   VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents" \
//   SUBDIR="X Bookmarks" bun run import-ft-bookmarks.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TARGET = process.env.TARGET ?? "http://10.0.0.127:9300/mcp";
const KEY = process.env.KEY ?? "dev-smoke-key";
const VAULT = process.env.VAULT ?? "/tmp/ft-vault-test";
const SUBDIR = process.env.SUBDIR ?? "X Bookmarks";
const LIMIT = Number(process.env.LIMIT ?? 100000);
const TRIES = Number(process.env.TRIES ?? 3); // retries per push (self-heals -32001 timeouts)
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? 120000);
const PAGE = 100;

// Stable UUIDv5-shaped id from the tweetId (deterministic => idempotent).
function stableUuid(seed: string): string {
  const h = createHash("sha1").update("ft-bookmark:" + seed).digest("hex").split("");
  h[12] = "5"; // version 5
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // variant
  const s = h.slice(0, 32).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

type Bookmark = {
  id: string;
  tweetId?: string;
  url?: string;
  text?: string;
  authorHandle?: string;
  authorName?: string;
  postedAt?: string;
  articleTitle?: string | null;
  articleText?: string | null;
  quotedTweet?: { text?: string; authorHandle?: string } | null;
};

function fetchBookmarks(limit: number): Bookmark[] {
  const out: Bookmark[] = [];
  let offset = 0;
  while (out.length < limit) {
    const take = Math.min(PAGE, limit - out.length);
    const json = execFileSync("ft", ["list", "--json", "--limit", String(take), "--offset", String(offset)], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const batch = JSON.parse(json) as Bookmark[];
    if (!batch.length) break;
    out.push(...batch);
    offset += batch.length;
    if (batch.length < take) break;
  }
  return out.slice(0, limit);
}

function toMarkdown(bm: Bookmark, openBrainId: string): { title: string; md: string } {
  const handle = bm.authorHandle ?? "unknown";
  const tid = bm.tweetId ?? bm.id;
  const title = sanitize(`${handle}-${tid}`);
  const fm = [
    "---",
    `open_brain_id: ${openBrainId}`,
    `source: x-bookmark`,
    `tweet_id: "${tid}"`,
    `author: "${handle}"`,
    `author_name: ${JSON.stringify(bm.authorName ?? "")}`,
    `url: ${bm.url ?? ""}`,
    `posted_at: ${JSON.stringify(bm.postedAt ?? "")}`,
    `tags: [x-bookmark]`,
    "---",
  ].join("\n");
  let body = (bm.text ?? "").trim();
  body += `\n\n[View on X](${bm.url ?? ""}) — @${handle}${bm.authorName ? ` (${bm.authorName})` : ""}`;
  if (bm.quotedTweet?.text) {
    body += `\n\n> ${String(bm.quotedTweet.text).replace(/\n/g, "\n> ")}\n> — @${bm.quotedTweet.authorHandle ?? "?"}`;
  }
  if (bm.articleTitle || bm.articleText) {
    body += `\n\n## Article\n`;
    if (bm.articleTitle) body += `**${bm.articleTitle}**\n\n`;
    if (bm.articleText) body += String(bm.articleText);
  }
  return { title, md: `${fm}\n\n${body}\n` };
}

async function pushWithRetry(
  client: Client,
  args: { note_id: string; path: string; title: string; content: string },
): Promise<boolean> {
  for (let i = 0; i < TRIES; i++) {
    try {
      const res = await client.callTool({ name: "capture_note", arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      const text = (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
      if (Array.isArray(JSON.parse(text).chunks)) return true;
    } catch (e) {
      if (i === TRIES - 1) {
        console.log(`  push fail (${args.title}):`, (e as Error).message);
        return false;
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return false;
}

const bookmarks = fetchBookmarks(LIMIT);
console.log(`ft: ${bookmarks.length} bookmark(s) to import`);
const dir = join(VAULT, SUBDIR);
mkdirSync(dir, { recursive: true });

const transport = new StreamableHTTPClientTransport(new URL(TARGET), {
  requestInit: { headers: { "x-brain-key": KEY }, keepalive: false },
});
const client = new Client({ name: "ft-import", version: "0" }, { capabilities: {} });
await client.connect(transport);

let wrote = 0;
let pushed = 0;
let failed = 0;
for (const bm of bookmarks) {
  const id = stableUuid(String(bm.tweetId ?? bm.id));
  const { title, md } = toMarkdown(bm, id);
  writeFileSync(join(dir, `${title}.md`), md);
  wrote++;
  if (await pushWithRetry(client, { note_id: id, path: SUBDIR, title, content: md })) pushed++;
  else failed++;
  if (wrote % 50 === 0) console.log(`  …${wrote}/${bookmarks.length}  pushed=${pushed} failed=${failed}`);
}
await client.close().catch(() => {});
console.log(`\nWROTE   ${wrote} .md -> ${dir}`);
console.log(`PUSHED  ${pushed} note(s) -> brain ${TARGET}`);
console.log(`FAILED  ${failed}`);
process.exit(failed > 0 ? 1 : 0);
