import { describe, expect, it } from 'vitest'
import type { TableDef } from '@/platform'
import { fx } from '@/fx'
import { walk } from '@/runtime/util'
import { blankApp } from '@/runtime/sample'
import { createAppStore } from '@/runtime/store'
import { addDataScreenContent } from './actions'

const table = {
  id: 't1', name: 'Inspections', displayName: 'Inspections', primaryColumn: 'Title',
  columns: [{ name: 'Title', displayName: 'Title', type: 'text' }, { name: 'Site', displayName: 'Site', type: 'text' }],
} as unknown as TableDef

describe('Start with data layouts', () => {
  it('desktop: table and form side by side on one screen', () => {
    const def = addDataScreenContent(blankApp('D', 1920, 1080), table)
    expect(def.screens).toHaveLength(1)
    expect(def.screens[0].children.map((c) => c.type)).toEqual(['DataTable', 'Form'])
    expect(def.dataSources).toEqual(['Inspections'])
  })

  it('tablet portrait: list above form', () => {
    const def = addDataScreenContent(blankApp('T', 800, 1280), table)
    const [list, form] = def.screens[0].children
    expect(Number(list.props.Y.slice(1)) + Number(list.props.Height.slice(1))).toBeLessThan(Number(form.props.Y.slice(1)))
    expect(Number(form.props.Width.slice(1))).toBeLessThanOrEqual(800)
  })

  it('phone: list screen and form screen, single column, formulas valid, navigation works', () => {
    const def = addDataScreenContent(blankApp('P', 360, 800), table)
    expect(def.screens.map((s) => s.name)).toEqual(['InspectionsList', 'InspectionsEdit'])
    const types = (i: number) => def.screens[i].children.map((c) => c.type)
    expect(types(0)).toContain('Gallery')
    expect(types(1)).toContain('Form')
    walk(def.screens, (n) => {
      const w = n.props.Width ? Number(n.props.Width.slice(1)) : 0
      const x = n.props.X ? Number(n.props.X.slice(1)) : 0
      expect(x + w).toBeLessThanOrEqual(360)
      for (const f of Object.values(n.props)) expect(fx.check(f), `${n.name}: ${f}`).toEqual([])
    })
    const names = new Set<string>()
    walk(def.screens, (n) => {
      expect(names.has(n.name), n.name).toBe(false)
      names.add(n.name)
    })
    const store = createAppStore({ run: true })
    store.getState().loadApp('p', def, { runOnStart: false })
    const st = () => store.getState()
    const newButton = def.screens[0].children.find((c) => c.name.startsWith('NewButton'))!
    st().fire(newButton.id, 'OnSelect')
    expect(st().runtime.currentScreenId).toBe(def.screens[1].id)
    const back = def.screens[1].children.find((c) => c.name.startsWith('BackButton'))!
    st().fire(back.id, 'OnSelect')
    expect(st().runtime.currentScreenId).toBe(def.screens[0].id)
  })
})
