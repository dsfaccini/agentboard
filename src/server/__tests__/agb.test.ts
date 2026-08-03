import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { createTmuxTmpDir, isTmuxAvailable, killTmuxServer } from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()

if (!tmuxAvailable) {
  test.skip('tmux unavailable - skipping agb tests', () => {})
} else {
  describe('agb', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-agb-home-'))
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-agb-project-'))
    const commandDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-agb-bin-'))
    const databasePath = path.join(homeDir, '.agentboard', 'agentboard.db')
    const tmuxTmpDir = createTmuxTmpDir('agentboard-tmux-agb-')
    const sessionName = 'david-agb'
    const managerSessionName = `agentboard-agb-manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const commandRecordPath = path.join(homeDir, 'agent-command.txt')
    const scriptPath = path.join(process.cwd(), 'scripts', 'agb')
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      PATH: `${commandDir}:${process.env.PATH ?? ''}`,
      TMUX_TMPDIR: tmuxTmpDir,
      AGENTBOARD_DB_PATH: databasePath,
      AGB_TEST_RECORD_PATH: commandRecordPath,
      AGB_SKIP_SERVICE_CHECK: '1',
      AGB_NO_ATTACH: '1',
      AGB_SUSPEND_TIMEOUT_SECONDS: '2',
    }

    beforeAll(() => {
      const claudePath = path.join(commandDir, 'claude')
      fs.writeFileSync(
        claudePath,
        '#!/bin/bash\nif [ -n "${AGB_TEST_RECORD_PATH:-}" ]; then\n  printf "%s\\n%s\\n" "$PWD" "$*" > "$AGB_TEST_RECORD_PATH"\nfi\nwhile IFS= read -r line; do\n  [ "$line" = "/exit" ] && exit 0\ndone\n'
      )
      fs.chmodSync(claudePath, 0o755)

      const piPath = path.join(commandDir, 'pi')
      fs.writeFileSync(
        piPath,
        '#!/bin/bash\nwhile IFS= read -r line; do\n  [ "$line" = "/quit" ] && exit 0\ndone\n'
      )
      fs.chmodSync(piPath, 0o755)
    })

    afterAll(() => {
      killTmuxServer(tmuxTmpDir)
      fs.rmSync(homeDir, { recursive: true, force: true })
      fs.rmSync(projectPath, { recursive: true, force: true })
      fs.rmSync(commandDir, { recursive: true, force: true })
      fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
    })

    test('documents David and manager launch controls', () => {
      const result = runAgb(['--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Options for David:')
      expect(result.stdout).toContain('The default\n                    is david-agb')
      expect(result.stdout).toContain('Options for the Claude manager and launch helpers:')
      expect(result.stdout).toContain('--in-current-window')
    })

    test('starts a tagged agent window from an explicit path', () => {
      const result = runAgb(['claude', projectPath])
      const resolvedProjectPath = fs.realpathSync(projectPath)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`Started claude in ${resolvedProjectPath}`)

      const window = Bun.spawnSync(
        [
          'tmux',
          'list-windows',
          '-t',
          `=${sessionName}`,
          '-F',
          '#{window_id}\t#{@agentboard_agb}\t#{@agentboard_agent}\t#{pane_current_path}',
        ],
        { env: environment, stdout: 'pipe', stderr: 'pipe' }
      )
      expect(window.exitCode).toBe(0)
      const [tmuxWindow, tag, agent, currentPath] = window.stdout.toString().trim().split('\t')
      if (!tmuxWindow) {
        throw new Error('Expected a tmux window ID')
      }
      expect(tmuxWindow).toMatch(/^@\d+$/)
      expect(tag).toBe('1')
      expect(agent).toBe('claude')
      expect(currentPath).toBe(resolvedProjectPath)

      const db = initDatabase({ path: databasePath })
      db.insertSession({
        sessionId: 'agb-claude-session',
        logFilePath: path.join(homeDir, 'claude-session.jsonl'),
        projectPath: resolvedProjectPath,
        slug: null,
        agentType: 'claude',
        displayName: 'agentboard-agb-project',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: tmuxWindow,
        isPinned: false,
        lastResumeError: null,
        lastKnownLogSize: null,
        isCodexExec: false,
        launchCommand: 'claude',
      })
      db.close()
    })

    test('suspends tagged Claude sessions and saves terminal output', () => {
      const result = runAgb(['suspend', '--all'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Suspended claude session agb-claude-session')
      expect(result.stdout).toContain('claude --resume agb-claude-session')

      const windows = Bun.spawnSync(['tmux', 'list-windows', '-t', `=${sessionName}`], {
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(windows.exitCode).not.toBe(0)

      const transcriptDir = path.join(homeDir, '.agentboard', 'agb', 'transcripts')
      const snapshots = fs.readdirSync(transcriptDir)
      expect(snapshots).toHaveLength(1)
      expect(fs.statSync(path.join(transcriptDir, snapshots[0]!)).isFile()).toBe(true)
    })

    test('lists hibernating sessions with their resume command', () => {
      const db = initDatabase({ path: databasePath })
      db.orphanSession('agb-claude-session')
      db.close()

      const result = runAgb(['list'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('claude session agb-claude-session')
      expect(result.stdout).toContain('claude --resume agb-claude-session')
    })

    test('starts a manager Claude in its existing window with model arguments', async () => {
      const created = Bun.spawnSync(
        [
          'tmux',
          'new-session',
          '-d',
          '-P',
          '-F',
          '#{window_id}',
          '-s',
          managerSessionName,
          '-n',
          'manager-worker',
          '-c',
          projectPath,
        ],
        { env: environment, stdout: 'pipe', stderr: 'pipe' }
      )
      expect(created.exitCode).toBe(0)
      const tmuxWindow = created.stdout.toString().trim()
      expect(tmuxWindow).toMatch(/^@\d+$/)

      fs.rmSync(commandRecordPath, { force: true })
      const started = Bun.spawnSync(
        [
          'tmux',
          'send-keys',
          '-t',
          tmuxWindow,
          `exec ${shellQuote(scriptPath)} claude --in-current-window -- --model opus`,
          'Enter',
        ],
        { env: environment, stdout: 'pipe', stderr: 'pipe' }
      )
      expect(started.exitCode).toBe(0)
      await waitForFile(commandRecordPath)

      const [recordedPath, recordedArgs] = fs.readFileSync(commandRecordPath, 'utf8').trim().split('\n')
      expect(recordedPath).toBe(fs.realpathSync(projectPath))
      expect(recordedArgs).toBe('--model opus')

      const tag = Bun.spawnSync(['tmux', 'show-options', '-w', '-v', '-t', tmuxWindow, '@agentboard_agb'], {
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(tag.stdout.toString().trim()).toBe('1')

      const db = initDatabase({ path: databasePath })
      db.insertSession({
        sessionId: 'agb-manager-claude-session',
        logFilePath: path.join(homeDir, 'manager-claude-session.jsonl'),
        projectPath: fs.realpathSync(projectPath),
        slug: null,
        agentType: 'claude',
        displayName: 'agentboard-agb-manager-project',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: tmuxWindow,
        isPinned: false,
        lastResumeError: null,
        lastKnownLogSize: null,
        isCodexExec: false,
        launchCommand: 'claude --model opus',
      })
      db.close()

      const suspended = runAgb(['suspend', '--all'])
      expect(suspended.exitCode).toBe(0)
      expect(suspended.stdout).toContain('Suspended claude session agb-manager-claude-session')

      const hibernated = initDatabase({ path: databasePath })
      hibernated.orphanSession('agb-manager-claude-session')
      hibernated.close()
    })

    test('suspends Pi with its graceful quit command', () => {
      const piSessionName = `agentboard-agb-pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const started = runAgb(['pi', projectPath, '--session', piSessionName])
      if (started.exitCode !== 0) {
        throw new Error(started.stderr)
      }
      expect(started.exitCode).toBe(0)

      const window = Bun.spawnSync(
        ['tmux', 'list-windows', '-t', `=${piSessionName}`, '-F', '#{window_id}'],
        { env: environment, stdout: 'pipe', stderr: 'pipe' }
      )
      const tmuxWindow = window.stdout.toString().trim()
      expect(tmuxWindow).toMatch(/^@\d+$/)

      const piSessionPath = path.join(homeDir, 'pi-session.jsonl')
      const db = initDatabase({ path: databasePath })
      db.insertSession({
        sessionId: 'agb-pi-session',
        logFilePath: piSessionPath,
        projectPath: fs.realpathSync(projectPath),
        slug: null,
        agentType: 'pi',
        displayName: 'agentboard-agb-pi-project',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastUserMessage: null,
        currentWindow: tmuxWindow,
        isPinned: false,
        lastResumeError: null,
        lastKnownLogSize: null,
        isCodexExec: false,
        launchCommand: 'pi',
      })
      db.close()

      const suspended = runAgb(['suspend', '--all'])
      expect(suspended.exitCode).toBe(0)
      expect(suspended.stdout).toContain('Suspended pi session agb-pi-session')
      expect(suspended.stdout).toContain(`pi --session ${piSessionPath}`)
    })

    function runAgb(args: string[]) {
      const result = Bun.spawnSync(['bash', scriptPath, ...args], {
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    }

    function shellQuote(value: string): string {
      return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
    }

    async function waitForFile(filePath: string): Promise<void> {
      const deadline = Date.now() + 2000
      while (!fs.existsSync(filePath) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      if (!fs.existsSync(filePath)) {
        throw new Error(`Timed out waiting for ${filePath}`)
      }
    }
  })
}
