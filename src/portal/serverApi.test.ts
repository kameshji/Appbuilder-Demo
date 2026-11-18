import { describe, expect, it } from 'vitest'
import { auditSearch, normalizeSecurityPreview } from './serverApi'

describe('normalizeSecurityPreview', () => {
  it('maps the compact items list', () => {
    const r = normalizeSecurityPreview({ items: [{ tableId: 't1', visibleRows: 4, hiddenColumns: ['A'], readOnlyColumns: ['B'] }] })
    expect(r).toEqual([{ tableId: 't1', visibleRows: 4, hiddenColumns: ['A'], readOnlyColumns: ['B'] }])
  })
  it('maps the richer tables list ({ table, rowCount })', () => {
    const r = normalizeSecurityPreview({ tables: [{ table: 't2', rowCount: 7, hiddenColumns: [], readOnlyColumns: ['C'] }, { table: 't3', rowCount: null }] })
    expect(r[0]).toEqual({ tableId: 't2', visibleRows: 7, hiddenColumns: [], readOnlyColumns: ['C'] })
    expect(r[1]).toEqual({ tableId: 't3', visibleRows: 0, hiddenColumns: [], readOnlyColumns: [] })
  })
  it('prefers items when the server sends both, and never yields empty ids for the real response', () => {
    const r = normalizeSecurityPreview({
      items: [{ tableId: 'x', visibleRows: 2, hiddenColumns: [], readOnlyColumns: [] }],
      tables: [{ table: 'x', rowCount: 2, hiddenColumns: [], readOnlyColumns: [] }],
    })
    expect(r).toHaveLength(1)
    expect(r[0].tableId).toBe('x')
    expect(r[0].visibleRows).toBe(2)
  })
  it('returns [] for unknown bodies', () => {
    expect(normalizeSecurityPreview({})).toEqual([])
    expect(normalizeSecurityPreview(null)).toEqual([])
  })
})

describe('auditSearch', () => {
  it('leaves out empty values and page 1; the "to" date includes that whole day', () => {
    expect(auditSearch({})).toBe('')
    expect(auditSearch({ page: 1, pageSize: 50 })).toBe('?pageSize=50')
    expect(auditSearch({ action: 'auth.', user: 'u_1', from: '2026-11-01', to: '2026-11-18', page: 3 })).toBe('?action=auth.&user=u_1&from=2026-11-01&to=2026-11-19&page=3')
    expect(auditSearch({ to: 'garbage' })).toBe('')
  })
})
