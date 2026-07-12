// Memory sampler (fork-only) — see FORK.md / notes/memory-sampling.md.
//
// Continuous process.memoryUsage() ring so multi-day heap growth is visible
// without Activity Monitor, and so weekly recycle can log BEFORE/AFTER heap
// (not just RSS/footprint). Cheap by design: no phys_footprint on the timer.
import { logger } from './logger'

export interface MemorySample {
  ts: number
  uptimeSec: number
  pid: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  physFootprint: number | null
}

const intervalMsRaw = Number(process.env.AGENTBOARD_MEMORY_SAMPLE_MS)
const intervalMs =
  Number.isFinite(intervalMsRaw) && intervalMsRaw > 0 ? intervalMsRaw : 300_000

const historyMaxRaw = Number(process.env.AGENTBOARD_MEMORY_HISTORY_MAX)
// ~14 days at 5 min ≈ 4032; default 4096.
const historyMax =
  Number.isFinite(historyMaxRaw) && historyMaxRaw > 0
    ? Math.floor(historyMaxRaw)
    : 4096

// Log every N ticks so agentboard.log keeps a sparse slope across recycle.
const LOG_EVERY_N = 12

const ring: MemorySample[] = []
let logTick = 0
let started = false

export function sampleMemory(physFootprint: number | null = null): MemorySample {
  const mu = process.memoryUsage()
  return {
    ts: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    rss: mu.rss,
    heapTotal: mu.heapTotal,
    heapUsed: mu.heapUsed,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
    physFootprint,
  }
}

function pushSample(sample: MemorySample): void {
  ring.push(sample)
  while (ring.length > historyMax) {
    ring.shift()
  }
}

export function getLatestSample(): MemorySample | null {
  return ring.length > 0 ? ring[ring.length - 1]! : null
}

export function getHistory(): MemorySample[] {
  return ring.slice()
}

/** Optional macOS phys_footprint (bytes). Slow shell-out — only on demand. */
export async function samplePhysFootprint(
  pid = process.pid
): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  try {
    const proc = Bun.spawn(['footprint', String(pid)], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    })
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return null
    // "phys_footprint: 165 MB" or similar
    const match = stdout.match(/phys_footprint:\s*([\d.]+)\s*(MB|GB|KB|B)?/i)
    if (!match) return null
    const n = Number(match[1])
    if (!Number.isFinite(n)) return null
    const unit = (match[2] || 'B').toUpperCase()
    if (unit === 'GB') return Math.round(n * 1024 * 1024 * 1024)
    if (unit === 'MB') return Math.round(n * 1024 * 1024)
    if (unit === 'KB') return Math.round(n * 1024)
    return Math.round(n)
  } catch {
    return null
  }
}

export async function getMemoryStatus(options: {
  history?: boolean
  footprint?: boolean
}): Promise<MemorySample & { history?: MemorySample[] }> {
  const phys = options.footprint ? await samplePhysFootprint() : null
  // Prefer live numbers for the top-level response so curl is always fresh.
  // Don't push on-demand footprint samples into the ring — ring stays timer-only.
  const live = sampleMemory(phys)
  if (options.history) {
    return { ...live, history: getHistory() }
  }
  return live
}

export function startMemorySampler(): void {
  if (started) return
  if (process.env.NODE_ENV === 'test') return
  if (process.env.AGENTBOARD_MEMORY_SAMPLE === 'false') return

  started = true
  const first = sampleMemory()
  pushSample(first)
  logger.info('memory_sampler_started', {
    intervalMs,
    historyMax,
    heapUsed: first.heapUsed,
    rss: first.rss,
  })

  setInterval(() => {
    const sample = sampleMemory()
    pushSample(sample)
    logTick += 1
    if (logTick % LOG_EVERY_N === 0) {
      logger.info('memory_sample', {
        uptimeSec: sample.uptimeSec,
        rss: sample.rss,
        heapUsed: sample.heapUsed,
        heapTotal: sample.heapTotal,
        external: sample.external,
        arrayBuffers: sample.arrayBuffers,
      })
    }
  }, intervalMs)
}
