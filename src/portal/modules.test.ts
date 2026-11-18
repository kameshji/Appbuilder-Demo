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
    expect(modulesFor('user').map((m) => m.key)).toEqual(['approvals', 'dashboards', 'tasks', 'mentions', 'notes', 'chat', 'files', 'documents', 'mail'])
  })
  it('Tasks and Mentions are live built-in User mode pages (core data model)', () => {
    expect(moduleRoute(moduleByKey('tasks')!)).toEqual({ page: 'u', id: 'tasks' })
    expect(moduleRoute(moduleByKey('mentions')!)).toEqual({ page: 'u', id: 'mentions' })
  })
  it('the Admin console is live; its planned parts have no menu entry of their own', () => {
    expect(moduleRoute(moduleByKey('admin')!)).toEqual({ page: 'admin' })
    expect(moduleByKey('environments')).toBeUndefined()
    // Server logs and Usage are real (package L): pages of the Admin console without a menu entry of their own
    for (const k of ['logs', 'usage']) {
      expect(moduleByKey(k), k).toMatchObject({ status: 'live', phase: 'P0', inMenu: false })
      expect(moduleRoute(moduleByKey(k)!)).toEqual({ page: 'admin', id: k })
    }
    // Backups is real (package J): a page of the Admin console, still without a menu entry of its own
    expect(moduleByKey('backups')).toMatchObject({ status: 'live', phase: 'P0', inMenu: false })
    expect(moduleRoute(moduleByKey('backups')!)).toEqual({ page: 'admin', id: 'backups' })
  })
  it('planned modules route to their placeholder; live ones to their route', () => {
    expect(moduleRoute(moduleByKey('flows')!)).toEqual({ page: 'soon', id: 'flows' })
    expect(moduleRoute({ ...moduleByKey('flows')!, status: 'live', route: { page: 'apps' } })).toEqual({ page: 'apps' })
  })
})
