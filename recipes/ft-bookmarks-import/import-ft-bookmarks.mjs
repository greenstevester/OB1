#!/usr/bin/env node
/**
 * ft-bookmarks-import — Open Brain ingest for X/Twitter bookmarks via fieldtheory-cli.
 *
 * Reads bookmarks via `ft list --json --limit 9999`, maps each to one OB1 thought,
 * embeds the tweet body, upserts via PostgREST. Idempotent on re-run via
 * sha256(tweetId) content_fingerprint.
 *
 * Usage:
 *   node import-ft-bookmarks.mjs [--dry-run] [--skip N] [--limit N]
 *                                [--folder <name>] [--since <ISO date>]
 */

import { createHash } from "crypto";
import { spawn } from "child_process";
import { config } from "dotenv";

config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";

// --- arg parsing ---------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skip = parseInt(args[args.indexOf("--skip") + 1]) || 0;
const limit = parseInt(args[args.indexOf("--limit") + 1]) || Infinity;

function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${name} requires a value`);
    process.exit(1);
  }
  return v;
}
const folder = flagValue("--folder");
const since = flagValue("--since");

if (!dryRun && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_API_KEY)) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY");
  console.error("(Not required for --dry-run.)");
  process.exit(1);
}

// --- ft list subprocess --------------------------------------------------

function runFtList() {
  const ftArgs = ["list", "--json", "--limit", "9999"];
  if (folder) ftArgs.push("--folder", folder);

  return new Promise((resolve, reject) => {
    const child = spawn("ft", ftArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => reject(new Error(`Failed to spawn ft: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ft list exited ${code}: ${stderr.trim()}`));
      try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed)) return reject(new Error("ft list output is not a JSON array"));
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse ft list output: ${err.message}`));
      }
    });
  });
}

// --- mapping helpers -----------------------------------------------------

function contentFingerprint(tweetId) {
  return createHash("sha256").update(String(tweetId)).digest("hex");
}

/**
 * Twitter's postedAt is a string like "Sat May 09 14:33:29 +0000 2026".
 * `new Date(s)` parses it correctly in V8; we just normalise to ISO.
 * Returns null on invalid input so the caller can fall back.
 */
function parseTwitterDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resolveCreatedAt(b) {
  return parseTwitterDate(b.postedAt)
      || parseTwitterDate(b.bookmarkedAt)
      || parseTwitterDate(b.syncedAt)
      || new Date().toISOString();
}

function buildContent(b) {
  const handle = b.authorHandle || "unknown";
  const name = b.authorName || handle;
  const text = b.text || "";
  const url = b.url || "";
  return `X bookmark by @${handle} (${name}):\n\n${text}\n\n${url}`;
}

function buildMetadata(b) {
  const meta = {
    source: "ft_bookmarks",
    source_type: "x_twitter_bookmark",
    tweet_id: b.tweetId || b.id,
    url: b.url,
    author_handle: b.authorHandle,
    author_name: b.authorName,
    posted_at: parseTwitterDate(b.postedAt),
    bookmarked_at: parseTwitterDate(b.bookmarkedAt),
    synced_at: b.syncedAt,
    primary_category: b.primaryCategory ?? null,
    primary_domain: b.primaryDomain ?? null,
    categories: b.categories ?? [],
    domains: b.domains ?? [],
    folder_names: b.folderNames ?? [],
    engagement: {
      like_count: b.likeCount ?? null,
      repost_count: b.repostCount ?? null,
      reply_count: b.replyCount ?? null,
      quote_count: b.quoteCount ?? null,
      bookmark_count: b.bookmarkCount ?? null,
      view_count: b.viewCount ?? null,
    },
    content_fingerprint: contentFingerprint(b.tweetId || b.id),
  };
  if (b.articleText || b.articleTitle || b.articleSite) {
    meta.article = {
      title: b.articleTitle ?? null,
      site: b.articleSite ?? null,
      text: b.articleText ?? null,
    };
  }
  return meta;
}

