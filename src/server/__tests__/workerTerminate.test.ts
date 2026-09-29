// LogMatchWorkerClient terminates a stalled match worker instead of
// abandoning it. Guard the runtime assumption behind that: under `bun` from
// source, terminate() stops a worker stuck in a busy loop without crashing.
import { expect, test } from 'bun:test'

const BUSY_WORKER = `
self.onmessage = () => { let x = 0; for (;;) x = (x + 1) % 1000003 }
self.postMessage('ready')
`

test('terminate() stops a worker stuck in a busy loop', async () => {
  const url = URL.createObjectURL(new Blob([BUSY_WORKER], { type: 'text/javascript' }))
  const worker = new Worker(url)
  await new Promise<void>((resolve) => {
    worker.onmessage = () => resolve()
  })
  worker.postMessage('spin')
  await Bun.sleep(50)

  const closed = new Promise<void>((resolve) => {
    worker.addEventListener('close', () => resolve())
  })
  worker.terminate()
  await closed

  // A still-spinning thread would burn about as much CPU as wall time.
  const before = process.cpuUsage()
  await Bun.sleep(300)
  const used = process.cpuUsage(before)
  expect((used.user + used.system) / 1000).toBeLessThan(150)
  URL.revokeObjectURL(url)
})
