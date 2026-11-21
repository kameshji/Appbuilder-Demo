/** The event-loop delay measure (event-loop.ts): a blocked loop shows in the last minute and since start. */
import { describe, it, expect, afterAll } from 'vitest'
import { eventLoopStats, startLoopMonitor, stopLoopMonitor } from './event-loop.ts'

const block = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* hold the loop */ } }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('event-loop delay', () => {
  afterAll(() => stopLoopMonitor())
  it('reports p50 / p99 / max over the last minute and since start; a 150 ms block shows', async () => {
    stopLoopMonitor()
    startLoopMonitor()
    await wait(300)
    const quiet = eventLoopStats()
    expect(quiet.resolutionMs).toBe(10)
    expect(quiet.lastMinute.samples).toBeGreaterThan(5)
    expect(quiet.lastMinute.maxMs).toBeLessThan(100)
    block(150)
    await wait(100)
    const s = eventLoopStats()
    expect(s.lastMinute.maxMs).toBeGreaterThanOrEqual(120)
    expect(s.lastMinute.maxMs).toBeLessThan(1000)
    expect(s.sinceStart.maxMs).toBeGreaterThanOrEqual(120)
    expect(s.lastMinute.p50Ms).toBeLessThan(50)
    expect(s.lastMinute.p99Ms).toBeGreaterThanOrEqual(s.lastMinute.p50Ms)
    expect(Object.keys(s.lastMinute).sort()).toEqual(['maxMs', 'p50Ms', 'p99Ms', 'samples'])
  })
})
