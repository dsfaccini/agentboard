import { join } from 'node:path'

// The suite runs on a private tmux server (see playwright.config.ts). Address
// it with an explicit -S socket: TMUX_TMPDIR is ignored once its directory is
// gone and an inherited $TMUX overrides it, so either could land a mutation on
// the user's live server. Throws when the private dir is unset, so nothing
// ever falls back to the default socket.
export function privateTmuxSocket(): string {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir) {
    throw new Error('E2E_TMUX_TMPDIR is not set; refusing to use the default tmux server')
  }
  return join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default')
}
