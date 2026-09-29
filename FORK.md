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
- **`bun run dev` next to the launchd service** needs its own data dir and
  port: the service holds `~/.agentboard/server.lock` and port 47329, and a
  second server on either refuses to start. Run
  `AGENTBOARD_DATA_DIR=~/.agentboard-dev PORT=47339 bun run dev` (db, log, lock
  and tmux pid file all follow the data dir; vite proxies to `PORT`).

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
  The launchd wrapper runs the server from source but serves `dist/client`, so it
  rebuilds the UI on start when client sources are newer than the bundle. It
  runs `scripts/tmux-restore-once.sh` under `env -u NODE_ENV`: on a cold boot
  that script starts the tmux server, whose launch env becomes every pane's.
  Re-run `launchd/install.sh` after editing the wrapper heredoc.
- **Dev tooling / config**: `vite.config.ts`, `package.json` (`dev`/`dev:server`/
  `dev:client` scripts, `vite ^8`, `vite-plugin-pwa ^1.3`), our `bun.lock`.
- **Server hardening** (`src/server/index.ts`, `src/server/config.ts`): Tailscale
  bind (`AGENTBOARD_BIND_TAILSCALE`), auth token (`AGENTBOARD_AUTH_TOKEN`), WS max
  payload (`AGENTBOARD_WS_MAX_PAYLOAD_BYTES`), client-log cap
  (`AGENTBOARD_CLIENT_LOG_MAX_BYTES`), paste-image MIME allowlist + size cap,
  event-name/payload `413` guards, `/api/pr-info` content-length `413` (16 KB).
  `/api/paste-file` (upstream) keeps its content-length `413`, streamed body
  cap, 0600 files and sanitized names; its multipart scan uses `Buffer.indexOf`.
- **Client terminal/websocket** (`useTerminal.ts`, `useWebSocket.ts`,
  `Terminal.tsx`, `App.tsx`): array-buffer output perf, `ResizeObserver`-based
  sizing, batched scroll-wheel input, layout hardening (`min-w-0`,
  `overflow-hidden`, `isolate`). The terminal container carries both our
  `isolate overflow-hidden` and upstream's theme `backgroundColor` (xterm 6).
- **Hibernating-overlay fix** (`Terminal.tsx`): Tailwind `isolate` so overlay
  buttons receive clicks.
- **Device-file paste adaptations** (`useTerminal.ts`, `useBrowserPaste.ts`):
  Codex image paste stays on the Ctrl+V byte whenever the host clipboard is the
  browser's (upstream uploads the image and types a path Codex ignores);
  `useBrowserPaste.cancel()` keeps the state object when already idle, so the
  per-switch cancel does not re-render the terminal.
- **PR chip hardening** (`prExtractor.ts`, `prInfo.ts`, `PrChips.tsx`): session
  hydration calls `getCachedSessionPullRequests`, which never scans a log from
  the start inline. Cold logs, rewrites and catch-ups over 256 KB scan in the
  background (1 MB per event-loop turn), then dormant lists republish. `gh pr
  view` is deduped per PR and capped at 4 processes. The client checks cache
  expires after 60 s and never stores errors; the chip fit memo keys on the
  joined URLs.
- **Grok telemetry filter** (`logDiscovery.isGrokTelemetryFile`): discovery,
  `logMatcher` and `logMatchWorker`'s watcher `validPaths` accept only
  `chat_history.jsonl` from a Grok session dir. Upstream's `validPaths` let
  `events.jsonl`/`updates.jsonl` through, and their path-derived session id
  overwrote the transcript's `last_known_log_size`/`last_activity_at`.
