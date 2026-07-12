# Memory sampling design (fork)

## Why

`phys_footprint` ~150 MB cold → ~1.3 GB after ~14 days. Weekly recycle resets
the process; code fixes (age-filtered poller history, lower match scrollback,
cache prune) need a **growth slope** we can read without Activity Monitor.

## Design (shipped)

**Endpoint + in-process ring + sparse pino** — not log-only, not fattening `/api/health`.

| Piece | Detail |
|---|---|
| Module | `src/server/memorySampler.ts` |
| Route | `GET /api/memory` (`?history=1`, `?footprint=1`) |
| Interval | 5 min (`AGENTBOARD_MEMORY_SAMPLE_MS`) |
| Ring | 4096 samples (~14 d @ 5 min); wiped on recycle |
| Sparse log | `memory_sample` every 12 ticks (~hourly) in `agentboard.log` |
| Disable | `AGENTBOARD_MEMORY_SAMPLE=false` |

### Metrics (always, cheap)

`ts`, `uptimeSec`, `pid`, `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`
from `process.memoryUsage()`.

### On demand only

`physFootprint` via macOS `footprint <pid>` — never on the timer (shell cost).

### Auth

Same as other `/api/*` (not exempt like `/api/health`). Localhost default.

## Recycle consumption

`scripts/agentboard-memory-recycle.sh` curls `/api/memory` on BEFORE/AFTER.

## What we deliberately skip

Prometheus/OTEL, heap snapshots, continuous profiling, UI charts, persisting
the ring across recycle, per-map attribution, stuffing metrics into `/api/health`.

## Related code fixes (same PR)

1. Log poller age-filters history via `getHistoryMaxAgeHours` (matches UI).
2. `DEFAULT_SCROLLBACK_LINES` 10000 → 1500.
3. Prune `emptyLogCache` / `rematchAttemptCache`; expire `lastUserMessageLocks`.
