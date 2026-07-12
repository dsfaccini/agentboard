#!/bin/bash
# Install agentboard as a persistent launchd user agent on macOS.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
AGENTBOARD_DIR="$HOME/.agentboard"
BIN_DIR="$AGENTBOARD_DIR/bin"

# Prefer a real bun Mach-O binary. Never pick Socket Firewall package-manager
# shims ($HOME/.local/share/sfw-shims/bun): they re-exec through `sfw`, can exit
# 0 on network errors (so KeepAlive won't respawn), and inject HTTP(S)_PROXY
# that breaks long-lived servers. Same lesson as com.david.gh-gateway's plist.
resolve_bun() {
    local c
    for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
        [ -x "$c" ] || continue
        # shims are tiny shell scripts; real bun is a multi‑MB Mach-O
        [ "$(wc -c <"$c" | tr -d ' ')" -gt 1000000 ] || continue
        echo "$c"
        return 0
    done
    c="$(command -v bun 2>/dev/null || true)"
    case "$c" in
        ""|*sfw-shims*) return 1 ;;
        *)
            [ -x "$c" ] || return 1
            echo "$c"
            return 0
            ;;
    esac
}
BUN_PATH="$(resolve_bun || true)"
if [ -z "$BUN_PATH" ]; then
    echo "Error: real bun not found (install oven-sh/bun; refuse sfw-shims)"
    exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

TMUX_PATH="$(command -v tmux || true)"
if [ -z "$TMUX_PATH" ]; then
    echo "Error: tmux not found in PATH (brew install tmux)"
    exit 1
fi
TMUX_DIR="$(dirname "$TMUX_PATH")"

