#!/bin/bash
# Install agentboard as a systemd user service on Linux (Ubuntu/Debian).
#
# Self-contained: installs missing prerequisites (git, tmux, curl, bun), builds
# the app, optionally sets up tmux-resurrect/continuum for reboot persistence,
# and installs a user service that restores saved tmux sessions BEFORE agentboard
# starts — avoiding the continuum boot-race deadlock (see FORK.md 2026-06-27).
#
# Env knobs:
#   AGENTBOARD_TMUX_PERSIST=0   skip the tmux-resurrect/continuum setup
#   AGENTBOARD_SKIP_BUILD=1     skip `bun install` + `bun run build`

set -euo pipefail

SERVICE_NAME="agentboard.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
SETUP_TMUX_PERSIST="${AGENTBOARD_TMUX_PERSIST:-1}"
SKIP_BUILD="${AGENTBOARD_SKIP_BUILD:-0}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }

# --- sudo + apt helpers --------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

APT_UPDATED=0
apt_install() {
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found — install these manually and re-run: $*"
    exit 1
  fi
  if [ "$APT_UPDATED" -eq 0 ]; then
    $SUDO apt-get update -y
    APT_UPDATED=1
  fi
  $SUDO apt-get install -y "$@"
}

# --- prerequisites -------------------------------------------------------------
command -v git  >/dev/null 2>&1 || { log "Installing git";  apt_install git;  }
command -v curl >/dev/null 2>&1 || { log "Installing curl"; apt_install curl; }
command -v tmux >/dev/null 2>&1 || { log "Installing tmux"; apt_install tmux; }

# bun (official installer drops it in ~/.bun/bin)
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    log "Installing bun"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
BUN_PATH="$(command -v bun)"
BUN_DIR="$(dirname "$BUN_PATH")"
log "Using bun at $BUN_PATH"

# --- build app -----------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  log "Skipping build (AGENTBOARD_SKIP_BUILD=1)"
else
  log "Installing dependencies (bun install)"
  ( cd "$REPO_DIR" && "$BUN_PATH" install )
  log "Building client (bun run build)"
  ( cd "$REPO_DIR" && "$BUN_PATH" run build )
fi

# --- tmux persistence (resurrect + continuum) ----------------------------------
if [ "$SETUP_TMUX_PERSIST" = "1" ]; then
  PLUGIN_DIR="$HOME/.tmux/plugins"
  mkdir -p "$PLUGIN_DIR"
  [ -d "$PLUGIN_DIR/tmux-resurrect" ] || {
    log "Cloning tmux-resurrect"
    git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect "$PLUGIN_DIR/tmux-resurrect"
  }
  [ -d "$PLUGIN_DIR/tmux-continuum" ] || {
    log "Cloning tmux-continuum"
    git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum "$PLUGIN_DIR/tmux-continuum"
  }

  TMUX_CONF="$HOME/.tmux.conf"
  MARK_BEGIN="# >>> agentboard tmux persistence >>>"
  if [ -f "$TMUX_CONF" ] && grep -qF "$MARK_BEGIN" "$TMUX_CONF"; then
    log "~/.tmux.conf already has the agentboard persistence block; leaving it"
  else
    if [ -f "$TMUX_CONF" ] && grep -qE "@continuum-restore" "$TMUX_CONF"; then
      warn "~/.tmux.conf already sets @continuum-restore outside our block."
      warn "It MUST be 'off', or agentboard's boot restore races continuum and deadlocks."
    fi
    [ -f "$TMUX_CONF" ] && cp "$TMUX_CONF" "$TMUX_CONF.bak.agentboard.$(date +%Y%m%d%H%M%S)"
    log "Appending agentboard persistence block to ~/.tmux.conf"
    cat >> "$TMUX_CONF" << 'TMUXEOF'

# >>> agentboard tmux persistence >>>
# Continuum SAVES periodically; restore is OFF on purpose. agentboard starts the
# tmux server at boot, and continuum's server-start restore would race it and
# deadlock. The systemd service restores once, before agentboard, instead.
set -g @resurrect-capture-pane-contents 'off'
set -g @continuum-restore 'off'
run-shell ~/.tmux/plugins/tmux-resurrect/resurrect.tmux
run-shell ~/.tmux/plugins/tmux-continuum/continuum.tmux
# <<< agentboard tmux persistence <<<
TMUXEOF
  fi
fi

# --- systemd user service ------------------------------------------------------
RESTORE_PRE=""
if [ "$SETUP_TMUX_PERSIST" = "1" ]; then
  # `-` prefix: a failed/no-op restore must never block the service from starting.
  RESTORE_PRE="ExecStartPre=-$REPO_DIR/scripts/tmux-restore-once.sh"
fi

cat > "$SCRIPT_DIR/$SERVICE_NAME" << EOF
[Unit]
Description=Agentboard - Terminal session dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
$RESTORE_PRE
ExecStart=$BUN_PATH run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=$BUN_DIR:$HOME/.bun/bin:$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF

echo "Generated $SERVICE_NAME with:"
echo "  WorkingDirectory: $REPO_DIR"
echo "  Bun:              $BUN_PATH"
[ -n "$RESTORE_PRE" ] && echo "  Pre-start:        scripts/tmux-restore-once.sh"

mkdir -p "$USER_SYSTEMD_DIR"
ln -sf "$SCRIPT_DIR/$SERVICE_NAME" "$USER_SYSTEMD_DIR/$SERVICE_NAME"

# Let the user service start on boot without an active login (headless remote).
if command -v loginctl >/dev/null 2>&1; then
  log "Enabling linger so agentboard starts on boot without login"
  $SUDO loginctl enable-linger "$USER" || warn "could not enable linger; service will start on first login"
fi

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

echo ""
log "Agentboard service installed and started."
echo ""
echo "Useful commands:"
echo "  systemctl --user status agentboard   # Check status"
echo "  systemctl --user restart agentboard  # Restart"
echo "  systemctl --user stop agentboard     # Stop"
echo "  journalctl --user -u agentboard -f   # View logs"
echo ""
echo "Remote access: agentboard binds the backend port (default 47329). For"
echo "Tailscale/LAN exposure set AGENTBOARD_AUTH_TOKEN (and AGENTBOARD_BIND_TAILSCALE)"
echo "in the [Service] Environment= lines — see README.md."
