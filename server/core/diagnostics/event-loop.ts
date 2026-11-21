/**
 * Event-loop delay of this process: p50 / p99 / max over the last minute (six windows of 10 s, the measure of
 * perf_hooks.monitorEventLoopDelay taken by a 10 ms timer, see below) and since start (monitorEventLoopDelay itself). Shown in GET /api/v1/admin/health (process.eventLoop and the "Event loop" check)
 * and so in the diagnostics bundle; the load harness records it (scripts/bench/load). Load test, November 2026: the
 * server had no measure of its own, the harness could only probe from outside at 1 s resolution.
 */
import { createHistogram, monitorEventLoopDelay, performance, type ELDHistogram, type RecordableHistogram } from 'node:perf_hooks'

export interface LoopDelay { p50Ms: number; p99Ms: number; maxMs: number; samples: number }
export interface EventLoopStats { lastMinute: LoopDelay; sinceStart: LoopDelay; resolutionMs: number }

const RESOLUTION_MS = 10
const WINDOW_MS = 10_000
const WINDOWS = 6
/** the "Event loop" health check warns above this p99 over the last minute (hosting spec, exit check 7: 100 ms) */
export const LOOP_P99_WARN_MS = 100

// monitorEventLoopDelay's own histogram cannot be merged (Node refuses it in RecordableHistogram.add) and only counts
// since its last reset, so the same measure is taken here: how late a 10 ms timer runs, in 10 s windows
let current: RecordableHistogram | null = null
let eld: ELDHistogram | null = null
let ring: RecordableHistogram[] = []
let sampler: NodeJS.Timeout | null = null
let rotator: NodeJS.Timeout | null = null
let last = 0

const ms = (ns: number): number => Math.round((Number.isFinite(ns) ? ns : 0) / 1e4) / 100
const summary = (h: { count: number; max: number; percentile(p: number): number }): LoopDelay =>
  h.count ? { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max), samples: h.count } : { p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 }

function rotate(): void {
  if (!current) return
  ring.push(current)
  if (ring.length > WINDOWS - 1) ring = ring.slice(-(WINDOWS - 1))
  current = createHistogram()
}

/** starts measuring (idempotent; the timers do not keep the process alive) */
export function startLoopMonitor(): void {
  if (sampler) return
  current = createHistogram()
  eld = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  eld.enable()
  last = performance.now()
  sampler = setInterval(() => {
    const now = performance.now()
    // nanoseconds, at least 1 (a histogram records positive integers)
    current!.record(Math.max(1, Math.round((now - last - RESOLUTION_MS) * 1e6)))
    last = now
  }, RESOLUTION_MS)
  sampler.unref()
  rotator = setInterval(rotate, WINDOW_MS)
  rotator.unref()
}

export function stopLoopMonitor(): void {
  if (sampler) clearInterval(sampler)
  if (rotator) clearInterval(rotator)
  eld?.disable()
  sampler = rotator = current = eld = null
  ring = []
}

/** the delay over the last minute (the completed 10 s windows and the current one) and since the monitor started */
export function eventLoopStats(): EventLoopStats {
  startLoopMonitor()
  const minute = createHistogram()
  for (const w of ring) minute.add(w)
  minute.add(current!)
  // monitorEventLoopDelay records the whole interval of its timer: the delay is what exceeds the resolution
  const d = summary(eld!)
  const less = (v: number) => Math.max(0, Math.round((v - RESOLUTION_MS) * 100) / 100)
  const sinceStart = d.samples ? { p50Ms: less(d.p50Ms), p99Ms: less(d.p99Ms), maxMs: less(d.maxMs), samples: d.samples } : d
  return { lastMinute: summary(minute), sinceStart, resolutionMs: RESOLUTION_MS }
}
