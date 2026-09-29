// Fake Bun.spawn subprocesses for terminal-proxy tests. The proxies run tmux
// commands through their async `spawn` option; tests describe each command's
// result in the spawnSync shape (exit code + buffers) and wrap it here.
import type { SpawnFn } from '../terminal/types'

export interface FakeCommandResult {
  exitCode: number | null
  signalCode?: string | null
  stdout?: Buffer | string | null
  stderr?: Buffer | string | null
}

export type CommandResponder = (
  args: string[],
  options?: Parameters<typeof Bun.spawnSync>[1]
) => FakeCommandResult

function streamOf(data: Buffer | string | null | undefined): ReadableStream<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes && bytes.length > 0) controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
}

export function fakeCommandProcess(result: FakeCommandResult): ReturnType<typeof Bun.spawn> {
  return {
    pid: 1,
    stdout: streamOf(result.stdout),
    stderr: streamOf(result.stderr),
    exited: Promise.resolve(result.exitCode ?? 143),
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    kill: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>
}

/** A spawn that answers every call as a tmux command. */
export function commandSpawn(respond: CommandResponder): SpawnFn {
  return (args, options) =>
    fakeCommandProcess(respond(args, options as Parameters<typeof Bun.spawnSync>[1]))
}

/** Send `tmux … attach …` to `attachSpawn`; answer every other call via `respond`. */
export function routeTmuxSpawn(attachSpawn: SpawnFn, respond: CommandResponder): SpawnFn {
  const commands = commandSpawn(respond)
  return (args, options) =>
    args.includes('attach') ? attachSpawn(args, options) : commands(args, options)
}
