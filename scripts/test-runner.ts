import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const skipIsolated = args.includes('--skip-isolated')
const skipRealTmux = args.includes('--skip-real-tmux')
const passthroughArgs = args.filter(
  (arg) => arg !== '--skip-isolated' && arg !== '--skip-real-tmux'
)

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
// Private tmux dir handed to every test process (see main()).
let runTmuxTmpDir: string | null = null

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

function isolatedTmuxSocket(tmuxTmpDir: string): string {
  return path.join(tmuxTmpDir, `tmux-${os.userInfo().uid}`, 'default')
}

function listTmuxSessions(socketArgs: string[] = []): string[] {
  try {
    const result = Bun.spawnSync(
      ['tmux', ...socketArgs, 'list-sessions', '-F', '#{session_name}'],
      { stdout: 'pipe', stderr: 'ignore', timeout: 5000 }
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

function killTmuxSession(sessionName: string, socketArgs: string[] = []): void {
  try {
    Bun.spawnSync(['tmux', ...socketArgs, 'kill-session', '-t', sessionName], {
      stdout: 'ignore',
      stderr: 'ignore',
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
  // Address the isolated server by explicit socket, never via TMUX_TMPDIR: an
  // inherited $TMUX overrides TMUX_TMPDIR, and a missing TMUX_TMPDIR falls back
  // to the default socket. Either way list/kill would hit the live server.
  const socketArgs = ['-S', isolatedTmuxSocket(tmuxTmpDir)]
  for (const sessionName of listTmuxSessions(socketArgs)) {
    killTmuxSession(sessionName, socketArgs)
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
  removeRunTmuxTmpDir()
}

function removeRunTmuxTmpDir(): void {
  if (!runTmuxTmpDir) {
    return
  }
  try {
    cleanupTmuxTmpDir(runTmuxTmpDir)
  } catch {
    // Best-effort teardown backstop.
  }
  runTmuxTmpDir = null
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
  // A private tmux dir for every test process. Integration tests pin their
  // own TMUX_TMPDIR; this one catches any other tmux call that would fall back
  // to the default socket, i.e. the developer's live server (e.g. an async
  // startup path finishing after a test restored its Bun.spawnSync mock).
  // Under /tmp so the socket path stays short, and not an `agentboard-tmux-`
  // prefix, which the per-file sweep would kill mid-run.
  runTmuxTmpDir = fs.mkdtempSync(
    path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'agentboard-run-')
  )
  const tempLogFile = path.join(tempRoot, 'agentboard.log')
  const tempDbPath = path.join(tempRoot, 'agentboard.db')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMUX_TMPDIR: runTmuxTmpDir,
    // React's act() requires the development build; force NODE_ENV=test
    // so tests pass even when the shell has NODE_ENV=production.
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    LOG_FILE: tempLogFile,
    AGENTBOARD_DB_PATH: tempDbPath,
    // Test servers get their own data dir: the single-instance lock
    // (<dataDir>/server.lock) must never collide with a running instance, and
    // the tmux pid file SessionManager SIGUSR1s on socket loss lives there too
    // (test servers start with no socket on a private TMUX_TMPDIR, so the
    // shared default would point them at the live tmux server).
    AGENTBOARD_DATA_DIR: tempRoot,
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
  // An inherited $TMUX overrides TMUX_TMPDIR.
  delete env.TMUX

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
      // Entry-point tests patch Bun.serve/Bun.spawnSync/process.exit while
      // importing the server. Keep them away from real server/tmux tests.
      'directories.test.ts',
      'index.test.ts',
      'indexPortCheck.test.ts',
      'slug-supersede.integration.test.ts',
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
      // Measures process-wide CPU time; workers or timers leaked by other
      // files in a shared process would skew it.
      'workerTerminate.test.ts',
    ])

    // These spawn real servers, PTYs, and tmux clients. They still need process
    // isolation from global Bun.* mocks, but running them under coverage on
    // Linux CI can stall PTY attach readiness.
    const ISOLATED_REAL_TMUX_FILES = new Set([
      'double-attach.integration.test.ts',
      'hibernation.integration.test.ts',
      'integration.test.ts',
      'throttled-reconnect.integration.test.ts',
    ])

    // Client tests that install top-level mock.module(...) hooks must run in a
    // separate process — Bun's module mocks persist for the lifetime of the
    // test process, so they leak into any subsequent file that imports the
    // same module. app.test.tsx stubs ../components/SessionPreviewContent;
    // when bun's readdir order puts it before SessionPreviewModal.test.tsx
    // (e.g. on Linux ext4) the modal test sees the stub and breaks.
    const ISOLATED_CLIENT_FILES = new Set([
      'app.test.tsx',
      // Files that render motion/react (framer-motion) components. The
      // library keeps module-level projection state (a root node per
      // document) and schedules async frame callbacks on the global rAF;
      // both leak across files sharing a process. A leaked frame callback
      // firing after a file restored its window stub crashes with
      // "undefined is not an object (evaluating 'window.innerWidth')"
      // between tests, and the corrupted frameloop then fails unrelated
      // tests in later files (seen on Linux CI as useTerminal/SessionDrawer
      // failures; order- and timing-dependent, so macOS rarely hits it).
      'renderComponents.test.tsx',
      'sessionListComponent.test.tsx',
      'sessionDrawer.test.tsx',
      'sessionListFilters.test.tsx',
    ])

    const serverTests: string[] = []
    const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
    for await (const file of serverGlob.scan({ onlyFiles: true })) {
      const basename = path.basename(file)
      if (!ISOLATED_FILES.has(basename) && !ISOLATED_REAL_TMUX_FILES.has(basename)) {
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

    if (!skipRealTmux) {
      const argsWithoutCoverage = stripCoverageArgs(passthroughArgs)
      for (const file of ISOLATED_REAL_TMUX_FILES) {
        await runCommand(
          ['bun', 'test', ...argsWithoutCoverage, `src/server/__tests__/${file}`],
          env
        )
      }
    }

    for (const file of ISOLATED_CLIENT_FILES) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, `src/client/__tests__/${file}`],
        env
      )
    }

    if (!skipIsolated) {
      // Each file in isolated/ runs in its own process, same as ISOLATED_FILES
      // above: these files install top-level mock.module(...) hooks (e.g.
      // indexHandlers.test.ts stubs ../../terminal with a partial factory),
      // and Bun module mocks persist for the life of the process — on readdir
      // orderings where the mocking file loads first (Linux ext4), a shared
      // process poisons every later import of the same module.
      const isolatedTests: string[] = []
      const isolatedGlob = new Bun.Glob('src/server/__tests__/isolated/*.test.ts')
      for await (const file of isolatedGlob.scan({ onlyFiles: true })) {
        isolatedTests.push(file)
      }
      isolatedTests.sort()
      for (const file of isolatedTests) {
        await runCommand(['bun', 'test', ...passthroughArgs, file], env)
      }
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

function stripCoverageArgs(args: string[]) {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--coverage') continue
    if (arg.startsWith('--coverage=')) continue
    if (arg.startsWith('--coverage-reporter=')) continue
    if (arg === '--coverage-reporter') {
      index += 1
      continue
    }
    stripped.push(arg)
  }
  return stripped
}
