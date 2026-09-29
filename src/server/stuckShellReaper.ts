// Stuck-shell reaper (fork-only) — see FORK.md watch-list.
//
// `tmux new-session -t <group>` (PtyTerminalProxy.doStart on a socket's first attach,
// SessionManager's group recovery) spawns a throwaway default-shell window and
// destroys it once the session joins the group. tmux closes the pty master but
// never signals the child. When that happens before the shell has taken its
// tty, zsh blocks forever reopening ttyname(0) during startup and pins a pty
// slot. Reconnect storms leak them fast enough to threaten kern.tty.ptmx_max
// (the 2026-06-16 incident class).
//
// Every minute, SIGHUP login shells that are children of the tmux server, are
// not panes, are at least a minute old, and hold no fd beyond cwd/txt/0/1/2.
// A shell that got past startup holds its reopened tty on another fd, so real
// shells (popups included) never match.
import path from 'node:path'
import { logger } from './logger'

const MIN_AGE_SEC = 60
const INTERVAL_MS = 60_000
const COMMAND_TIMEOUT_MS = 5_000
const STARTUP_FDS = new Set(['cwd', 'txt', '0', '1', '2'])

export interface ProcessEntry {
  pid: number
  ppid: number
  ageSec: number
  command: string
}

export interface CommandResult {
  exitCode: number
  stdout: string
}

export type RunCommand = (cmd: string[]) => Promise<CommandResult>
export type SendSignal = (pid: number, signal: NodeJS.Signals) => void

/** Parse ps etime (`[[DD-]HH:]MM:SS`) into seconds. */
export function parseEtime(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  )
}

/** Parse `ps -A -o pid=,ppid=,etime=,command=` output. */
export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const ageSec = parseEtime(match[3])
    if (ageSec === null) continue
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageSec,
      command: match[4].trim(),
    })
  }
  return entries
}

export function findShellCandidates(
  entries: ProcessEntry[],
  options: { serverPid: number; loginShell: string; panePids: Set<number>; minAgeSec: number }
): number[] {
  return entries
    .filter(
      (entry) =>
        entry.ppid === options.serverPid &&
        entry.command === options.loginShell &&
        !options.panePids.has(entry.pid) &&
        entry.ageSec >= options.minAgeSec
    )
    .map((entry) => entry.pid)
}

/** Parse `lsof -F pf` output into each pid's fd names. */
export function parseLsofFds(output: string): Map<number, Set<string>> {
  const fds = new Map<number, Set<string>>()
  let current: Set<string> | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = new Set()
      fds.set(Number(line.slice(1)), current)
    } else if (line.startsWith('f') && current) {
      current.add(line.slice(1))
    }
  }
  return fds
}

/** Require positive evidence: lsof must have listed the pid with startup fds only. */
export function selectStuckShells(candidates: number[], fds: Map<number, Set<string>>): number[] {
  return candidates.filter((pid) => {
    const pidFds = fds.get(pid)
    if (!pidFds || pidFds.size === 0) return false
    for (const fd of pidFds) {
      if (!STARTUP_FDS.has(fd)) return false
    }
    return true
  })
}

async function runCommand(cmd: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exitCode, stdout }
}

export async function reapStuckShells(
  run: RunCommand = runCommand,
  signal: SendSignal = (pid, sig) => process.kill(pid, sig)
): Promise<number[]> {
  const server = await run(['tmux', 'display-message', '-p', '#{pid}'])
  const shell = await run(['tmux', 'show-options', '-gv', 'default-shell'])
  const panes = await run(['tmux', 'list-panes', '-a', '-F', '#{pane_pid}'])
  if (server.exitCode !== 0 || shell.exitCode !== 0 || panes.exitCode !== 0) return []
  const serverPid = Number(server.stdout.trim())
  const shellPath = shell.stdout.trim()
  if (!Number.isInteger(serverPid) || serverPid <= 0 || !shellPath) return []

  const ps = await run(['ps', '-A', '-o', 'pid=,ppid=,etime=,command='])
  if (ps.exitCode !== 0) return []
  const candidates = findShellCandidates(parsePsOutput(ps.stdout), {
    serverPid,
    loginShell: `-${path.basename(shellPath)}`,
    panePids: new Set(panes.stdout.split('\n').filter(Boolean).map(Number)),
    minAgeSec: MIN_AGE_SEC,
  })
  if (candidates.length === 0) return []

  // lsof exits 1 when any pid vanished, so trust its stdout, not its exit code.
  const lsof = await run(['lsof', '-a', '-p', candidates.join(','), '-F', 'pf'])
  const stuck = selectStuckShells(candidates, parseLsofFds(lsof.stdout))
  const reaped: number[] = []
  for (const pid of stuck) {
    try {
      signal(pid, 'SIGHUP')
      reaped.push(pid)
    } catch {
      // Already exited between the scan and the signal.
    }
  }
  if (reaped.length > 0) {
    logger.warn('stuck_shells_reaped', { count: reaped.length, pids: reaped })
  }
  return reaped
}

let inFlight = false

async function reapOnce(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    await reapStuckShells()
  } catch (error) {
    logger.warn('stuck_shell_reaper_error', { error: String(error) })
  } finally {
    inFlight = false
  }
}

export function startStuckShellReaper(): void {
  if (process.env.NODE_ENV === 'test') return // integration tests boot the real index.ts
  if (process.env.AGENTBOARD_STUCK_SHELL_REAPER === 'false') return
  void reapOnce()
  setInterval(() => void reapOnce(), INTERVAL_MS)
}
