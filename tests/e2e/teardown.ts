import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { privateTmuxSocket } from './privateTmux'

// The suite ran on a private tmux server (see playwright.config.ts), so
// cleanup is one kill-server by explicit socket plus removing the directory.
// Without a private dir there is nothing of ours to clean, and teardown never
// touches a shared server.
export default async function teardown() {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir) {
    return
  }
  const socket = privateTmuxSocket()
  if (existsSync(socket)) {
    spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' })
  }
  rmSync(dir, { recursive: true, force: true })
}
