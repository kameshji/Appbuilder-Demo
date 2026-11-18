import { describe, expect, it } from 'vitest'
import { normalizeSecurityPreview } from './serverApi'

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