- **Test-isolation hardening** (`src/server/__tests__/`): deterministic tmux
  teardown (`killTmuxServer` → `rmSync`), `TMUX_TMPDIR` isolation in every
  real-tmux test, `shutdownProcess` (SIGTERM→SIGKILL), bounded tmux-spawn
  timeouts, and the `scripts/test-runner.ts` default-socket + tmpdir sweep backstop.
  The runner and `playwright.config.ts` point `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `PI_HOME` and `GROK_HOME` at throwaway dirs, so no test reads real agent logs.
  Every tmux call aimed at an isolated `TMUX_TMPDIR` must drop an inherited
  `TMUX`: it overrides `TMUX_TMPDIR`, so a run from a tmux pane hits the live server.
  `privateTmuxEnv()` builds such envs. The runner also gives every test process
  a run-wide private `TMUX_TMPDIR` (`/tmp/agentboard-run-*`, killed by `-S` at
  exit) and `AGENTBOARD_DATA_DIR` (lock + tmux pid file), so a stray tmux call
  lands on a throwaway server. Entrypoint tests that import `index.ts` under
  mocks await `startupReady` (`settleServerStartup`) before restoring them. e2e:
  suite-side tmux calls use `-S` via `tests/e2e/privateTmux.ts`, teardown has no
  shared-server fallback, and the webServer runs without the gh-gateway watchdog
  and stuck-shell reaper.
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
- **Stuck-shell reaper** (`src/server/stuckShellReaper.ts`, wired in
  `index.ts`): frees ptys pinned by tmux grouped-session creation. See the
  watch-list entry; keep it until tmux stops leaking the throwaway shell.
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
- **Async tmux on the connection paths** (`TerminalProxyBase.runTmux`,
  `runLocalTmux` in `index.ts`): proxy start, switch and dispose, the attach
  capture, `resize-window` and the copy-mode cancel spawn tmux with `Bun.spawn`,
  so a slow tmux no longer stalls every client. `runTmuxSync` remains only for
  input-ordered paths: paste and pipe-pane input. The pty proxy is created on a
  socket's first `terminal-attach`, not in the websocket `open` handler, so an
  abandoned socket costs no tmux work. `terminal-resize` skips an unchanged
  size per socket. Input waits behind that socket's in-flight copy-mode cancel.
  Client (`useWebSocket.ts`): desktop never abandons a connecting socket and
  gives the resume verify the 10 s heartbeat window. Mobile (iOS/Android) keeps
  the 3 s / 8 s connect timeouts and the 1.5 s verify.
- **Memory growth mitigations + sampling** (same incident class): log poller
  age-filters history for match payloads and the orphan rematch
  (`getHistoryMaxAgeHours`, same as UI; upstream uses a fixed 72h);
  match scrollback 10k→1500 lines; prune `emptyLogCache` / `rematchAttemptCache`
  / expired `lastUserMessageLocks`; cap the matcher's `zeroTokenLogCache` (2000);
  a stalled match worker is `terminate()`d, not abandoned (upstream abandons it
  because terminate segfaults compiled binaries; we run from source). Continuous sampler
  (`src/server/memorySampler.ts`, `GET /api/memory`, design in
  `notes/memory-sampling.md`) records a 5‑min heap/rss ring + sparse
  `memory_sample` logs so slope is visible without Activity Monitor.

## Sync state vs upstream

**Synced through upstream v0.4.5**, plus the selected later commits in the table
below (up to `3888f43`, v0.18.0). That was a selective port, not a full sync, so
we still report `version: 0.4.5`. Re-evaluate future drift with
`git fetch upstream && git log --oneline master..upstream/master`.

| Upstream change | Verdict / status |
|---|---|
| `9eec9db` terminal-output perf | **skipped** — already implemented in our `useTerminal.ts`/`App.tsx` (parallel work). Cherry-picking would conflict for zero gain. |
| `000f9ad` paste-image allowlist/size-cap | **skipped** — allowlist + `file.size` cap already in our `config.ts`/`index.ts` (parallel work). Its early content-length 413 was missing until `/api/paste-image` got one in 2026-09. |
| `11c458c` shell-quote→1.8.4 (GHSA) | **taken (defensive)** — we removed `concurrently` so we don't pull shell-quote; added `"overrides": { "shell-quote": "^1.8.4" }` as a guard. |
| `f75202d` agent-aware clipboard image paste (swift NSPasteboard) | **taken** — cherry-picked. Dropped upstream's unused `pasteImageExtensionByMime` map (our `/api/paste-image` uses its own `allowedTypes`); added `pasteImageMaxBytes` to the `indexHandlers.test.ts` mock config. |
| `9166cd3`→`2683d02`→`33b125b`→`b52bb0f` hibernated/Codex transcript reader | **taken** — cherry-picked as a unit (adds `react-markdown`/`remark-*`, `src/shared/json.ts`, `33b125b` tail-read perf). Dual overlay fix reconciled: our `isolate` (Terminal.tsx className) **and** upstream's `inert` (`container.inert`) both present. |
| `1274fb4`→`dc152e3`→`5216db9`→`e033ec4`→`fde1916` Claude fullscreen mouse + paste (v0.4.0–0.4.4) | **taken as a unit** — no-flicker default (`AGENTBOARD_CLAUDE_NO_FLICKER=0` opt-out), app-mouse wheel/click, tmux clipboard poll (async, no clobber, `set-clipboard on`), bracketed image-path paste, `terminal-paste` via `paste-buffer -p`. Kept: dispose-on-attach-fail, wheel SGR batching + `!appMouse` copy-mode gate, grouped `:1` copy-mode target assertion, Grok `AgentType`, our slug-supersede real-tmux integration test (upstream rewrote to unit — skipped their rewrite), package scripts/overrides/vite, MIME allowlist + size caps. |
| `da573f8`→`fae5bb0`→`ca7cd62`→`22ba6f4`→`6b23415` pty paste + settings (v0.4.5) | **taken** — list-clients identity (#165), paste into lastEffectiveSession (#166), runtime prefer-window-name toggle (#167), settings PUT harden + paste regression tests, persist manualSessionOrder (#169). Kept our settings store `version: 7` when dropping the partialize exclusion. |
| `6801692`→`f900ea9`→`fb2638b` test isolation | **taken** — per-file process isolation for `isolated/` + motion client tests; sessionListComponent window stub lifecycle. |
| `90b1d0a` session-list layout snap (#170) | **taken (parallel)** — same idea as our `746ec57` (drop popLayout + layout springs). Did not re-cherry-pick; ours already landed. |
| `2e6903f` dispose grouped session on attach fail (#160) | **already had** — our earlier `2c80fe3` / FORK attach-fail dispose. |
| `f8c6bbf`→`6f7a705` CI SHA pins + Dependabot (#173–#178) | **deferred** — supply-chain hygiene for release workflows we don't run; re-evaluate when we care about GH Actions pinning. |
| `cfc3267` tmux `-T sync` + xterm 5.5→6 | **adapted** — `tmux -V` probe cached per spawner (upstream adds a sync spawn per proxy start); deps via `bun add`. Wheel SGR batching + `!appMouseRef` gate unchanged: xterm 6 still runs `attachCustomWheelEventHandler` first on both wheel paths. |
| `7db78c0` xterm 6 black border | **adapted** — container keeps `isolate overflow-hidden` and gains the theme `backgroundColor`. |
| `19dc236` ambient `HOSTNAME` guard | **adapted** — placed after our auth/Tailscale config; port 47329 + README auth wording kept. |
| `476afb9`→`05ac0d4` e2e on a private tmux server, isolated data dirs | **adapted** — suite-side tmux calls use `-S` (`tests/e2e/privateTmux.ts`, throws instead of falling back); teardown drops the shared-server fallback; webServer runs without gh-gateway watchdog + reaper. |
| `4d2cc68` bounded session loads | **adapted** — kept our age-filtered history, not the fixed 72h; stalled worker is `terminate()`d with handlers detached, guarded by `workerTerminate.test.ts`. |
| `de52ca7` launch env out of tmux | **adapted** — `tmuxEnv.ts` on both `runTmux`s + pty attach; launchd wrapper runs the restore under `env -u NODE_ENV`. Skipped the startup global-env scrub (fingerprint is `AGENTBOARD_STATIC_DIR`, which our launch chain never sets). |
| `493a6d4` block input during session switches | **adapted** — kept our kill-button sizing, wheel SGR batching and `!appMouseRef` gate. |
| `79325b7` SIGUSR1 tmux socket recovery | **adapted** — SessionManager/config only; launchd README watchdog skipped (no tmux-watchdog agent). Test runner isolates the pid file. |
| `f63f920`→`182c4fa`→`d1b3db5` unicode input/snapshots, `convertEol: false` | **taken** — only an unrelated `c99b1ac` test hunk dropped. |
| `15619f0`→`e7a5460` startup rematch skip; reconciliation off startup path | **adapted** — dormant candidates use our age-filtered history; `log_poll` phase timings taken. |
| `341d296`→`bbb2634` hard agent-type gate; jumbo last-message lines | **adapted** — `AgentFamily` includes `grok`; `zeroTokenLogCache` capped; our `lastUserMessageLocks` expiry pruning kept. |
| `f3ee4c6` no `kill-window` from background reconcile | **taken**. |
| `7474bf5` bind HTTP before initial refresh | **taken** — plus a follow-up: entrypoint tests await `startupReady` inside their mocks (its tail ran real tmux on the default socket), and the runner's run-wide private `TMUX_TMPDIR` backstop. |
| `9980106` real-tmux test isolation by construction | **adapted** — `privateTmuxEnv` for test envs, also in `slug-supersede`/`agb`; teardown stays on our `-S` `killTmuxServer`. |
| `02d9a0e` stall instrumentation (non-Devin slice) | **adapted** — `timedSpawnSync`, always-on `event_loop_lag` warn, `busy_timeout=250` without WAL (`scripts/agb` reads the db from a second process; Bun's SQLite 3.51.0 predates the WAL-reset fix), escalating ws stall cooldown, aggregated `terminal_output_dropped`. Devin parts and logger flush/exit hooks skipped. |
| `5e2d130` one tmux identity probe per refresh tick | **adapted** — no `NO_COLOR` session option here, so reconfigure covers mouse mode only. |
| `4671d40` outlier slow spawns bypass the rate limiter | **taken**. |
| `953ef7c` `AGENTBOARD_ATTACH_DEDUP_MS` + double-attach de-flake | **taken** — the known-flaky note is gone. |
| `3888f43` data-dir instance lock | **adapted** — lock half only (SessionList DnD half skipped); runner + e2e set `AGENTBOARD_DATA_DIR`. |
| `9d28d18`, Devin parts of `02d9a0e` | **skipped** — no Devin support in our tree. |
| `9f2e4ad` iOS identical-repaint selection fix | **skipped** — patches xterm's accessibility row repaint from the client (`a11yRowStability.ts`) plus iOS-sim tooling; not taken this round. |
| `c99b1ac` per-connection grouped sessions for external sessions | **deferred** — adds sync tmux spawns per session switch. |
| `057ee24` surface tmux copy mode | **taken** — the Copy mode / Exit control reads the existing 750 ms copy-mode poll and re-renders only on a change. |
| `79d0036` mobile terminal controls | **skipped** — mobile-only (`md:` resets it on desktop); neither `057ee24` nor `34d936e` needs it textually. |
| `09b5747` direct session shortcuts (mod+1..9) | **adapted** — the e2e target window is created on the private server via `-S`. |
| `0d28f78` clipboard file paths | **taken**. |
| `34d936e` device-file paste (`/api/paste-file`, `useBrowserPaste`, `PasteStatus`) | **adapted** — kept `493a6d4`'s `isInputReady` gating; see "Device-file paste adaptations" under ours. README keeps our 20 MB image cap; the mobile Paste button keeps our position and sizing; arrow-keys/manual-paste e2e specs dropped (not in our tree); browser-files e2e uses `-S`. |
| `49c2882` multipart parse without `formData()` | **adapted** — byte search via `Buffer.indexOf` (40 MB body: 3.5 ms vs 48 ms on the event loop). |
| `13d7b9b` Finder path trailing space | **taken**. |
| `40fd99d` non-PNG clipboard images | **taken**. |
| `b0f9e49`→`25ae9f1`→`1de1223` PR tracking via log parsing | **taken**; hydration then moved off the cold scan (see "PR chip hardening" under ours). |
| `c7f5618` PR state dots + hover cards | **adapted** — dropped the `index.css` hunk that lifts a hovered `.session-row` to `z-index: 20`; the card renders through a portal. |
| `14fe6fa`, `cf5ee89`, `e7e94b1`, `29f8d3f`, `c0a5dce`, `85f9f87`, `9b4fb59`, `b1ca734`, `927400b` PR chip fixes | **taken**. |
| `2f04051` PR chip false positives | **adapted** — dropped `bunfig.toml` (release-age excludes for upstream's npm binaries); its Grok hunk landed with `e978133`. |
| `e978133`→`5db356b` Grok log ingestion | **adapted** — no Devin; dropped the db CHECK, type unions and AgentIcon hunks (ours had grok); fixed the Grok telemetry leak (see ours). Wake resumes grok with `grok --resume {sessionId}` (`GROK_RESUME_CMD`) instead of falling through to the Codex command. |
| `477ee62` modal mount focus timers | **adapted** — SettingsModal without `87dac1e`'s terminal-colors context; mobile-controls e2e hunk dropped. |
| `d475e29` `is_pinned` → `is_hibernating` | **adapted** — `scripts/agb list` queries `is_hibernating = 1` in the same commit; fork tests renamed; dropped `notes/session-persistence-split.md` (upstream's plan, calls for WAL). In-place `RENAME COLUMN`, no down migration; verified on a snapshot of the live DB. |
| `9a24e4d` match windows via AskUserQuestion recaps | **taken** — on top of `341d296`, uses the shared `isGrokTelemetryFile`. |
| `b40a090` scroll selected session into view | **adapted** — the sidebar keeps our `sticky top-0 z-20` and gains `ref={listScrollRef}` + `scroll-pt-10`; the mobile strip keeps our spacing and `scroll-smooth`. |
| `87dac1e` global terminal colors | **skipped** — not taken this round. |
| `f2a85a1` Grok launch preset | **already had** — our presets carry `grok`. |
| `4a0574e` subagent-created PR attribution | **skipped** — needs omp. |
| `d26eeef`→`d9a7366` status rail | **skipped**. |
| `6cff6bb` omp agent | **skipped**. |
| `4128267`→`55e32ea` yolo mode | **skipped**. |
| `dab8070` server-side settings sync | **skipped**. |
| `37ee07e` numbered presets in the new-session modal | **skipped**. |
| mobile chain `3a94c9e` `3a6d06f` `9b6cb05` `55fe125` `5b56134` `c8ca2bd` `2dcc329` `4f18cfa` `bf7647f` `3b1b35c` `90abd60` `b18750f` `185a65c` `9421d38` | **skipped** — our mobile controls stay on the DPad layout. |
| Devin `3d8057f` `9c120b1` `4fb640d` | **skipped** — no Devin support in our tree. |
| release/npm/CI chores (`303cc58` `eac4352` `6ae71d6` `d127a0a` `76c9a49` `777239b` `aeec6bb` `de19f47` `1c7f3da` `10431f2` `a0d9d55` `9117ee9` `54bf377` `6b9e769` `4b8528f` `869ea02` `771af30`, `chore(master): release …`, `sync optionalDeps …`) | **skipped** — upstream's release pipeline; `76c9a49`/`869ea02` would open release PRs or commit to our master. |
| `5fd795b` hide bootstrap placeholder in external sessions | **not evaluated** — outside this round. |

### Naive-sync hazards (do NOT)

- **Don't re-add `concurrently`** — it was the shell-quote vulnerability vector; we
  removed it. If a merged `package.json` reintroduces it, drop it + keep the override.
- **Don't take upstream's `package.json`/`bun.lock` wholesale** — reverts our vite
  versions and `dev*` scripts. Merge: keep ours, add their `overrides` block only.
- **Don't cherry-pick `9eec9db`/`000f9ad`** — re-conflicts our equivalent code.
- **Don't drop either half of the overlay fix** — ours (`isolate`) and upstream's
  (`inert`, in `9166cd3`) fix the same click bug; keep both, test before trusting.
- **Don't drop attach-fail `dispose()` in `PtyTerminalProxy`** — orphans
  `…-ws-<uuid>` sessions (pty-pool exhaustion class). Upstream has this as of
  `2e6903f` (#160); keep both sides' version of the guard when re-merging.
- **Don't drop batched wheel SGR sends** when re-merging `useTerminal` — keep
  one `terminal-input` per accum flush; only gate `requestCopyModeCheck` on
  `!appMouseRef`.
- **Don't take upstream's fixed 72h history window** in `logPoller` — keep
  `getHistoryMaxAgeHours` (`loadSessionRecordsForMatch` /
  `loadDormantSessionRecords`).
- **Don't switch `agentboard.db` to WAL** while `scripts/agb` reads it with
  `sqlite3` from a second process: Bun's SQLite 3.51.0 predates the WAL-reset
  race fix (3.51.3).
- **Don't take upstream's env-only tmux calls in tests or e2e** — kill/mutate
  by explicit `-S`; upstream's e2e teardown also falls back to the shared server.
- **Don't let an entrypoint test restore mocks before `startupReady`** — since
  `7474bf5` the startup refresh outlives the import.
- **Don't reintroduce `Bun.spawnSync` on the connect/attach/switch/resize/close
  paths, or proxy creation in the websocket `open` handler** — each blocks every
  client while tmux answers, and an eager proxy turns browser connect retries
  into tmux work plus `new-session -t` shells.
- **Don't make paste or the copy-mode cancel fire-and-forget without ordering
  input behind them** — a keystroke that overtakes them submits early or lands
  in the copy-mode key table.
- **Don't rename or drop an `agent_sessions` column without updating
  `scripts/agb` in the same commit** — `agb list` reads the db with `sqlite3`
  and queries `is_hibernating = 1`. A mismatch prints a `no such column`
  error, then "No hibernating Agentboard sessions.", and exits 0. The
  migration runs when the server starts, so the agb on disk must match the
  server version that last opened the db. `agb.test.ts` covers `list`.
- **Don't hydrate sessions through `getSessionPullRequests`** — it scans a cold
  log from the start on the event loop (379 ms across 234 sessions at startup).
  Hydration uses `getCachedSessionPullRequests`.
- **Don't take upstream's paste flow over our Codex branch** — upstream checks
  browser files before `hasImage`, which uploads a Codex image and types a
  path instead of sending Ctrl+V.

## Watch-list (recurring concerns as we use this more)

- **pty/tmux leaks** — THE incident class. Every spawned tmux session and
  pty-backed process must be torn down at its lifecycle end (ws disconnect,
  test teardown, error paths in `PtyTerminalProxy.doStart`). Tests must never
  create sessions on the default socket — isolate via `TMUX_TMPDIR` and tear the
  whole isolated server down with `kill-server`. See incident below.
- **Async proxy lifecycle races** — tmux calls in `PtyTerminalProxy` now yield,
  so `dispose()` can run while `doStart`/`doSwitch` is mid-flight. A dispose
  during `new-session` may kill before the session exists: `doStart` checks
  `startAttemptId` after every await and disposes again, and disposes after a
  failed or timed-out `new-session`. `doSwitch` must not set READY over DEAD.
  Keep those checks when editing either method.
- **Stuck shells from grouped sessions** — `tmux new-session -t <group>`
  (`PtyTerminalProxy.doStart` on a socket's first attach, `SessionManager` group
  recovery) spawns a throwaway default-shell window and closes its pty without
  signalling it. If the shell hasn't taken its tty yet, zsh blocks forever and
  pins a pty. Signature: `-zsh` child of the tmux server, not a pane, fds 0–2
  only. Reconnect storms multiply it (2026-09-28: 110 stuck shells, ptys at
  158/511). `src/server/stuckShellReaper.ts` SIGHUPs them every minute
  (`AGENTBOARD_STUCK_SHELL_REAPER=false` disables). Real fix belongs in tmux.
- **Isolated tmux must use `-S`** — a missing `TMUX_TMPDIR` silently falls back
  to the default socket, and an inherited `TMUX` overrides `TMUX_TMPDIR`. Any
  call that can mutate or kill must target `-S <dir>/tmux-<uid>/default`.
- **SIGUSR1 socket recovery trusts `<dataDir>/tmux-server.pid`** — when
  `has-session` fails with a connection error, SessionManager signals the pid
  recorded there. An instance on a different tmux socket must use its own data
  dir (tests and e2e do), or it signals the wrong server and then refuses to
  start a replacement.
- **Data-dir instance lock** — `<dataDir>/server.lock` is taken over only when
  its pid is dead; if a crashed server's pid is reused within launchd's 10s
  throttle, the restart exits `instance_lock_held` until that pid goes away
  (KeepAlive keeps retrying).
- **Hot-path perf** — terminal output and input batching. Remaining main-thread
  `spawnSync`s on hot paths: the per-refresh-tick base-session probe
  (`SessionManager.ensureSession` → `display-message`, every 2 s and after
  Enter), `probeWindow` when a tracked window is missing from a snapshot, the
  sync `listWindows` fallback when the refresh worker fails, paste
  (`load-buffer` + `paste-buffer`), and all pipe-pane mode input, scroll,
  resize and its 2 s target monitor. Per refresh tick, each active session
  also runs `getCachedSessionPullRequests` (a `statSync` plus at most 256 KB
  of appended log when its size moved). Per xterm keydown: the mod+digit
  shortcut check (regex + settings-store read).
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
