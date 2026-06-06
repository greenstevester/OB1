# OpenBrain — Product Requirements / Vision

> **Shared PRD.** This document is the single product vision for the whole OpenBrain
> system and is intended to be **identical across every OpenBrain repo**. If you're an
> agent or contributor in any of those repos, this is the "why" behind the code.

## The one-liner

A personal **second brain**: a fast funnel for capturing everything you read, see, and
hear, that then searches it back efficiently *and* — running on a schedule in the
background — surfaces patterns and links across what you've ingested to suggest new ideas
and connections you'd never have made yourself.

**Technically:** a persistent AI memory system — one database (Supabase + pgvector), one
MCP protocol, any AI client. The pgvector embeddings are what make the cross-time
pattern-surfacing possible: semantically related items link up even when they share no
keywords.

## The problem

I can't remember everything I read, see, and hear. Bookmarks rot, notes get lost, and the
connection between something I saved two months ago and something I hit ten minutes ago
never gets made. OpenBrain is the place all of it lands, stays findable, and actively
works for me instead of just sitting in storage.

## Who it's for

Single user (me) first. The priority order is:

1. **Now** — get it up, running, and *stable* for my own daily use.
2. **Then** — share with Nicky.
3. **Later** — open to a wider audience.

Everything in the roadmap is gated on "stable for one user" first. No multi-tenant /
audience features until the core loop is reliable for me.

## How it works — the core loop

1. **Capture (the funnel).** GSD-fast ingestion from multiple sources into one brain:
   - the **iOS app** (text / link / photo) — capture *and* search surface
   - **Obsidian** vault notes
   - **bookmarks** (e.g. X/Twitter bookmarks imported into the vault + brain)
2. **Search.** Efficiently find anything that's been ingested, across all sources.
3. **Surface (the magic).** The brain runs **on a cron in the backend** to analyse
   everything ingested, find patterns, **link related items together across time**, and
   generate new suggestions — e.g. *"the article you stored 2 months ago relates directly
   to what you ingested 10 minutes ago, and together they could solve problem X."*

Step 3 is the differentiator. Capture + search is table stakes; the scheduled
pattern-surfacing and cross-time linking is the actual product.

## System architecture — the repos

All under `github.com/greenstevester/*` (local: `~/dev/git-repos/github/team-s-n/`):

| Repo | Role |
| --- | --- |
| `open-brain-ios` | iOS app — the capture funnel + search surface |
| `merkheap-mcp` | MCP server ("Open Brain Steve") — lets Claude / agents query the brain |
| `open-brain-docker-stacks` | Supabase backend infra — runs `brain-app` (Edge Function) and the cron pattern-surfacing |
| `OB1` | Ingestion/automation recipes (e.g. `ft-bookmarks-import`: X/Twitter bookmarks → vault + brain) |
| `obsidian-open-brain` | Obsidian plugin — the `obsidian` ingestion path |
| `obsidian-vault` | The notes store |

The iOS app's source tags (`app` / `obsidian` / `bookmarks`) map directly to these
ingestion paths.

## Status

<!-- Keep this honest and current. Verified vs planned. -->

- **Verified working:** iOS capture/search app; self-hosted Supabase backend live over
  Tailscale (`http://100.97.178.87:8000`, `brain-app` Edge Function responding).
- **Planned / not yet verified here:** the cron pattern-surfacing + cross-time linking
  loop (the core differentiator) — intent is documented above; implementation lives in
  the backend repos.

---

*This file is duplicated across all OpenBrain repos. Edit the canonical copy and propagate
— don't let the copies drift.*
