# CLAUDE.md — Agent Instructions for Open Brain

This file helps AI coding tools (Claude Code, Codex, Cursor, etc.) work effectively in this repo.

## What This Repo Is

Open Brain is a persistent AI memory system — one database (Supabase + pgvector), one MCP protocol, any AI client. This repo contains the extensions, recipes, schemas, dashboards, integrations, and skills that the community builds on top of the core Open Brain setup.

**License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when generating code or suggesting dependencies.

## Repo Structure

```
extensions/     — Curated, ordered learning path (6 builds). Do NOT add without maintainer approval.
primitives/     — Reusable concept guides (must be referenced by 2+ extensions). Curated.
recipes/        — Standalone capability builds. Open for community contributions.
schemas/        — Database table extensions. Open.
dashboards/     — Frontend templates (Vercel/Netlify). Open.
integrations/   — MCP extensions, webhooks, capture sources. Open.
skills/         — Reusable AI client skills and prompt packs. Open.
server/         — Canonical Open Brain MCP server (Hono + Deno, deployed as a Supabase Edge Function). Reference implementation for `search_thoughts` / `list_thoughts` and the contract every extension's MCP tools follow.
docs/           — Setup guides, FAQ, companion prompts.
resources/      — Official companion files and packaged exports.
```

Every contribution lives in its own subfolder under the right category and must include `README.md` + `metadata.json`.

Each category has a `_template/` folder with a starter README and `metadata.json`. Copy, don't edit — the PR gate excludes templates from contribution checks.

## Guard Rails

- **Never modify the core `thoughts` table structure.** Adding columns is fine; altering or dropping existing ones is not.
- **No credentials, API keys, or secrets in any file.** Use environment variables.
- **No binary blobs** over 1MB. No `.exe`, `.dmg`, `.zip`, `.tar.gz`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.
- **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers. All extensions deploy as Edge Functions and connect via Claude Desktop's custom connectors UI (Settings → Connectors → Add custom connector → paste URL). See `docs/01-getting-started.md` Step 7 for the pattern.

## Common Commands

This repo has no top-level `package.json` — work happens inside contribution folders. The few cross-repo commands worth knowing:

- **Markdown lint** (mirrors `.github/workflows/markdown-lint.yml`):
  `npx markdownlint-cli2 --config .github/.markdownlint.jsonc "**/*.md"`
- **Validate a `metadata.json`** against the repo schema:
  `python3 -m pip install check-jsonschema && check-jsonschema --schemafile .github/metadata.schema.json <path>/metadata.json`
- **Typecheck the canonical MCP server** (Deno):
  `cd server && deno check index.ts`
- **Read `.github/workflows/ob1-gate.yml`** to step through the deterministic PR rules locally — it's a single bash script and is the source of truth for what a contribution must satisfy.

## CI Workflows

- `.github/workflows/ob1-gate.yml` — **OB1 PR Gate.** Deterministic bash checks (folder structure, metadata schema, secrets scan, SQL safety, README completeness, broken links, remote-MCP enforcement, tool-audit link). Must pass before human review. Skipped for `[docs]` PRs.
- `.github/workflows/claude-review.yml` — LLM clarity/alignment review (qualitative; complements the gate).
- `.github/workflows/markdown-lint.yml` — `markdownlint-cli2` on changed `.md` files.

When the gate fails, read its inline comment on the PR — it names exactly which rule and which file.

## PR Standards

- **Title format:** `[category] Short description` (e.g., `[recipes] Email history import via Gmail API`, `[skills] Panning for Gold standalone skill pack`)
- **Branch convention:** `contrib/<github-username>/<short-description>`
- **Commit prefixes:** `[category]` matching the contribution type
- Every PR must pass the automated review checks in `.github/workflows/ob1-gate.yml` before human review
- See `CONTRIBUTING.md` for the full review process, metadata.json template, and README requirements

## Key Files

- `CONTRIBUTING.md` — Source of truth for contribution rules, metadata format, and the review process
- `.github/workflows/ob1-gate.yml` — Deterministic PR gate (folder, metadata, secrets, SQL safety, links)
- `.github/workflows/claude-review.yml` — LLM clarity/alignment review
- `.github/metadata.schema.json` — JSON schema for metadata.json validation
- `.github/PULL_REQUEST_TEMPLATE.md` — PR description template
- `server/index.ts` — Canonical MCP server reference implementation
- `LICENSE.md` — FSL-1.1-MIT terms

## Local GSD Execution Layer

This repo also has a maintainer-local GSD layer in `.planning/`.

- If `.planning/` exists, use it for local brownfield planning and phased execution.
- Start with `.planning/STATE.md`, then read `.planning/PROJECT.md`, `.planning/ROADMAP.md`, and the relevant `.planning/codebase/*.md` documents.
- Keep `.planning/` local. It is gitignored intentionally and is not part of the public contribution contract or upstream PR scope.
- Public contributor rules still come from `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and the committed repo files.
