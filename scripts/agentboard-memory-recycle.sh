#!/usr/bin/env bash
# Weekly (or on-demand) agentboard memory recycle.
#
# Why: the bun server's phys_footprint climbs over multi-day uptimes (~1.3 GB
# after 14d observed; ~165 MB cold). A clean launchd kickstart drops it without
# losing the DB. See FORK.md.
#
# Design goals:
#   1. Fully automatic when possible (no sudo, no modal).
#   2. After restart, ensure gh-gateway is healthy so AICAs never sit in a
#      window with broken `gh` / api.github.com.
#   3. pf is root-only; the durable LaunchDaemon (com.david.gh-gateway-pf)
#      reloads /etc/pf.conf every 10s. We wait for that before notifying David.
#   4. If sudo is still required, one interactive script does pfctl + verify
#      (no two-step "restart then remember to sudo").
set -euo pipefail

PORT="${PORT:-47329}"
URL="http://127.0.0.1:${PORT}"
LABEL="com.agentboard"
LOG_DIR="${LOG_DIR:-$HOME/.agentboard}"
LOG="$LOG_DIR/memory-recycle.log"
DOCTOR="${AGENTBOARD_GH_GATEWAY_DOCTOR:-$HOME/ai-coding-tools/github-graphql-proxy/scripts/gh-gateway-doctor.sh}"
FIX_PF="${AGENTBOARD_GH_GATEWAY_FIX_PF:-$HOME/ai-coding-tools/github-graphql-proxy/scripts/gh-gateway-fix-pf.sh}"

mkdir -p "$LOG_DIR"
# launchd may already tee this path; still log with timestamps for ad-hoc runs.
exec >>"$LOG" 2>&1

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*"; }

service_target() { echo "gui/$(id -u)/$LABEL"; }

bun_server_pid() {
  ps -axo pid=,args= | awk '/[b]un src\/server\/index\.ts/{print $1; exit}'
}

measure() {
  local pid rss fp
  pid="$(bun_server_pid || true)"
  if [ -z "${pid:-}" ]; then
    echo "pid=none rss_mb=? footprint_mb=?"
    return
  fi
  rss="$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ')"
  rss_mb="$(awk -v r="${rss:-0}" 'BEGIN{printf "%.0f", r/1024}')"
  fp="?"
  if command -v footprint >/dev/null 2>&1; then
    fp="$(footprint "$pid" 2>/dev/null | awk '/phys_footprint:/{print $2; exit}')"
  fi
  echo "pid=$pid rss_mb=$rss_mb footprint_mb=${fp:-?}"
}

wait_health() {
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

log "=== memory-recycle start ==="
mem_before="$(curl -fsS --max-time 2 "$URL/api/memory" 2>/dev/null || echo '{}')"
log "BEFORE $(measure) mem=$mem_before"

# Prefer kickstart (keeps service loaded). Fall back to bootstrap if unloaded.
if launchctl print "$(service_target)" >/dev/null 2>&1; then
  log "kickstart -k $(service_target)"
  launchctl kickstart -k "$(service_target)" || {
    log "kickstart failed; trying bootout+bootstrap"
    plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  }
else
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -f "$plist" ]; then
    log "service not loaded; bootstrap $plist"
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
      || launchctl load -w "$plist"
    launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else
    log "ERROR: $plist missing — run launchd/install.sh"
    exit 1
  fi
fi

if ! wait_health; then
  log "ERROR: agentboard health check failed after recycle ($URL/api/health)"
  log "AFTER $(measure)"
  osascript -e 'display notification "agentboard failed health check after memory recycle — see ~/.agentboard/memory-recycle.log" with title "agentboard recycle failed" sound name "Sosumi"' >/dev/null 2>&1 || true
  exit 1
fi
log "agentboard healthy"
mem_after="$(curl -fsS --max-time 2 "$URL/api/memory" 2>/dev/null || echo '{}')"
log "AFTER  $(measure) mem=$mem_after"

# --- gh-gateway: doctor self-heals (kickstart + wait for root pf-watchdog).
# Only if still down does it notify David with ONE command: gh-gateway-fix-pf.sh
# (sudo pfctl + verify) — never bare pfctl, never a two-step sequence.
if [ ! -x "$DOCTOR" ]; then
  log "gh-gateway doctor not found at $DOCTOR — skipping gateway check"
  log "=== memory-recycle done (no doctor) ==="
  exit 0
fi

log "running gh-gateway doctor (no-sudo heal + pf-watchdog wait)"
if doctor_out="$(bash "$DOCTOR" 2>&1)"; then
  log "gh-gateway OK: $doctor_out"
  log "=== memory-recycle done ==="
  exit 0
fi
log "doctor still failing after auto-heal (David notified by doctor if pf/sudo): $doctor_out"
log "manual one-shot if notification missed: $FIX_PF"
log "=== memory-recycle done (gateway needs attention) ==="
# exit 0: agentboard recycle itself succeeded; pf is a separate subsystem
exit 0
