#!/bin/bash
# Restore saved tmux sessions ONCE, synchronously, before agentboard starts.
#
# Why this exists (boot race, 2026-06-27): agentboard's first tmux call
# (`tmux new-session`) starts the tmux server. With tmux-continuum's
# @continuum-restore set to 'on', that server-start fires a restore that runs
# CONCURRENTLY with agentboard's own session setup on the same server — they
# collide and deadlock (observed: wedged on a `tmux rename-window`, spinner
# stuck printing "Restoring..." into the message line forever).
#
# The fix is ordering: @continuum-restore is 'off' (see ~/.tmux.conf) and this
# script performs a single restore here, to completion, before agentboard runs.
#
# REQUIRES `set -g @continuum-restore 'off'` in ~/.tmux.conf. If continuum
# auto-restore is left on, you get this restore PLUS continuum's — a double
# restore that can re-trigger the deadlock.
set -u

# A server is already up — this is a KeepAlive restart over live sessions, not a
# cold boot. Restoring now would duplicate live sessions, so skip.
tmux has-session 2>/dev/null && exit 0

# Start the server with config sourced so resurrect's options + script path are set.
tmux start-server \; source-file "$HOME/.tmux.conf" 2>/dev/null

restore_script="$(tmux show-option -gqv @resurrect-restore-script-path)"
# The plugin sets that option via an async `run-shell`, so on a fresh server it
# may not be populated yet — fall back to the canonical path.
[ -z "$restore_script" ] && restore_script="$HOME/.tmux/plugins/tmux-resurrect/scripts/restore.sh"

# 180s watchdog: a pathological restore must never block agentboard from starting.
[ -x "$restore_script" ] && timeout 180 "$restore_script"
exit 0
