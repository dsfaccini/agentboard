# FORK.md — fork charter & upstream-sync playbook

This repo is a **fork**. Read this before syncing with upstream, evaluating an
upstream change, or touching tmux/pty lifecycle code.

- `origin` = `dsfaccini/agentboard` (ours) · `upstream` = `gbasin/agentboard` (original)
- We sync **from** upstream (cherry-pick / port / merge). We never push our
  `master` to upstream. Fork-specific docs like this one live only on our master.

## How we work (this fork)

- **Commit straight to `master`. No PRs in our fork** — David merges everything
  onto our own `master`. Use a short-lived branch only if a change needs staging
  (e.g. a risky multi-commit sync), then fast-forward `master` and delete it.
- **Push `master` to `origin` when asked.** Never force-push.
- **Syncing upstream:** cherry-pick or merge upstream commits onto `master`,
  keeping the "ours" list below intact; resolve `package.json` version to the
  upstream value once a sync is complete. See the sync playbook below.
- **Tests:** `bun run test` (the runner injects `NO_PROXY` for loopback so the
  integration tests work behind David's `sfw` package-manager proxy). A direct
  `bun test <file>` bypasses that and will hang `waitForHealth` under `sfw` —
  prefer `bun run test`, or set `NO_PROXY=localhost,127.0.0.1,::1`.
- **Known-flaky:** `double-attach › "second terminal-attach within 500ms …"`
  fails on a `waitForMessageQuiescence` timeout in this environment (fails the
  same on upstream's original) — not a regression; don't chase it blind.

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
- **gh-gateway watchdog** (`src/server/ghGatewayWatchdog.ts`, wired in
  `index.ts`): macOS-only `setInterval` (60s) that shells out to David's
  `~/ai-coding-tools/github-graphql-proxy/scripts/gh-gateway-doctor.sh` to keep
  his local GitHub-API proxy alive, so no AICA has to run the doctor by hand.
  Idempotent + no-op off darwin, under `NODE_ENV=test` (integration tests boot
  the real `index.ts`), or when the script is absent. Env:
  `AGENTBOARD_GH_GATEWAY_WATCHDOG=false` disables, `AGENTBOARD_GH_GATEWAY_DOCTOR`
  overrides the path, `AGENTBOARD_GH_GATEWAY_WATCHDOG_MS` the interval. This is a
  David-local convenience coupled to a foreign subsystem — pure fork territory,
  never upstream it.
- **Weekly memory recycle** (`scripts/agentboard-memory-recycle.sh`, LaunchAgent
  `com.agentboard.memory-recycle` via `launchd/install.sh`): Sunday 04:15 local.
  Kickstarts `com.agentboard` (clears multi-day bun phys_footprint growth —
  ~1.3 GB → ~165 MB observed), waits for `/api/health`, then runs the
  gh-gateway doctor. Doctor prefers no-sudo heal + root `com.david.gh-gateway-pf`
  wait; only if pf is still down does it notify with **one** command:
  `~/ai-coding-tools/github-graphql-proxy/scripts/gh-gateway-fix-pf.sh`
  (sudo pfctl + verify — never a two-step gap). Ad-hoc: `agentboard recycle`.
  LaunchAgent PATH must use real `~/.bun/bin/bun`, never `sfw-shims` (shim can
  exit 0 on network errors so KeepAlive won't respawn).
- **Memory growth mitigations + sampling** (same incident class): log poller
  age-filters history for match payloads (`getHistoryMaxAgeHours`, same as UI);
  match scrollback 10k→1500 lines; prune `emptyLogCache` / `rematchAttemptCache`
  / expired `lastUserMessageLocks`. Continuous sampler
  (`src/server/memorySampler.ts`, `GET /api/memory`, design in
  `notes/memory-sampling.md`) records a 5‑min heap/rss ring + sparse
  `memory_sample` logs so slope is visible without Activity Monitor.

## Sync state vs upstream

**Synced through upstream v0.3.3** (cherry-picked onto our tree; we now report
`version: 0.3.3`). Re-evaluate future drift with
`git fetch upstream && git log --oneline master..upstream/master`.

| Upstream change | Verdict / status |
|---|---|
| `9eec9db` terminal-output perf | **skipped** — already implemented in our `useTerminal.ts`/`App.tsx` (parallel work). Cherry-picking would conflict for zero gain. |
| `000f9ad` paste-image allowlist/size-cap | **skipped** — already in our `config.ts`/`index.ts` (parallel work). |
| `11c458c` shell-quote→1.8.4 (GHSA) | **taken (defensive)** — we removed `concurrently` so we don't pull shell-quote; added `"overrides": { "shell-quote": "^1.8.4" }` as a guard. |
| `f75202d` agent-aware clipboard image paste (swift NSPasteboard) | **taken** — cherry-picked. Dropped upstream's unused `pasteImageExtensionByMime` map (our `/api/paste-image` uses its own `allowedTypes`); added `pasteImageMaxBytes` to the `indexHandlers.test.ts` mock config. |
| `9166cd3`→`2683d02`→`33b125b`→`b52bb0f` hibernated/Codex transcript reader | **taken** — cherry-picked as a unit (adds `react-markdown`/`remark-*`, `src/shared/json.ts`, `33b125b` tail-read perf). Dual overlay fix reconciled: our `isolate` (Terminal.tsx className) **and** upstream's `inert` (`container.inert`) both present. |

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
- **tmux-resurrect/continuum boot race** — agentboard's launchd job starts the
  tmux server at login. If tmux-continuum's `@continuum-restore` is `on`, the
  server-start restore races agentboard on the same server and deadlocks. Keep
  `@continuum-restore 'off'` and let `scripts/tmux-restore-once.sh` (run from the
  launchd wrapper, before agentboard) do a single ordered restore. See incident.

## Incident (2026-06-16): pty-pool exhaustion

The Mac hit `kern.tty.ptmx_max` because un-torn-down tmux sessions accumulated.
Each tmux session/pane/client holds a pty for its lifetime; machine-wide
exhaustion breaks ALL terminals + `sudo`. Root cause on our side: test teardowns
killed only the base session and `rmSync`'d the socket dir **without**
`kill-server`, orphaning the tmux server (and, after its tmpdir was removed,
resurrecting sessions on the default socket). Fixed via the test-isolation
hardening listed under "ours" + `PtyTerminalProxy.doStart` now disposing the
grouped session when the `tmux attach` spawn fails.

## Incident (2026-06-27): continuum-restore boot deadlock

After a reboot the agentboard UI showed a stuck yellow `/ Restoring...`. Root
cause: agentboard's launchd job (`com.agentboard` → `agentboard-run.sh`) starts
the tmux server via `tmux new-session`; with `@continuum-restore 'on'` that
tripped tmux-continuum's server-start restore, which then replayed 30+ saved
windows **concurrently** with agentboard's own `ensureSession()`/discovery on the
same server. They collided, a `tmux rename-window` wedged, and resurrect's spinner
spun forever (`tmux_spinner.sh "Restoring..."`) — agentboard just rendered that
stuck tmux message line. Fix: order the two. `~/.tmux.conf` now sets
`@continuum-restore 'off'` (continuum still **saves**) and
`@resurrect-capture-pane-contents 'off'` (cwds + window names are all we need);
the launchd wrapper runs `scripts/tmux-restore-once.sh` to do one synchronous
restore *before* agentboard starts (cold-boot only, via `tmux has-session` guard;
180s watchdog). `~/.tmux.conf` is a personal dotfile, not in this repo — the
coupling lives in `scripts/tmux-restore-once.sh`'s header + `launchd/install.sh`.

## Deferred follow-ups

- `pruneOrphanedWsSessions` (`src/server/index.ts`) only reaps **unattached**
  `…-ws-*` sessions. A session whose attach-client pty died uncleanly (shows
  `attached > 0` but client dead) is never reaped. Fix would cross-check
  `list-clients` PIDs — its own edge cases, tracked separately.
- No direct unit test for the `PtyTerminalProxy.doStart` attach-failure dispose
  path (PtyTerminalProxy lacks a dedicated test file).
