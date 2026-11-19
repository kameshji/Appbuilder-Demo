/**
 * RunFlow and RequestApproval from apps wait for the app's pending writes (Patch is optimistic) before calling the
 * server, so a record just written by the same formula exists when the flow or the approval reads it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
let release: () => void = () => {}

vi.mock('@/platform', async (orig) => {
  const real = await orig<typeof import('@/platform')>()
  const platform = {
    getState: () => ({ ready: true, mode: 'server', tables: [], roles: [], dataVersion: 1, loading: [], truncated: [], currentUserId: 'u' }),
    subscribe: () => () => {},
    tables: {
      flush: () => new Promise<void>((resolve) => { order.push('flush:start'); release = () => { order.push('flush:done'); resolve() } }),
    },
  }
  return { ...real, platform }
})
vi.mock('@/approvals/api', () => ({ approvalsApi: { create: async () => { order.push('approvals.create') } } }))

import { requestApprovalCall, runFlowCall } from './data'

afterEach(() => { order.length = 0; vi.unstubAllGlobals() })

describe('pending writes before server calls from apps', () => {
  it('RunFlow posts only after the pending writes are stored', async () => {
    vi.stubGlobal('fetch', async (url: string) => { order.push(`fetch:${String(url).replace(/^.*\/api\/v1/, '')}`); return new Response(JSON.stringify({ runId: 'r1' }), { status: 200 }) })
    const p = runFlowCall({ flow: 'F', inputs: {}, runId: 'r1', wait: false, timeoutSeconds: 10 })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['flush:start']) // nothing sent while a write is pending
    release()
    await p
    expect(order).toEqual(['flush:start', 'flush:done', 'fetch:/flows/run'])
  })
  it('RequestApproval does the same', async () => {
    const p = requestApprovalCall({ id: 'a1', approvers: ['x@example.com'], record: 'row1', title: 't', details: '', fields: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['flush:start'])
    release()
    await p
    expect(order).toEqual(['flush:start', 'flush:done', 'approvals.create'])
  })
})
