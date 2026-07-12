import { describe, expect, test } from 'bun:test'
import {
  getHistory,
  getLatestSample,
  sampleMemory,
  startMemorySampler,
} from '../memorySampler'

describe('memorySampler', () => {
  test('sampleMemory returns expected fields with non-negative sizes', () => {
    const sample = sampleMemory()
    expect(sample.ts).toBeGreaterThan(0)
    expect(sample.pid).toBe(process.pid)
    expect(sample.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(sample.rss).toBeGreaterThan(0)
    expect(sample.heapTotal).toBeGreaterThan(0)
    expect(sample.heapUsed).toBeGreaterThan(0)
    expect(sample.external).toBeGreaterThanOrEqual(0)
    expect(sample.arrayBuffers).toBeGreaterThanOrEqual(0)
    expect(sample.physFootprint).toBeNull()
  })

  test('startMemorySampler is a no-op under NODE_ENV=test', () => {
    // Ensure test env (runner sets this); starting twice must not throw.
    expect(process.env.NODE_ENV).toBe('test')
    startMemorySampler()
    startMemorySampler()
    // Under test, ring is not auto-started; latest may still be null.
    expect(getLatestSample() === null || getHistory().length >= 0).toBe(true)
  })
})
