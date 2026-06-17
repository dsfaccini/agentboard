# FORK.md — fork charter & upstream-sync playbook

This repo is a **fork**. Read this before syncing with upstream, evaluating an
upstream change, or touching tmux/pty lifecycle code.

- `origin` = `dsfaccini/agentboard` (ours) · `upstream` = `gbasin/agentboard` (original)
- We sync **from** upstream (cherry-pick / port / merge). We never push our
  `master` to upstream. Fork-specific docs like this one live only on our master.

## Goals (in priority order)

1. **Safety** — no resource leaks (esp. pty/tmux, see incident below), enforced
   payload/size caps, auth, MIME allowlists. A regression here can break the
   whole machine, not just the app.
2. **Performance** — terminal output hot-path and input batching stay cheap.
3. **Keep our additions** — never let a sync silently revert the "ours" list below.
4. **Take upstream's good stuff** — features/fixes that don't fight 1–3.

When evaluating any upstream change, classify on **net value (benefit − cost −
risk)**, state the verdict + one-line reason inline, and prefer the order
security → perf/safety → features.

## What's OURS (preserve through every sync)

- **Local-run setup**: `launchd/`, `scripts/agentboard-control.sh`, `scripts/dev.ts`
  (replaced the `concurrently`-based dev script — see security note), `README.md`.
- **Dev tooling / config**: `vite.config.ts`, `package.json` (`dev`/`dev:server`/
  `dev:client` scripts, `vite ^8`, `vite-plugin-pwa ^1.3`), our `bun.lock`.
- **Server hardening** (`src/server/index.ts`, `src/server/config.ts`): Tailscale
  bind (`AGENTBOARD_BIND_TAILSCALE`), auth token (`AGENTBOARD_AUTH_TOKEN`), WS max
  payload (`AGENTBOARD_WS_MAX_PAYLOAD_BYTES`), client-log cap
  (`AGENTBOARD_CLIENT_LOG_MAX_BYTES`), paste-image MIME allowlist + size cap,
  event-name/payload `413` guards.
- **Client terminal/websocket** (`useTerminal.ts`, `useWebSocket.ts`,
  `Terminal.tsx`, `App.tsx`): array-buffer output perf, `ResizeObserver`-based
  sizing, batched scroll-wheel input, layout hardening (`min-w-0`,
  `overflow-hidden`, `isolate`).
- **Hibernating-overlay fix** (`Terminal.tsx`): Tailwind `isolate` so overlay
  buttons receive clicks.
- **Test-isolation hardening** (`src/server/__tests__/`): deterministic tmux
  teardown (`killTmuxServer` → `rmSync`), `TMUX_TMPDIR` isolation in every
  real-tmux test, `shutdownProcess` (SIGTERM→SIGKILL), bounded tmux-spawn
  timeouts, and the `scripts/test-runner.ts` default-socket + tmpdir sweep backstop.

## Sync state vs upstream (as of merge-base v0.2.50 `fc75e2f`; upstream v0.3.3)

Re-evaluate with `git fetch upstream && git log --oneline master..upstream/master`.

| Upstream change | Verdict |
|---|---|
| `9eec9db` terminal-output perf | **skip** — already implemented in our `useTerminal.ts`/`App.tsx` (parallel work). Cherry-picking would conflict for zero gain. |
| `000f9ad` paste-image allowlist/size-cap | **skip** — already in our `config.ts`/`index.ts` (parallel work). |
| `11c458c` shell-quote→1.8.4 (GHSA) | **take (defensive)** — we removed `concurrently` so we don't pull shell-quote, but add `"overrides": { "shell-quote": "^1.8.4" }` to our `package.json` as a guard. |
| `f75202d` agent-aware clipboard image paste (swift NSPasteboard) | **take-with-care / manual-port** — overlaps our diverged `useTerminal.ts` paste handler + osascript `/api/clipboard-file-path`. |
| `9166cd3`→`2683d02`→`33b125b`→`b52bb0f` hibernated/Codex transcript reader | **take-with-care / merge as a unit** — valuable (incl. `33b125b` tail-read perf for large logs); bulk lands clean (we don't touch `SessionPreviewContent.tsx`/`eventTaxonomy.ts`). Reconcile the dual overlay fix. |

### Naive-sync hazards (do NOT)

- **Don't re-add `concurrently`** — it was the shell-quote vulnerability vector; we
  removed it. If a merged `package.json` reintroduces it, drop it + keep the override.
- **Don't take upstream's `package.json`/`bun.lock` wholesale** — reverts our vite
  versions and `dev*` scripts. Merge: keep ours, add their `overrides` block only.
- **Don't cherry-pick `9eec9db`/`000f9ad`** — re-conflicts our equivalent code.
- **Don't drop either half of the overlay fix** — ours (`isolate`) and upstream's
  (`inert`, in `9166cd3`) fix the same click bug; keep both, test before trusting.

## Watch-list (recurring concerns as we use this more)

- **pty/tmux leaks** — THE incident class. Every spawned tmux session and
  pty-backed process must be torn down at its lifecycle end (ws disconnect,
  test teardown, error paths in `PtyTerminalProxy.doStart`). Tests must never
  create sessions on the default socket — isolate via `TMUX_TMPDIR` and tear the
  whole isolated server down with `kill-server`. See incident below.
- **Hot-path perf** — terminal output and input batching.
- **Caps & auth** — keep payload/size/MIME limits when editing endpoints/WS.

## Incident (2026-06-16): pty-pool exhaustion

The Mac hit `kern.tty.ptmx_max` because un-torn-down tmux sessions accumulated.
Each tmux session/pane/client holds a pty for its lifetime; machine-wide
exhaustion breaks ALL terminals + `sudo`. Root cause on our side: test teardowns
killed only the base session and `rmSync`'d the socket dir **without**
`kill-server`, orphaning the tmux server (and, after its tmpdir was removed,
resurrecting sessions on the default socket). Fixed via the test-isolation
hardening listed under "ours" + `PtyTerminalProxy.doStart` now disposing the
grouped session when the `tmux attach` spawn fails.

## Deferred follow-ups

- `pruneOrphanedWsSessions` (`src/server/index.ts`) only reaps **unattached**
  `…-ws-*` sessions. A session whose attach-client pty died uncleanly (shows
  `attached > 0` but client dead) is never reaped. Fix would cross-check
  `list-clients` PIDs — its own edge cases, tracked separately.
- No direct unit test for the `PtyTerminalProxy.doStart` attach-failure dispose
  path (PtyTerminalProxy lacks a dedicated test file).
