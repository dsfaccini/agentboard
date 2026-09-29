import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function isTmuxAvailable(): boolean {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

export function canBindLocalhost(): boolean {
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    })
    return true
  } catch {
    return false
  } finally {
    server?.stop(true)
  }
}

export function createTmuxTmpDir(prefix = 'agentboard-tmux-'): string {
  // These integration tests create a dedicated tmux server via TMUX_TMPDIR.
  // If the test process itself is running inside tmux, an inherited TMUX value
  // points tmux commands back at the parent server and silently defeats that
  // isolation.
  delete process.env.TMUX
  const baseDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  return fs.mkdtempSync(path.join(baseDir, prefix))
}

/**
 * Stop a spawned process deterministically: SIGTERM, then escalate to SIGKILL
 * if it doesn't exit within `timeoutMs`. Avoids an unbounded `await
 * proc.exited` when the process's graceful-shutdown handler stalls.
 */
export async function shutdownProcess(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 3000
): Promise<void> {
  try {
    proc.kill()
  } catch {
    return
  }

  const exited = proc.exited.catch(() => {})
  const timedOut = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs)
  })

  if ((await Promise.race([exited, timedOut])) === 'timeout') {
    try {
      proc.kill('SIGKILL')
    } catch {
      return
    }
    await proc.exited.catch(() => {})
  }
}

/**
 * Tear down the entire isolated tmux server living in `tmuxTmpDir`. Unlike
 * `kill-session` on the base session, this also kills server-spawned grouped
 * `…-ws-<uuid>` sessions and the daemonized tmux server process itself, so no
 * pty-holding session survives the test.
 *
 * Targets the socket explicitly with `-S`. Never go through TMUX_TMPDIR here:
 * an inherited $TMUX overrides it, and a missing TMUX_TMPDIR falls back to the
 * default socket, so kill-server would take down the developer's live server.
 */
export function killTmuxServer(tmuxTmpDir: string): void {
  const socket = path.join(tmuxTmpDir, `tmux-${os.userInfo().uid}`, 'default')
  try {
    Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
      // Bound the call so a wedged tmux server can't hang teardown.
      timeout: 5000,
    })
  } catch {
    // Best-effort teardown backstop; never mask the test result.
  }
}

type TmuxWindowListResult = {
  exitCode: number
  stderr: string
  windows: string[]
}

export function listTmuxWindows(
  sessionName: string,
  env?: NodeJS.ProcessEnv
): TmuxWindowListResult {
  const result = Bun.spawnSync(
    [
      'tmux',
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{session_name}:#{window_id}',
    ],
    { stdout: 'pipe', stderr: 'pipe', env }
  )

  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().trim(),
    windows: result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

export async function waitForTmuxWindows(
  sessionName: string,
  env?: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 2000
  const pollMs = options.pollMs ?? 100
  const startedAt = Date.now()
  let lastResult: TmuxWindowListResult = {
    exitCode: -1,
    stderr: '',
    windows: [],
  }

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = listTmuxWindows(sessionName, env)
    if (lastResult.windows.length > 0) {
      return lastResult.windows
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  const detail =
    lastResult.exitCode === 0
      ? 'tmux returned no windows'
      : `tmux list-windows exited ${lastResult.exitCode}${lastResult.stderr ? `: ${lastResult.stderr}` : ''}`
  throw new Error(
    `Failed to discover tmux windows for session ${sessionName} within ${timeoutMs}ms: ${detail}`
  )
}
