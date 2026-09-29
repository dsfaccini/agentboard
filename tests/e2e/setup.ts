import { spawnSync } from 'node:child_process'
import { privateTmuxSocket } from './privateTmux'

// The specs need at least one visible session card. A fresh base session only
// has the invisible bootstrap window (filtered from listings), and CI used to
// paper over that with a workflow step that pre-created an `agentboard`
// session on the default tmux server — which the suite no longer sees now
// that it runs on a private one (TMUX_TMPDIR, see playwright.config.ts).
// Create the visible window here instead, on the suite's private server.
export default async function setup() {
  const session = process.env.E2E_TMUX_SESSION
  if (!session) {
    throw new Error('E2E_TMUX_SESSION is not set')
  }
  const socket = privateTmuxSocket()

  const created = spawnSync(
    'tmux',
    ['-S', socket, 'new-session', '-d', '-s', session, '-n', 'test'],
    { encoding: 'utf-8' }
  )
  if (created.status === 0) {
    return
  }

  // The session already exists (the webServer's ensureSession won the race);
  // add the visible window to it.
  const added = spawnSync(
    'tmux',
    ['-S', socket, 'new-window', '-t', `=${session}`, '-n', 'test'],
    { encoding: 'utf-8' }
  )
  if (added.status !== 0) {
    throw new Error(
      `Failed to create test window in ${session}: ${created.stderr}${added.stderr}`
    )
  }
}