# Guard against paths containing characters that would corrupt plist XML or
# allow shell re-evaluation inside the generated wrapper. The generated scripts
# embed these paths inside double-quoted shell strings, so shell metachars
# (especially $, `, \) could trigger command substitution at service launch
# even if the user's path only looked unusual (e.g. a repo cloned under
# /tmp/foo$(bar)). Reject up front instead of trying to escape correctly.
for var in HOME REPO_DIR BUN_PATH TMUX_PATH; do
    case "${!var}" in
        *[\<\>\&\"\'\$\`\\\;\|\(\)]*)
            echo "Error: \$$var contains characters unsafe for plist XML or shell: ${!var}"
            exit 1 ;;
    esac
done

mkdir -p "$LAUNCH_AGENTS" "$BIN_DIR"

echo "Installing agentboard LaunchAgents with:"
echo "  Repo:  $REPO_DIR"
echo "  Bun:   $BUN_PATH"
echo "  Tmux:  $TMUX_PATH"
echo ""

# --- Wrapper script: sets PATH + UTF-8 locale, then execs bun src/server/index.ts.
# LaunchAgents start with a bare env; without LANG set, tmux mangles unicode.
# PATH covers common agent install locations (~/.local/bin for tools like
# claude and cursor-agent, Homebrew, ~/.cargo/bin, ~/go/bin) so that tmux
# windows spawned by agentboard can find whichever CLI the user launches.
cat > "$BIN_DIR/agentboard-run.sh" << EOF
#!/bin/bash
# PATH deliberately omits ~/.local/share/sfw-shims so \`bun run\` / child lookups
# cannot re-resolve to the Socket Firewall wrapper (see resolve_bun above).
export PATH="$BUN_DIR:$TMUX_DIR:$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/go/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="$HOME"
export NODE_ENV=production
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
# Drop proxy env that an interactive shell / sfw session may have leaked in.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy || true
cd "$REPO_DIR"
# Restore saved tmux sessions before agentboard starts the server (avoids the
# 2026-06-27 continuum-restore boot race). Requires @continuum-restore 'off' in
# ~/.tmux.conf — see scripts/tmux-restore-once.sh for the full rationale.
"$REPO_DIR/scripts/tmux-restore-once.sh" 2>/dev/null || true
# Direct entrypoint (not \`bun run start\`) so we never re-exec via PATH shims.
exec "$BUN_PATH" src/server/index.ts
EOF
chmod +x "$BIN_DIR/agentboard-run.sh"

# --- Logrotate script: copytruncate pattern so pino's open fd stays valid.
# Rotates agentboard.log (pino output) plus the launchd stdout/stderr capture
# files — without this, KeepAlive crash-loops can fill $HOME with the launchd
# capture logs while pino's rotation only ever touched agentboard.log.
cat > "$BIN_DIR/agentboard-log-rotate.sh" << 'EOF'
#!/bin/bash
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
LOG_DIR="${LOG_DIR:-$HOME/.agentboard}"
MAX_BYTES=$((50 * 1024 * 1024))
KEEP=5

rotate_if_large() {
    local log="$1"
    [ -f "$log" ] || return 0
    local size
    size=$(stat -f%z "$log" 2>/dev/null || echo 0)
    [ "$size" -ge "$MAX_BYTES" ] || return 0

    rm -f "$log.$KEEP.gz"
    for i in $(seq $((KEEP - 1)) -1 1); do
        [ -f "$log.$i.gz" ] && mv "$log.$i.gz" "$log.$((i+1)).gz"
    done

    cp "$log" "$log.1"
    : > "$log"
    gzip -f "$log.1"
}

# Rotate pino output and the launchd stdout/stderr captures.
rotate_if_large "$LOG_DIR/agentboard.log"
rotate_if_large "$LOG_DIR/launchd.out.log"
rotate_if_large "$LOG_DIR/launchd.err.log"
EOF
chmod +x "$BIN_DIR/agentboard-log-rotate.sh"

# --- Main service plist.
cat > "$LAUNCH_AGENTS/com.agentboard.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-run.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key><true/>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
    <key>LC_CTYPE</key><string>en_US.UTF-8</string>
  </dict>
  <key>StandardOutPath</key><string>$AGENTBOARD_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$AGENTBOARD_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

# --- Logrotate plist.
cat > "$LAUNCH_AGENTS/com.agentboard.logrotate.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.logrotate</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-log-rotate.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>LOG_DIR</key><string>$AGENTBOARD_DIR</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/agentboard-logrotate.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentboard-logrotate.log</string>
</dict>
</plist>
EOF

# --- Weekly memory recycle: kickstart agentboard, then ensure gh-gateway is OK.
# Full logic lives in the repo so we can edit without re-running install for every
# tweak; the wrapper only sets PATH/HOME and execs it.
RECYCLE_SRC="$REPO_DIR/scripts/agentboard-memory-recycle.sh"
cat > "$BIN_DIR/agentboard-memory-recycle.sh" << EOF
#!/bin/bash
export PATH="$BUN_DIR:$TMUX_DIR:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$HOME"
exec /bin/bash "$RECYCLE_SRC" "\$@"
EOF
chmod +x "$BIN_DIR/agentboard-memory-recycle.sh"

# Sunday 04:15 local — low agent traffic. No KeepAlive; calendar fire only.
cat > "$LAUNCH_AGENTS/com.agentboard.memory-recycle.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentboard.memory-recycle</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/agentboard-memory-recycle.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$BUN_DIR:$TMUX_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$AGENTBOARD_DIR/memory-recycle.log</string>
  <key>StandardErrorPath</key><string>$AGENTBOARD_DIR/memory-recycle.log</string>
</dict>
</plist>
EOF

# --- Load (idempotent: unload first if already loaded).
for label in com.agentboard com.agentboard.logrotate com.agentboard.memory-recycle; do
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS/$label.plist" 2>/dev/null || true
    launchctl unload "$LAUNCH_AGENTS/$label.plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$label.plist" 2>/dev/null \
      || launchctl load -w "$LAUNCH_AGENTS/$label.plist"
done

echo "Agentboard LaunchAgents installed and loaded."
echo ""
echo "Useful commands:"
echo "  launchctl list | grep agentboard                              # Status"
echo "  tail -f ~/.agentboard/agentboard.log                          # Logs"
echo "  launchctl kickstart -k gui/\$(id -u)/com.agentboard            # Restart"
echo "  ~/.agentboard/bin/agentboard-memory-recycle.sh                # Memory recycle now"
echo "  launchctl unload ~/Library/LaunchAgents/com.agentboard.plist  # Stop"
echo ""
echo "Weekly memory recycle: Sunday 04:15 local (com.agentboard.memory-recycle)."
echo "See launchd/README.md for optional tmux-crash watchdog."
