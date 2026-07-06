// gh-gateway watchdog (fork-only) — see FORK.md.
//
// David routes `gh` / api.github.com through a local proxy (the "gh-gateway",
// ~/ai-coding-tools/github-graphql-proxy). When it dies, GitHub calls fail with
// `dial tcp 127.0.0.1:443` and every AICA wrongly suspects a GitHub outage. The
// gateway ships a self-healing doctor script; this watchdog runs it on an
// interval from agentboard's always-on process so no AICA has to run it by hand.
//
// The doctor is idempotent: it no-ops when the gateway answers, clears stale
// listeners + kickstarts the launchd service when it can, and only if the
// sudo-only pf redirect is still missing does it fire a throttled macOS
// notification. All of that is macOS-only (pf/launchd/osascript), so this
// watchdog is a no-op off darwin.
import path from 'node:path'
import { logger } from './logger'

const DEFAULT_DOCTOR = path.join(
  process.env.HOME || '',
  'ai-coding-tools/github-graphql-proxy/scripts/gh-gateway-doctor.sh'
)
const doctorPath = process.env.AGENTBOARD_GH_GATEWAY_DOCTOR || DEFAULT_DOCTOR

const intervalMsRaw = Number(process.env.AGENTBOARD_GH_GATEWAY_WATCHDOG_MS)
const intervalMs =
  Number.isFinite(intervalMsRaw) && intervalMsRaw > 0 ? intervalMsRaw : 60_000

// The doctor can block up to ~16s (two 6s curls + a 3s service restart wait).
const DOCTOR_TIMEOUT_MS = 30_000

let inFlight = false

async function runDoctor(): Promise<void> {
  if (inFlight) return // never stack runs if one hangs
  inFlight = true
  try {
    const proc = Bun.spawn(['bash', doctorPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: DOCTOR_TIMEOUT_MS,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = `${stdout}${stderr}`.trim()
    if (exitCode !== 0) {
      // Exit 1 means the gateway is down and needs David's sudo (pf redirect).
      // The doctor already fired the throttled notification; just record it.
      logger.warn('gh_gateway_needs_manual_fix', { output })
    } else if (output.includes('HEALED')) {
      logger.info('gh_gateway_healed', { output })
    } else {
      logger.debug('gh_gateway_ok', { output })
    }
  } catch (err) {
    logger.warn('gh_gateway_watchdog_error', { error: String(err) })
  } finally {
    inFlight = false
  }
}

export function startGhGatewayWatchdog(): void {
  if (process.env.NODE_ENV === 'test') return // don't spawn the doctor under test
  if (process.platform !== 'darwin') return
  if (process.env.AGENTBOARD_GH_GATEWAY_WATCHDOG === 'false') return
  if (!Bun.file(doctorPath).size) {
    logger.info('gh_gateway_watchdog_disabled', {
      reason: 'doctor script not found',
      doctorPath,
    })
    return
  }
  logger.info('gh_gateway_watchdog_started', { doctorPath, intervalMs })
  void runDoctor() // heal on boot, don't wait for the first tick
  setInterval(() => void runDoctor(), intervalMs)
}
