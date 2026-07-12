#!/bin/bash
set -euo pipefail

LABEL="com.agentboard"
LOGROTATE_LABEL="com.agentboard.logrotate"
PORT="${PORT:-47329}"
URL="http://127.0.0.1:$PORT"
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *) SOURCE="$DIR/$TARGET" ;;
  esac
done
REPO_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGROTATE_PLIST="$HOME/Library/LaunchAgents/$LOGROTATE_LABEL.plist"

usage() {
  cat <<EOF
Usage: agentboard [start|stop|restart|status|logs|install|uninstall|url|recycle]

Default command: start

  recycle  Memory recycle: kickstart LaunchAgent, wait for health, run
           gh-gateway doctor (same as the weekly Sunday 04:15 job).
EOF
}

service_target() {
  echo "gui/$(id -u)/$LABEL"
}

is_loaded() {
  launchctl print "$(service_target)" >/dev/null 2>&1
}

install_service() {
  "$REPO_DIR/launchd/install.sh" >/dev/null
}

ensure_installed() {
  if [ ! -f "$PLIST" ] || [ ! -x "$HOME/.agentboard/bin/agentboard-run.sh" ]; then
    install_service
  fi
}

wait_for_health() {
  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_service() {
  ensure_installed
  if ! is_loaded; then
    launchctl load -w "$PLIST"
  fi
  launchctl kickstart -k "$(service_target)" >/dev/null 2>&1 || true
  if wait_for_health; then
    echo "Agentboard running: $URL"
  else
    echo "Agentboard start requested, but health check did not pass: $URL" >&2
    echo "Try: agentboard logs" >&2
    return 1
  fi
}

listener_pids() {
  lsof -n -P -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

kill_agentboard_listener() {
  local pid command
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      *"$REPO_DIR"*|*".agentboard/bin/agentboard-run.sh"*|*"bun src/server/index.ts"*|*"bun run start"*)
        kill "$pid" 2>/dev/null || true
        ;;
      *)
        echo "Leaving non-Agentboard listener on $PORT alone: pid $pid $command" >&2
        ;;
    esac
  done < <(listener_pids)
}

stop_service() {
  if is_loaded; then
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  fi
  kill_agentboard_listener
  echo "Agentboard stopped"
}

status_service() {
  if is_loaded; then
    echo "LaunchAgent: loaded"
  else
    echo "LaunchAgent: not loaded"
  fi

  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    echo "Health: ok"
    echo "URL: $URL"
  else
    echo "Health: unavailable"
    echo "URL: $URL"
    return 1
  fi
}

tail_logs() {
  mkdir -p "$HOME/.agentboard"
  tail -f "$HOME/.agentboard/agentboard.log" "$HOME/.agentboard/launchd.out.log" "$HOME/.agentboard/launchd.err.log"
}

uninstall_service() {
  stop_service >/dev/null || true
  launchctl bootout "gui/$(id -u)" "$LOGROTATE_PLIST" >/dev/null 2>&1 || launchctl unload "$LOGROTATE_PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST" "$LOGROTATE_PLIST"
  echo "Agentboard LaunchAgents removed"
}

command="${1:-start}"
case "$command" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  recycle)
    exec /bin/bash "$REPO_DIR/scripts/agentboard-memory-recycle.sh"
    ;;
  status)
    status_service
    ;;
  logs)
    tail_logs
    ;;
  install)
    install_service
    echo "Agentboard installed: $URL"
    ;;
  uninstall)
    uninstall_service
    ;;
  url)
    echo "$URL"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
