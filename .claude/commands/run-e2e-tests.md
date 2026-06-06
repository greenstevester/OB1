# Run E2E Tests

Run the OpenBrain backend **end-to-end smoke test** against the **dev** brain — a full
`capture → embed → list → thought_stats → pgvector search → note rename/delete →
pending-capture queue` round-trip across all 9 MCP tools (10 assertions).

Safe and repeatable: it only ever touches the **isolated `thoughts_dev` table** (the
`DEV=1` fail-safe in merkheap-mcp refuses to start against prod), and it deletes the rows
it creates.

**What actually runs:** `merkheap-mcp/load/smoke.ts` against the dev MCP server on the Mac
mini (`mac-mini-bruce`, tailnet `100.97.178.87:9300`, key `dev-smoke-key`). The iOS app's
own UI E2E suite is *separate and unrelated* — that's
`xcodebuild … test -only-testing:OpenBrainUITests`, which runs offline against mocks, not
the live backend.

> **Why dev-only:** `smoke.ts` writes *and deletes*. This command **hard-refuses** any
> target that looks like prod (`:9301`) or any key other than `dev-smoke-key`. Never point
> it at the prod brain — there is no safe destructive test against prod.

## Run

Execute this block and report the outcome (PASS/FAIL summary). It's self-contained — no
arguments needed.

```bash
set -uo pipefail
TARGET="${E2E_TARGET:-http://100.97.178.87:9300/mcp}"
KEY="${E2E_KEY:-dev-smoke-key}"

# --- Safety: smoke.ts mutates+deletes. Dev brain ONLY. ---
case "$TARGET" in *:9301*) echo "ABORT: $TARGET looks like PROD (:9301). smoke.ts mutates+deletes — dev only."; exit 2 ;; esac
[ "$KEY" = "dev-smoke-key" ] || { echo "ABORT: KEY is not 'dev-smoke-key'. Refusing a mutating test with a non-dev key."; exit 2; }

# --- Locate the sibling merkheap-mcp repo (where the test lives) ---
MCP_DIR="$(cd "$(git rev-parse --show-toplevel)/../merkheap-mcp" 2>/dev/null && pwd)" \
  || { echo "ABORT: can't find sibling merkheap-mcp repo next to this one."; exit 2; }
cd "$MCP_DIR"

# --- Toolchain ---
command -v bun >/dev/null || { echo "ABORT: bun not installed (brew install oven-sh/bun/bun)."; exit 2; }
[ -d node_modules/@modelcontextprotocol/sdk ] || bun install

# --- Preflight: dev MCP alive? 401 (no key) = up + auth-gated. Mini cold-starts, so retry. ---
code=000
for t in 20 30; do
  code=$(curl -s -m "$t" -o /dev/null -w '%{http_code}' -X POST "$TARGET" -H 'Content-Type: application/json' -d '{}') || true
  [ "$code" = "401" ] && break
  echo "preflight: got HTTP $code (${t}s) — backend may be cold, retrying…"
done
[ "$code" = "401" ] || { echo "ABORT: dev MCP at $TARGET not responding (last HTTP $code). Check the mini + tailscale."; exit 1; }

# --- Run the E2E smoke ---
echo "Running E2E smoke → $TARGET (table thoughts_dev)…"
TARGET="$TARGET" KEY="$KEY" bun run load/smoke.ts
```

## On failure

- **`ABORT: dev MCP … not responding`** — the Mac mini is unreachable or the dev
  LaunchAgent is down. Check `tailscale status` / `tailscale ping mac-mini-bruce`, and the
  dev process on the mini (`launchctl print gui/$(id -u)/net.greensill.merkheap-dev`, logs
  at `~/Library/Logs/merkheap-dev.log`). A slow first probe is normal — the command already
  retries with a longer timeout.
- **One or more `FAIL <tool>` lines** — a real backend regression in that tool. Report
  which tool failed and its detail; don't paper over it. The dev table is isolated, so this
  never affects prod data.
- **deps/toolchain** — the command auto-runs `bun install` when `node_modules` is missing;
  if `bun` itself is absent it aborts with the install hint.

## Overrides (rarely needed)

- `E2E_TARGET` — MCP endpoint. Default `http://100.97.178.87:9300/mcp`; use
  `http://127.0.0.1:9300/mcp` when running on the mini itself.
- `E2E_KEY` — must be `dev-smoke-key`; the safety guard rejects anything else.

## Related tests (not run by this command)

- `bun test` (in merkheap-mcp) — fast no-DB evals/unit tests.
- `load/contract.ts` — read-only prod parity diff (edge function vs MCP server) on live
  data; touches **prod** read-side, so it's deliberately excluded here.
- `load/loadtest.ts` — transport/concurrency load, not correctness.
