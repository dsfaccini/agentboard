import { describe, expect, test } from 'bun:test'
import {
  type CommandResult,
  findShellCandidates,
  parseEtime,
  parseLsofFds,
  parsePsOutput,
  reapStuckShells,
  selectStuckShells,
  startStuckShellReaper,
} from '../stuckShellReaper'

const PS_OUTPUT = [
  '  100     1 34-10:00:00 tmux new-session -d -s agentboard',
  '  201   100    05:00 -zsh',
  '  202   100 02-03:04:05 -zsh',
  '  203   100    00:30 -zsh',
  '  204   100    10:00 -zsh',
  '  205   999    10:00 -zsh',
  '  206   100    10:00 -bash',
  '  207   100    10:00 claude --resume abc',
].join('\n')

function fakeRun(overrides: Record<string, CommandResult> = {}) {
  const calls: string[][] = []
  const defaults: Record<string, CommandResult> = {
    'display-message': { exitCode: 0, stdout: '100\n' },
    'show-options': { exitCode: 0, stdout: '/bin/zsh\n' },
    'list-panes': { exitCode: 0, stdout: '204\n' },
    ps: { exitCode: 0, stdout: PS_OUTPUT },
    // 201 is stuck; 202 reopened its tty on fd 10, so it's a real shell.
    lsof: { exitCode: 0, stdout: 'p201\nfcwd\nftxt\nf0\nf1\nf2\np202\nfcwd\nf0\nf1\nf2\nf10\n' },
  }
  const results = { ...defaults, ...overrides }
  const run = async (cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd)
    const key = cmd[0] === 'tmux' ? cmd[1] : cmd[0]
    return results[key] ?? { exitCode: 1, stdout: '' }
  }
  return { run, calls }
}

describe('stuckShellReaper', () => {
  test('parseEtime handles every ps etime shape', () => {
    expect(parseEtime('05:07')).toBe(307)
    expect(parseEtime('01:00:00')).toBe(3600)
    expect(parseEtime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
    expect(parseEtime('garbage')).toBeNull()
  })

  test('parsePsOutput keeps multi-word commands and skips junk lines', () => {
    const entries = parsePsOutput(`${PS_OUTPUT}\nnot a ps line\n  300 1 bad-etime -zsh`)
    expect(entries).toHaveLength(8)
    expect(entries[7]).toEqual({ pid: 207, ppid: 100, ageSec: 600, command: 'claude --resume abc' })
  })

  test('findShellCandidates requires server child, login shell, non-pane, and age', () => {
    const candidates = findShellCandidates(parsePsOutput(PS_OUTPUT), {
      serverPid: 100,
      loginShell: '-zsh',
      panePids: new Set([204]),
      minAgeSec: 60,
    })
    expect(candidates).toEqual([201, 202])
  })

  test('selectStuckShells needs lsof evidence of startup-only fds', () => {
    const fds = parseLsofFds('p1\nfcwd\nftxt\nf0\nf1\nf2\np2\nf0\nf10\np3\n')
    // 1 stuck; 2 has fd 10; 3 listed without fds; 4 missing from lsof entirely.
    expect(selectStuckShells([1, 2, 3, 4], fds)).toEqual([1])
  })

  test('reapStuckShells SIGHUPs only stuck shells', async () => {
    const { run, calls } = fakeRun()
    const signals: Array<[number, string]> = []
    const reaped = await reapStuckShells(run, (pid, sig) => signals.push([pid, sig]))
    expect(reaped).toEqual([201])
    expect(signals).toEqual([[201, 'SIGHUP']])
    expect(calls.find((cmd) => cmd[0] === 'lsof')).toEqual(['lsof', '-a', '-p', '201,202', '-F', 'pf'])
  })

  test('reapStuckShells does nothing when tmux or ps is unavailable', async () => {
    const signal = () => {
      throw new Error('must not signal')
    }
    for (const failing of ['display-message', 'show-options', 'list-panes', 'ps']) {
      const { run } = fakeRun({ [failing]: { exitCode: 1, stdout: '' } })
      expect(await reapStuckShells(run, signal)).toEqual([])
    }
    const { run: badPid } = fakeRun({ 'display-message': { exitCode: 0, stdout: 'x\n' } })
    expect(await reapStuckShells(badPid, signal)).toEqual([])
  })

  test('reapStuckShells skips lsof when there are no candidates', async () => {
    const { run, calls } = fakeRun({ ps: { exitCode: 0, stdout: '' } })
    expect(await reapStuckShells(run, () => {})).toEqual([])
    expect(calls.some((cmd) => cmd[0] === 'lsof')).toBe(false)
  })

  test('reapStuckShells tolerates a shell exiting before the signal', async () => {
    const { run } = fakeRun()
    const reaped = await reapStuckShells(run, () => {
      throw new Error('ESRCH')
    })
    expect(reaped).toEqual([])
  })

  test('startStuckShellReaper is a no-op under NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test')
    expect(() => startStuckShellReaper()).not.toThrow()
  })
})
