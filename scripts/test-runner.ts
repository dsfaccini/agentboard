import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const skipIsolated = args.includes('--skip-isolated')
const passthroughArgs = args.filter((arg) => arg !== '--skip-isolated')

const TEST_TMUX_SESSION_PREFIXES: readonly string[] = [
  'agentboard-test-',
  'agentboard-hibernate-test-',
  'agentboard-dblattach-',
  'agentboard-throttle-',
  'agentboard-slug-test-',
]

const TEST_TMUX_TMPDIR_PREFIXES: readonly string[] = [
  'agentboard-tmux-',
  'agentboard-tt-',
]

let processCleanupRan = false

function createTempLogDirs() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tests-'))
  const claudeDir = path.join(tempRoot, 'claude')
  const codexDir = path.join(tempRoot, 'codex')
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true })
  return { tempRoot, claudeDir, codexDir }
}

function isTestTmuxSession(sessionName: string): boolean {
  return TEST_TMUX_SESSION_PREFIXES.some((prefix) => sessionName.startsWith(prefix))
}

function isTestTmuxTmpDir(entryName: string): boolean {
  return TEST_TMUX_TMPDIR_PREFIXES.some((prefix) => entryName.startsWith(prefix))
}

function listTmuxSessions(env?: NodeJS.ProcessEnv): string[] {
  try {
    const result = Bun.spawnSync(
      ['tmux', 'list-sessions', '-F', '#{session_name}'],
      { stdout: 'pipe', stderr: 'ignore', env, timeout: 5000 }
    )
    if (result.exitCode !== 0) {
      return []
    }
    return result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function killTmuxSession(sessionName: string, env?: NodeJS.ProcessEnv): void {
  try {
    Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
      stdout: 'ignore',
      stderr: 'ignore',
      env,
      timeout: 5000,
    })
  } catch {
    // Best-effort cleanup only; test failures should come from the test run.
  }
}

function cleanupDefaultTmuxSessions(): void {
  for (const sessionName of listTmuxSessions()) {
    if (isTestTmuxSession(sessionName)) {
      killTmuxSession(sessionName)
    }
  }
}

function cleanupTmuxTmpDir(tmuxTmpDir: string): void {
  const env = {
    ...process.env,
    TMUX_TMPDIR: tmuxTmpDir,
  }
  for (const sessionName of listTmuxSessions(env)) {
    killTmuxSession(sessionName, env)
  }
  fs.rmSync(tmuxTmpDir, { recursive: true, force: true })
}

function cleanupTmuxTmpDirs(): void {
  const roots = new Set(['/tmp', os.tmpdir()])
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isTestTmuxTmpDir(entry.name)) {
        continue
      }
      try {
        cleanupTmuxTmpDir(path.join(root, entry.name))
      } catch {
        // Keep scanning; one stale socket dir should not block the rest.
      }
    }
  }
}

function cleanupTmuxTestArtifacts(): void {
  try {
    cleanupDefaultTmuxSessions()
    cleanupTmuxTmpDirs()
  } catch {
    // Teardown runs as a backstop for abandoned tmux resources; it must not
    // mask the original test failure.
  }
}

