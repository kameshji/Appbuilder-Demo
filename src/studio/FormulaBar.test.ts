import { describe, expect, it } from 'vitest'
import { stripLeadingEquals } from './FormulaBar'
import { fx } from '@/fx'

describe('formula bar leading "="', () => {
  it('drops one leading = (after whitespace)', () => {
    expect(stripLeadingEquals('=Filter(T, true)')).toBe('Filter(T, true)')
    expect(stripLeadingEquals('  = 1 + 2')).toBe(' 1 + 2')
    expect(stripLeadingEquals('==1')).toBe('=1')
  })
  it('leaves other text alone', () => {
    expect(stripLeadingEquals('Filter(T, a = 1)')).toBe('Filter(T, a = 1)')
    expect(stripLeadingEquals('')).toBe('')
  })
  it('both spellings store the same, valid formula', () => {
    expect(fx.check('=' + stripLeadingEquals('=1 + 2'))).toEqual([])
    expect('=' + stripLeadingEquals('=1 + 2')).toBe('=' + stripLeadingEquals('1 + 2'))
  })
})
