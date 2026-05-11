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
const folder = args.indexOf("--folder") !== -1 ? args[args.indexOf("--folder") + 1] : null;
const since = args.indexOf("--since") !== -1 ? args[args.indexOf("--since") + 1] : null;

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
    const cutoff = new Date(since).toISOString();
    bookmarks = bookmarks.filter((b) => (b.syncedAt || "") >= cutoff);
    console.log(`After --since filter: ${bookmarks.length}`);
  }

  const toProcess = bookmarks.slice(skip, skip + limit);
  console.log(`Processing ${toProcess.length} (skip=${skip}, limit=${limit === Infinity ? "all" : limit})`);
  console.log();

  // TODO Task 3: mapping. For now just print headers.
  for (let i = 0; i < toProcess.length; i++) {
    const b = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] @${b.authorHandle || "?"} — ${(b.text || "").slice(0, 80).replace(/\n/g, " ")}…`);
  }
}

main().catch((err) => { console.error("Fatal error:", err.message); process.exit(1); });
