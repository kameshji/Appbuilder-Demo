import { describe, expect, it } from 'vitest'
import type { TableDef } from '@/platform'
import { fx } from '@/fx'
import { walk } from '@/runtime/util'
import { createAppStore } from '@/runtime/store'
import { generateApp } from '@/autoapp'
import { startWithDataOptions } from './actions'

const table = {
  id: 't1', name: 'Inspections', displayName: 'Inspections', primaryColumn: 'Title',
  columns: [{ name: 'id', displayName: 'Id', type: 'text', system: true }, { name: 'Title', displayName: 'Title', type: 'text' }, { name: 'Site', displayName: 'Site', type: 'text' }],
} as unknown as TableDef

const build = (w: number, h: number) => generateApp([table], startWithDataOptions(table, { w, h })).def

describe('Start with data (the auto app generator at the chosen size)', () => {
  it('desktop: a list screen and a detail screen with the form', () => {
    const def = build(1920, 1080)
    expect(def.name).toBe('Inspections app')
    expect(def.screens.map((s) => s.name)).toEqual(['InspectionsList', 'InspectionsDetail'])
    expect(def.screens[0].children.map((c) => c.type)).toContain('DataTable')
    expect(def.screens[1].children.map((c) => c.type)).toContain('Form')
    expect(def.dataSources).toEqual(['Inspections'])
  })

  it('tablet portrait and phone: the one-column layout, nothing wider than the design', () => {
    for (const [w, h] of [[800, 1280], [360, 800]]) {
      const def = build(w, h)
      expect(def.width).toBe(w)
      expect(def.screens.map((s) => s.name)).toEqual(['InspectionsList', 'InspectionsDetail', 'InspectionsRelated'])
      walk(def.screens, (n) => {
        if (n.type === 'Dialog' || !n.props.X) return
        expect(Number(n.props.X.slice(1)) + Number(n.props.Width.slice(1)), n.name).toBeLessThanOrEqual(w)
        for (const f of Object.values(n.props)) expect(fx.check(f), `${n.name}: ${f}`).toEqual([])
      })
    }
  })

  it('phone: New opens the form screen, Back returns to the list', () => {
    const def = build(360, 800)
    const store = createAppStore({ run: true })
    store.getState().loadApp('p', def, { runOnStart: false })
    const st = () => store.getState()
    const find = (name: string) => def.screens.flatMap((s) => s.children).find((c) => c.name === name)!
    st().fire(find('InspectionsNewButton').id, 'OnSelect')
    expect(st().runtime.currentScreenId).toBe(def.screens[1].id)
    st().fire(find('InspectionsBackButton').id, 'OnSelect')
    expect(st().runtime.currentScreenId).toBe(def.screens[0].id)
  })
})
