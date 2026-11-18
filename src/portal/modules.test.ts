import { describe, expect, it } from 'vitest'
import { MODULES, PHASES, moduleByKey, moduleRoute, modulesFor } from './modules'

describe('module registry', () => {
  it('has unique keys, a phase, 2-3 lines and at least one mode per entry', () => {
    const keys = MODULES.map((m) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const m of MODULES) {
      expect(PHASES[m.phase], m.key).toBeTruthy()
      expect(m.details.length, m.key).toBeGreaterThanOrEqual(1)
      expect(m.details.length, m.key).toBeLessThanOrEqual(3)
      expect(m.modes.length, m.key).toBeGreaterThan(0)
      expect(/^[a-z0-9]+$/.test(m.key), m.key).toBe(true)
    }
  })
  it('lists the planned Dev and User mode modules', () => {
    expect(modulesFor('dev').map((m) => m.key)).toEqual(['datamodel', 'flows', 'approvals', 'dashboards', 'agents', 'sites', 'admin', 'templates'])
    expect(modulesFor('user').map((m) => m.key)).toEqual(['approvals', 'dashboards', 'tasks', 'notes', 'chat', 'files', 'documents', 'mail'])
  })
  it('the Admin console is live; its planned parts have no menu entry of their own', () => {
    expect(moduleRoute(moduleByKey('admin')!)).toEqual({ page: 'admin' })
    expect(moduleByKey('environments')).toBeUndefined()
    for (const k of ['backups', 'logs', 'usage']) {
      expect(moduleByKey(k), k).toMatchObject({ status: 'soon', phase: 'P0', inMenu: false })
    }
  })
  it('planned modules route to their placeholder; live ones to their route', () => {
    expect(moduleRoute(moduleByKey('flows')!)).toEqual({ page: 'soon', id: 'flows' })
    expect(moduleRoute({ ...moduleByKey('flows')!, status: 'live', route: { page: 'apps' } })).toEqual({ page: 'apps' })
  })
})
