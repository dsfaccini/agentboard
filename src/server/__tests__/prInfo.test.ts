import { describe, expect, test } from 'bun:test'
import { fetchPrChecks, fetchPrInfo, mapCheck, parsePrUrl } from '../prInfo'

describe('parsePrUrl', () => {
  test('parses github PR urls', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/12')).toEqual({
      url: 'https://github.com/o/r/pull/12',
      repo: 'o/r',
      number: 12,
    })
  })

  test('rejects non-PR urls', () => {
    expect(parsePrUrl('https://github.com/o/r')).toBeNull()
    expect(parsePrUrl('https://github.com/o/r/pull/')).toBeNull()
    expect(parsePrUrl('https://evil.com/o/r/pull/1')).toBeNull()
    expect(parsePrUrl('not a url')).toBeNull()
    expect(parsePrUrl('')).toBeNull()
  })
})

describe('fetchPrInfo', () => {
  test('returns invalid-url errors without spawning gh', async () => {
    const res = await fetchPrInfo(['not a url'])
    expect(res).toEqual([{ url: 'not a url', error: 'invalid url' }])
  })
})

describe('mapCheck', () => {
  test('passes check runs through with detailsUrl', () => {
    expect(
      mapCheck({
        name: 'ci',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/o/r/actions/runs/1',
      })
    ).toEqual({
      name: 'ci',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      link: 'https://github.com/o/r/actions/runs/1',
    })
  })

  test('keeps in-progress check runs pending', () => {
    expect(
      mapCheck({ name: 'ci', status: 'IN_PROGRESS', conclusion: null })
    ).toEqual({
      name: 'ci',
      status: 'IN_PROGRESS',
      conclusion: null,
      link: undefined,
    })
  })

  test('normalizes status contexts from state', () => {
    expect(
      mapCheck({
        context: 'lint',
        state: 'FAILURE',
        targetUrl: 'https://ci.example.com/1',
      })
    ).toEqual({
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      link: 'https://ci.example.com/1',
    })
  })

  test('treats pending/expected contexts as in-progress', () => {
    for (const state of ['PENDING', 'EXPECTED']) {
      expect(mapCheck({ context: 'ci', state })).toEqual({
        name: 'ci',
        status: 'IN_PROGRESS',
        conclusion: null,
        link: undefined,
      })
    }
  })
})

describe('gh pr view spawning', () => {
  test('dedupes in-flight lookups and runs at most 4 gh processes at once', async () => {
    const bun = Bun as unknown as { spawn: typeof Bun.spawn }
    const originalSpawn = bun.spawn
    const finishers: Array<() => void> = []
    const spawned: string[][] = []
    let running = 0
    let peak = 0
    bun.spawn = ((args: string[]) => {
      spawned.push(args)
      running++
      peak = Math.max(peak, running)
      let finish!: () => void
      const exited = new Promise<number>((resolve) => {
        finish = () => {
          running--
          resolve(0)
        }
      })
      finishers.push(finish)
      return {
        stdout: JSON.stringify({ state: 'OPEN', title: 't', isDraft: false }),
        exited,
        kill: () => {},
      }
    }) as unknown as typeof Bun.spawn
    try {
      const urls = Array.from(
        { length: 10 },
        (_, i) => `https://github.com/dedupe/r/pull/${i + 1}`
      )
      const first = fetchPrInfo(urls)
      const second = fetchPrInfo(urls.slice(0, 5))
      const checks = fetchPrChecks(urls[0]!)
      // Let queued lookups start as slots free up.
      while (spawned.length < 11 || running > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        finishers.splice(0).forEach((finish) => finish())
      }
      const [a, b] = await Promise.all([first, second, checks])
      expect(a).toHaveLength(10)
      expect(b).toHaveLength(5)
      // 10 info lookups shared by both batches + 1 checks lookup.
      expect(spawned).toHaveLength(11)
      expect(peak).toBeLessThanOrEqual(4)
    } finally {
      bun.spawn = originalSpawn
    }
  })
})
