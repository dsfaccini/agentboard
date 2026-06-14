const children = [
  Bun.spawn(['bun', 'run', 'dev:server'], {
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', 'dev:client'], {
    stdout: 'inherit',
    stderr: 'inherit',
  }),
]

let stopping = false

function stopChildren(signal: NodeJS.Signals = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of children) {
    try {
      child.kill(signal)
    } catch {
      // Process already exited.
    }
  }
}

process.on('SIGINT', () => {
  stopChildren('SIGINT')
})

process.on('SIGTERM', () => {
  stopChildren('SIGTERM')
})

const firstExit = await Promise.race(
  children.map(async (child) => await child.exited)
)

stopChildren()
await Promise.allSettled(children.map(async (child) => await child.exited))

process.exit(firstExit === 0 ? 0 : 1)
