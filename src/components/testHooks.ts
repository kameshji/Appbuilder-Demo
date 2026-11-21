/**
 * P3 security review (P3-5, docs/internal/security-review-p3.md): test hooks that change behaviour (the error boundaries'
 * `window.__abForceCrash`) work only in a development build or when they were switched on for this browser
 * (localStorage `ab:test-hooks` = "1", which the exit checks set before the page loads); otherwise they do nothing.
 */
export function testHooksEnabled(dev: boolean = import.meta.env.DEV, storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  if (dev) return true
  try {
    return storage?.getItem('ab:test-hooks') === '1'
  } catch {
    return false
  }
}