// --- embed + upsert ------------------------------------------------------

async function getEmbedding(text) {
  const truncated = text.length > 8000 ? text.substring(0, 8000) : text;
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: truncated }),
  });
  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`Embedding failed: ${response.status} ${msg}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Direct POST /rest/v1/thoughts. Mirrors the proven obsidian-vault-import pattern.
 * Returns "inserted" or "duplicate". `Prefer: resolution=merge-duplicates` makes
 * duplicate fingerprints a no-op rather than a 409.
 */
async function upsertThought(content, metadata, embedding, createdAt, fingerprint) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify({
      content,
      metadata,
      embedding,
      created_at: createdAt,
      content_fingerprint: fingerprint,
    }),
  });
  if (response.status === 409) return "duplicate";
  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`POST /thoughts ${response.status}: ${msg}`);
  }
  return "inserted";
}

// --- main ----------------------------------------------------------------

async function main() {
  console.log(`ft-bookmarks-import`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE IMPORT"}`);
  if (folder) console.log(`Folder: ${folder}`);
  if (since) console.log(`Since: ${since}`);
  console.log();

  console.log("Fetching bookmarks from ft...");
  let bookmarks = await runFtList();
  console.log(`ft returned ${bookmarks.length} bookmarks`);

  if (since) {
    const cutoff = new Date(since).getTime();
    if (isNaN(cutoff)) {
      console.error(`Invalid --since date: ${since}`);
      process.exit(1);
    }
    bookmarks = bookmarks.filter((b) => {
      if (!b.syncedAt) return false;
      const t = new Date(b.syncedAt).getTime();
      return !isNaN(t) && t >= cutoff;
    });
    console.log(`After --since filter: ${bookmarks.length}`);
  }

  const toProcess = bookmarks.slice(skip, skip + limit);
  console.log(`Processing ${toProcess.length} (skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  console.log();

  let prepared = 0;
  let errors = 0;
  let skipped = 0;
  for (let i = 0; i < toProcess.length; i++) {
    const b = toProcess[i];
    const tweetId = b.tweetId || b.id;
    if (!tweetId) {
      console.warn(`[${i + 1}/${toProcess.length}] SKIP: bookmark has no tweetId`);
      skipped++;
      continue;
    }
    const content = buildContent(b);
    const metadata = buildMetadata(b);
    const createdAt = resolveCreatedAt(b);

    if (dryRun) {
      console.log(
        `[${i + 1}/${toProcess.length}] @${b.authorHandle || "?"} ` +
        `[${metadata.primary_category || "uncat"}/${metadata.primary_domain || "no-domain"}] ` +
        `${content.split("\n")[0]}`
      );
      console.log(`    url: ${b.url}`);
      console.log(`    fingerprint: ${metadata.content_fingerprint.slice(0, 12)}…`);
      console.log(`    created_at: ${createdAt}`);
      prepared++;
      continue;
    }

    try {
      const embedding = await getEmbedding(content);
      const action = await upsertThought(
        content,
        metadata,
        embedding,
        createdAt,
        metadata.content_fingerprint
      );
      console.log(
        `[${i + 1}/${toProcess.length}] ${action}: ` +
        `@${b.authorHandle} [${metadata.primary_category || "uncat"}] ${tweetId}`
      );
      prepared++;
    } catch (err) {
      console.error(`[${i + 1}/${toProcess.length}] ERROR ${tweetId}: ${err.message}`);
      errors++;
    }
  }
  console.log();
  console.log(
    `${dryRun ? "Prepared (dry-run)" : "Imported / updated"}: ${prepared}` +
    (errors ? ` | errors: ${errors}` : "") +
    (skipped ? ` | skipped: ${skipped}` : "")
  );
  if (errors > 0 && !dryRun) process.exitCode = 1;
}

main().catch((err) => { console.error("Fatal error:", err.message); process.exit(1); });