function cleanupTmuxTestArtifactsOnce(): void {
  if (processCleanupRan) {
    return
  }
  processCleanupRan = true
  cleanupTmuxTestArtifacts()
}

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv) {
  try {
    const proc = Bun.spawn({
      cmd,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`)
    }
  } finally {
    cleanupTmuxTestArtifacts()
  }
}

process.on('exit', cleanupTmuxTestArtifactsOnce)
process.on('SIGINT', () => {
  cleanupTmuxTestArtifactsOnce()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanupTmuxTestArtifactsOnce()
  process.exit(143)
})

async function main() {
  const { tempRoot, claudeDir, codexDir } = createTempLogDirs()
  const tempLogFile = path.join(tempRoot, 'agentboard.log')
  const tempDbPath = path.join(tempRoot, 'agentboard.db')
  const env = {
    ...process.env,
    // React's act() requires the development build; force NODE_ENV=test
    // so tests pass even when the shell has NODE_ENV=production.
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    LOG_FILE: tempLogFile,
    AGENTBOARD_DB_PATH: tempDbPath,
    // Default skipMatchingPatterns excludes /tmp/* and /var/folders/* — both
    // common locations for test working directories (worktrees, CI runners on
    // some platforms). Tests that exercise matching logic from those paths
    // would otherwise be silently skipped. Tests that need specific skip
    // behavior pass patterns explicitly via the matcher API.
    AGENTBOARD_SKIP_MATCHING_PATTERNS: '',
    // Integration tests fetch their own spawned localhost servers. If a
    // package-manager proxy is set (e.g. Socket Firewall injects HTTP(S)_PROXY
    // with no NO_PROXY), Bun's fetch routes loopback through it and hangs
    // waitForHealth. Exempt loopback; real proxied hosts aren't affected.
    NO_PROXY: ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY]
      .filter(Boolean)
      .join(','),
    no_proxy: ['localhost', '127.0.0.1', '::1', process.env.no_proxy]
      .filter(Boolean)
      .join(','),
  }

  try {
    cleanupTmuxTestArtifacts()

    // Tests that either mutate globals or are sensitive to global mutations
    // must run in a separate process so they don't race with other test files.
    // PipePaneTerminalProxy reads Bun.spawnSync at construction time — if another
    // test file has patched it, the proxy gets a mock and start() becomes undefined.
    // hydrateSessionsEmptyGuard imports `../index` with an active Bun.spawnSync /
    // Bun.serve / setInterval mock; isolation keeps that mock window from
    // overlapping with any other test that captures globals at module load.
    const ISOLATED_FILES = new Set([
      'sessionRefreshWorker.test.ts',
      'pipePaneTerminalProxy.test.ts',
      'hydrateSessionsEmptyGuard.test.ts',
      // terminalProxyFactory.test.ts installs a top-level
      // mock.module('../config', ...) whose replacement omits many real
      // config fields. Bun's mock.restore() in afterAll does not fully
      // unwind module-level mocks, so the stripped config can leak into
      // any later test file that imports `../config` (notably
      // logPoller.test.ts, which depends on skipMatchingPatterns).
      'terminalProxyFactory.test.ts',
    ])

    // Client tests that install top-level mock.module(...) hooks must run in a
    // separate process — Bun's module mocks persist for the lifetime of the
    // test process, so they leak into any subsequent file that imports the
    // same module. app.test.tsx stubs ../components/SessionPreviewContent;
    // when bun's readdir order puts it before SessionPreviewModal.test.tsx
    // (e.g. on Linux ext4) the modal test sees the stub and breaks.
    const ISOLATED_CLIENT_FILES = new Set([
      'app.test.tsx',
    ])

    const serverTests: string[] = []
    const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
    for await (const file of serverGlob.scan({ onlyFiles: true })) {
      if (!ISOLATED_FILES.has(path.basename(file))) {
        serverTests.push(file)
      }
    }

    const clientTests: string[] = []
    const clientGlob = new Bun.Glob('src/client/__tests__/*.test.{ts,tsx}')
    for await (const file of clientGlob.scan({ onlyFiles: true })) {
      if (!ISOLATED_CLIENT_FILES.has(path.basename(file))) {
        clientTests.push(file)
      }
    }
    const sharedTestsDir = 'src/shared/__tests__'

    await runCommand(
      ['bun', 'test', ...passthroughArgs, ...serverTests, sharedTestsDir, ...clientTests],
      env
    )

    // Always run global-mutating tests in a separate process to prevent races.
    // Each file runs in its own bun process — isolation is from every other
    // file, not just from the main suite. terminalProxyFactory.test.ts
    // installs mock.module('../terminal/PipePaneTerminalProxy', ...) that
    // would otherwise leak into pipePaneTerminalProxy.test.ts on readdir
    // orderings where it loads first (Linux ext4).
    for (const file of ISOLATED_FILES) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, `src/server/__tests__/${file}`],
        env
      )
    }

    for (const file of ISOLATED_CLIENT_FILES) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, `src/client/__tests__/${file}`],
        env
      )
    }

    if (!skipIsolated) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, 'src/server/__tests__/isolated/'],
        env
      )
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    cleanupTmuxTestArtifactsOnce()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
