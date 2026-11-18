/**
 * What a piece of work is part of, carried through async calls (AsyncLocalStorage): the request id, the correlation id
 * that links a request to the outbox rows, event runs and jobs it causes, and, while a table event or job writes data,
 * the event chain (depth and the event/row pairs already on it) used by the recursion guard. The router opens one per
 * request (runWithRequest); the job worker one per job (runWithWork).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface WorkContext {
  requestId?: string
  correlationId?: string
  /** how many table events deep this work is (0: a person's request) */
  depth: number
  /** "<eventId>:<rowId>" pairs already on this chain (same-row loop detection), oldest first, capped */
  chain: string[]
  /** the job this work runs in, if any */
  jobId?: string
}

const store = new AsyncLocalStorage<WorkContext>()
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

export const newWorkId = (): string => randomBytes(8).toString('hex')

export function currentWork(): WorkContext {
  return store.getStore() ?? { depth: 0, chain: [] }
}

export function runWithWork<T>(w: Partial<WorkContext>, fn: () => T): T {
  const cur = store.getStore()
  return store.run({ depth: 0, chain: [], ...cur, ...w }, fn)
}

/** the router: X-Request-Id / X-Correlation-Id when well-formed, else generated */
export function runWithRequest<T>(req: IncomingMessage, fn: () => T): T {
  const h = (n: string): string | undefined => {
    const v = req.headers[n]
    const s = (Array.isArray(v) ? v[0] : v)?.trim()
    return s && ID_RE.test(s) ? s : undefined
  }
  const requestId = h('x-request-id') ?? newWorkId()
  return store.run({ requestId, correlationId: h('x-correlation-id') ?? requestId, depth: 0, chain: [] }, fn)
}
