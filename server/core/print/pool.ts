/**
 * A small, bounded pool of worker threads for the CPU part of prints (pdf-worker.ts). One pool per process, shared by
 * every environment of the install. No new dependency: node:worker_threads.
 *
 * - size: `APPBUILDER_PRINT_WORKERS` (default 2; 0 runs the jobs in-process on the event loop, as before the November 2026 load-test fixes)
 * - queue: at most `APPBUILDER_PRINT_QUEUE` jobs wait (default 32); one more is refused with PrintBusyError (503)
 * - timeout per job: the worker running a job past its time is terminated (its CPU stops) and replaced
 * - one worker stays once started (warm); the others stop after 30 s idle; idle workers do not keep the process alive;
 *   close() waits for running jobs (5 s at most)
 */
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { PageLimitError } from './layout.ts'
import { runPrintJob, WORKER_TAG, type PrintJob, type PrintJobResult } from './pdf-worker.ts'

export class PrintBusyError extends Error {}
export class PrintTimeoutError extends Error {}

export interface PrintPoolOptions { size: number; queueLimit: number; idleMs?: number }
export interface PrintPoolStats { size: number; workers: number; busy: number; queued: number; done: number; failed: number; timedOut: number; refused: number }

interface Pending { job: PrintJob; timeoutMs: number; resolve: (r: PrintJobResult) => void; reject: (e: Error) => void }
interface Slot { w: Worker; busy: Pending | null; timer?: NodeJS.Timeout; idle?: NodeJS.Timeout; id: number }

const WORKER_URL = new URL('./pdf-worker.ts', import.meta.url)

export function createPrintPool(o: PrintPoolOptions) {
  const size = Math.max(0, Math.floor(o.size))
  const idleMs = o.idleMs ?? 30_000
  const slots: Slot[] = []
  const queue: Pending[] = []
  const stats = { done: 0, failed: 0, timedOut: 0, refused: 0 }
  let nextId = 1
  let inProcess = 0

  const toResult = (r: PrintJobResult): PrintJobResult => (r.bytes && !Buffer.isBuffer(r.bytes) ? { ...r, bytes: Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) } : r)

  function spawn(): Slot {
    const w = new Worker(WORKER_URL, { workerData: { tag: WORKER_TAG }, stdout: false, stderr: false })
    const s: Slot = { w, busy: null, id: 0 }
    w.unref()
    w.on('message', (m: { id: number; ok: boolean; result?: PrintJobResult; error?: { pageLimit: boolean; message: string } }) => {
      const p = s.busy
      if (!p || m.id !== s.id) return
      settle(s)
      if (m.ok) { stats.done++; p.resolve(toResult(m.result!)) } else {
        stats.failed++
        p.reject(m.error?.pageLimit ? new PageLimitError(m.error.message) : new Error(m.error?.message ?? 'print worker failed'))
      }
      next()
    })
    // a crash (out of memory, a bug in a native module): the job fails, the slot is replaced on the next job
    const dead = (e: Error) => {
      const i = slots.indexOf(s)
      if (i >= 0) slots.splice(i, 1)
      const p = s.busy
      if (p) { settle(s); stats.failed++; p.reject(e) }
      next()
    }
    w.on('error', (e) => dead(e))
    w.on('exit', (code) => dead(new Error(`The print worker stopped (exit code ${code}).`)))
    slots.push(s)
    return s
  }

  function settle(s: Slot) {
    if (s.timer) clearTimeout(s.timer)
    s.timer = undefined
    s.busy = null
    s.w.unref()
  }

  function start(s: Slot, p: Pending) {
    if (s.idle) clearTimeout(s.idle)
    s.idle = undefined
    s.busy = p
    s.id = nextId++
    s.w.ref()
    s.timer = setTimeout(() => {
      // stop the CPU work, not only the wait: terminate the worker; a new one starts for the next job
      const i = slots.indexOf(s)
      if (i >= 0) slots.splice(i, 1)
      settle(s)
      stats.timedOut++
      p.reject(new PrintTimeoutError(`timed out after ${p.timeoutMs} ms`))
      s.w.removeAllListeners('exit')
      s.w.on('error', () => {})
      void s.w.terminate()
      next()
    }, p.timeoutMs)
    // images are copied (not transferred): the caller's Buffers may share Node's pool
    s.w.postMessage({ id: s.id, job: p.job })
  }

  function next() {
    while (queue.length) {
      let s = slots.find((x) => !x.busy)
      if (!s && slots.length < size) s = spawn()
      if (!s) return
      start(s, queue.shift()!)
    }
    // one worker stays (warm: its fonts are loaded; a cold start costs ~250 ms); the others stop after idleMs
    for (const s of slots.slice(1)) if (!s.busy && !s.idle) {
      s.idle = setTimeout(() => {
        s.idle = undefined
        const i = slots.indexOf(s)
        if (s.busy || i <= 0) return
        if (i >= 0) slots.splice(i, 1)
        s.w.removeAllListeners('exit')
        void s.w.terminate()
      }, idleMs)
      s.idle.unref()
    }
  }

  return {
    get size() { return size },
    /** runs a job; rejects with PrintBusyError when the queue is full, PrintTimeoutError after timeoutMs */
    run(job: PrintJob, timeoutMs: number): Promise<PrintJobResult> {
      if (size === 0) {
        inProcess++
        return runPrintJob(job).finally(() => { inProcess-- }).then((r) => { stats.done++; return r }, (e) => { stats.failed++; throw e })
      }
      const busy = slots.filter((s) => s.busy).length
      if (busy >= size && queue.length >= o.queueLimit) {
        stats.refused++
        return Promise.reject(new PrintBusyError('busy'))
      }
      return new Promise<PrintJobResult>((resolve, reject) => {
        queue.push({ job, timeoutMs: Math.max(1, timeoutMs), resolve, reject })
        next()
      })
    },
    stats(): PrintPoolStats {
      return { size, workers: slots.length, busy: slots.filter((s) => s.busy).length + inProcess, queued: queue.length, ...stats }
    },
    /** refuses the queued jobs, waits for running ones (at most waitMs), then stops every worker */
    async close(waitMs = 5000): Promise<void> {
      for (const p of queue.splice(0)) p.reject(new PrintBusyError('The server is stopping.'))
      const until = Date.now() + waitMs
      while (slots.some((s) => s.busy) && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
      await Promise.all(slots.splice(0).map((s) => {
        if (s.idle) clearTimeout(s.idle)
        if (s.timer) clearTimeout(s.timer)
        const p = s.busy
        s.busy = null
        if (p) p.reject(new PrintBusyError('The server is stopping.'))
        s.w.removeAllListeners('exit')
        s.w.on('error', () => {})
        return s.w.terminate().catch(() => 0)
      }))
    },
  }
}
export type PrintPool = ReturnType<typeof createPrintPool>

const envInt = (name: string, d: number, max: number): number => {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v >= 0 ? Math.min(v, max) : d
}

let shared: PrintPool | null = null
/** the process's pool (created on first use) */
export function printPool(): PrintPool {
  shared ??= createPrintPool({ size: envInt('APPBUILDER_PRINT_WORKERS', Math.min(2, Math.max(1, availableParallelism() - 1)), 8), queueLimit: envInt('APPBUILDER_PRINT_QUEUE', 32, 1000) })
  return shared
}
/** stops the process's pool (server shutdown); a later print starts a new one */
export async function closePrintPool(): Promise<void> {
  const p = shared
  shared = null
  if (p) await p.close()
}
