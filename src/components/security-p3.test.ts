/**
 * Security re-check of Phase 3 (docs/internal/security-review-p3.md), client part: the error boundaries' test hook
 * `window.__abForceCrash` is inert in a production build unless the test hooks are switched on for the browser (P3-5).
 */
import { describe, expect, it } from 'vitest'
import { testHooksEnabled } from './testHooks'

const store = (v: string | null) => ({ getItem: (k: string) => (k === 'ab:test-hooks' ? v : null) })

describe('FINDING P3-5: test hooks in a production build', () => {
  it('are off unless ab:test-hooks is "1"; always on in a development build; a storage that throws counts as off', () => {
    expect(testHooksEnabled(false, store(null))).toBe(false)
    expect(testHooksEnabled(false, store('true'))).toBe(false)
    expect(testHooksEnabled(false, store('1'))).toBe(true)
    expect(testHooksEnabled(false, null)).toBe(false)
    expect(testHooksEnabled(false, { getItem: () => { throw new Error('denied') } })).toBe(false)
    expect(testHooksEnabled(true, store(null))).toBe(true)
  })
})
