# Systemd User Service

Run agentboard as a persistent systemd user service that starts on boot.

## Prerequisites

- Linux with systemd (Ubuntu/Debian — installer uses `apt-get`)
- `sudo` access (only to install missing system packages)

Everything else is bootstrapped by the installer — you don't need `bun`, `tmux`,
or the tmux plugins installed beforehand.

## Installation

```bash
./systemd/install.sh
```

The install script is **self-contained**. It will:
1. Install missing prerequisites (`git`, `curl`, `tmux`, and `bun` via the
   official installer)
2. `bun install` + `bun run build` the app
3. Set up `tmux-resurrect` + `tmux-continuum` for reboot persistence and append a
   marked block to `~/.tmux.conf` (backed up first; idempotent on re-run)
4. Generate `agentboard.service` with correct paths, including an `ExecStartPre`
   that restores saved tmux sessions **before** agentboard starts
5. Prompt for an optional `AGENTBOARD_AUTH_TOKEN` (blank to skip, or `gen` to
   generate one) — skippable since agentboard binds `127.0.0.1` by default. Skips
   silently when run non-interactively; pre-seed `AGENTBOARD_AUTH_TOKEN=…` to set
   it without the prompt.
6. `loginctl enable-linger` so the service starts on boot without a login
7. Install and start the service

### Why restore-before-start

agentboard starts the tmux server itself at boot. If tmux-continuum's
`@continuum-restore` were `on`, that server-start restore would run concurrently
with agentboard and deadlock (see [FORK.md](../FORK.md) → 2026-06-27 incident).
So the installer sets `@continuum-restore 'off'` and the service runs
`scripts/tmux-restore-once.sh` once, before agentboard. Continuum still **saves**.

### Env knobs

```bash
AGENTBOARD_TMUX_PERSIST=0 ./systemd/install.sh   # skip tmux-resurrect/continuum setup
AGENTBOARD_SKIP_BUILD=1   ./systemd/install.sh   # skip bun install + build
```

## Commands

```bash
# Check status
systemctl --user status agentboard

# View logs
journalctl --user -u agentboard -f

# Restart after code changes
systemctl --user restart agentboard

# Stop the service
systemctl --user stop agentboard

# Disable (won't start on boot)
systemctl --user disable agentboard
```

## Uninstall

```bash
systemctl --user stop agentboard
systemctl --user disable agentboard
rm ~/.config/systemd/user/agentboard.service
systemctl --user daemon-reload
```
