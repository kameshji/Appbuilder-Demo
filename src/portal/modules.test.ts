import { describe, expect, it } from 'vitest'
import { MODULES, PHASES, modeOfRoute, moduleByKey, moduleRoute, modulesFor } from './modules'

describe('modeOfRoute', () => {
  it('keeps the current mode on pages both menus list; other User pages and app tabs are User mode; Dev pages Dev mode', () => {
    // Approvals and Dashboards are in the Dev menu and the User menu: clicking them never changes the mode
    for (const id of ['approvals', 'dashboards']) {
      expect(modeOfRoute({ page: 'u', id }, 'dev'), id).toBe('dev')
      expect(modeOfRoute({ page: 'u', id }, 'user'), id).toBe('user')
    }
    // every live menu entry keeps the mode of the menu it was clicked in
    for (const mode of ['dev', 'user'] as const) for (const m of modulesFor(mode)) expect(modeOfRoute(moduleRoute(m), mode), `${m.key} in ${mode}`).toBe(mode)
    // User-only pages, the launcher and app tabs
    for (const id of ['tasks', 'mentions', 'reports', 'app_123']) expect(modeOfRoute({ page: 'u', id }, 'dev'), id).toBe('user')
    expect(modeOfRoute({ page: 'u' }, 'dev')).toBe('user')
    expect(modeOfRoute({ page: 'home' }, 'user')).toBe('dev')
    expect(modeOfRoute({ page: 'settings' }, 'user')).toBe('user')
    expect(modeOfRoute({ page: 'settings' }, 'dev')).toBe('dev')
  })
})

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
    expect(modulesFor('dev').map((m) => m.key)).toEqual(['datamodel', 'flows', 'approvals', 'dashboards', 'printtemplates', 'reports', 'agents', 'sites', 'admin', 'templates'])
    expect(modulesFor('user').map((m) => m.key)).toEqual(['approvals', 'dashboards', 'tasks', 'mentions', 'myreports', 'notes', 'chat', 'files', 'documents', 'mail'])
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
    // Flows is real (P1 package A)
    expect(moduleRoute(moduleByKey('flows')!)).toEqual({ page: 'flows' })
    // Dashboards is real (P2 package C): a built-in page in both modes
    expect(moduleRoute(moduleByKey('dashboards')!)).toEqual({ page: 'u', id: 'dashboards' })
    expect(moduleRoute(moduleByKey('agents')!)).toEqual({ page: 'soon', id: 'agents' })
    expect(moduleRoute({ ...moduleByKey('agents')!, status: 'live', route: { page: 'apps' } })).toEqual({ page: 'apps' })
  })
})
