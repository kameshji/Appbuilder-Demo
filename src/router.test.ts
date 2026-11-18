import { describe, expect, it } from 'vitest'
import { parseRoute, routeToHash, type Route } from './router'

describe('router', () => {
  it('parses the shell routes and round-trips them', () => {
    const cases: Array<[string, Route]> = [
      ['#u', { page: 'u' }],
      ['#u-app_3eb51ec9', { page: 'u', id: 'app_3eb51ec9' }],
      ['#soon-flows', { page: 'soon', id: 'flows' }],
      ['#chat', { page: 'chat' }],
      ['#run-app_1', { page: 'run', id: 'app_1' }],
      ['#studio-app_1', { page: 'studio', id: 'app_1' }],
      ['#apps', { page: 'apps' }],
      ['#datafiles', { page: 'datafiles' }],
      ['#settings', { page: 'settings' }],
      ['#settings-appearance', { page: 'settings', id: 'appearance' }],
      ['#admin', { page: 'admin' }],
      ['#admin-audit', { page: 'admin', id: 'audit' }],
    ]
    for (const [hash, route] of cases) {
      expect(parseRoute(hash)).toEqual(route)
      expect(routeToHash(route)).toBe(hash)
    }
    expect(parseRoute('')).toEqual({ page: 'home' })
    expect(parseRoute('#u-')).toEqual({ page: 'home' })
    expect(parseRoute('#nope')).toEqual({ page: 'home' })
  })
})
