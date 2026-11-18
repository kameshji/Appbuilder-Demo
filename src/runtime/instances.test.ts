import { describe, expect, it } from 'vitest'
import type { AppDef, ControlNode } from '@/contracts'
import { ROOT_CTX } from './evaluator'
import { appStore, createAppStore, evaluatorOf, type AppStore } from './store'
import { blankApp } from './sample'

/** an app with a counter button, a label showing the counter and a UDF whose factor differs per app */
function counterApp(factor: number): AppDef {
  const a = blankApp('Counter', 360, 800)
  const button: ControlNode = { id: 'b1', name: 'AddButton', type: 'Button', props: { OnSelect: '=Set(Count, Count + 1); Collect(Clicks, {n: Count})' }, children: [] }
  const label: ControlNode = { id: 'l1', name: 'CountLabel', type: 'Label', props: { Text: '="Count " & Count & " / " & Scaled(Count)' }, children: [] }
  a.screens[0].id = 's1'
  a.screens[0].children = [button, label]
  a.screens.push({ id: 's2', name: 'Details', type: 'Screen', props: {}, children: [] })
  a.appProps.OnStart = '=Set(Count, 0)'
  a.appProps.Formulas = `Scaled(x: Number): Number = x * ${factor};`
  return a
}

function start(store: AppStore, id: string, def: AppDef) {
  store.getState().loadApp(id, def, { runOnStart: false })
  store.getState().restartRuntime()
}
const labelText = (store: AppStore) => {
  const st = store.getState()
  const ev = evaluatorOf(st)
  return ev.evalNode(ev.byName.get('CountLabel')!.node, ROOT_CTX).props.Text
}

describe('app stores are independent (app tabs)', () => {
  it('two open apps keep separate variables, collections, navigation and evaluator caches', () => {
    const a = createAppStore({ run: true })
    const b = createAppStore({ run: true })
    start(a, 'app_a', counterApp(10))
    start(b, 'app_b', counterApp(100))

    a.getState().fire('b1', 'OnSelect')
    a.getState().fire('b1', 'OnSelect')
    a.getState().fire('b1', 'OnSelect')
    b.getState().fire('b1', 'OnSelect')

    expect(a.getState().runtime.vars.Count).toBe(3)
    expect(b.getState().runtime.vars.Count).toBe(1)
    expect(a.getState().runtime.collections.Clicks).toHaveLength(3)
    expect(b.getState().runtime.collections.Clicks).toHaveLength(1)

    // each store evaluates against its own state and its own App.Formulas (user-defined functions)
    expect(labelText(a)).toBe('Count 3 / 30')
    expect(labelText(b)).toBe('Count 1 / 100')
    expect(labelText(a)).toBe('Count 3 / 30')
    expect(evaluatorOf(a.getState())).not.toBe(evaluatorOf(b.getState()))

    a.getState().navigateTo('s2')
    expect(a.getState().runtime.currentScreenId).toBe('s2')
    expect(b.getState().runtime.currentScreenId).toBe('s1')

    // restarting one app leaves the other alone
    b.getState().restartRuntime()
    expect(b.getState().runtime.vars.Count).toBe(0)
    expect(a.getState().runtime.vars.Count).toBe(3)
  })

  it('run stores fire events without preview mode; the shared store is untouched', () => {
    const before = appStore.getState().runtime
    const a = createAppStore({ run: true })
    start(a, 'app_a', counterApp(2))
    expect(a.getState().mode).toBe('design')
    a.getState().fire('b1', 'OnSelect')
    expect(a.getState().runtime.vars.Count).toBe(1)
    expect(appStore.getState().runtime).toBe(before)
    expect(appStore.getState().runSurface).toBe(false)

    // a design store (the Studio) does not fire events outside preview
    const d = createAppStore()
    start(d, 'app_d', counterApp(2))
    d.getState().fire('b1', 'OnSelect')
    expect(d.getState().runtime.vars.Count).toBe(0)
  })

  it('log listeners are per store', () => {
    const a = createAppStore({ run: true })
    const b = createAppStore({ run: true })
    const seenA: string[] = []
    const seenB: string[] = []
    a.getState().subscribeLog((e) => seenA.push(...e.map((x) => x.message)))
    b.getState().subscribeLog((e) => seenB.push(...e.map((x) => x.message)))
    const def = counterApp(1)
    def.screens[0].children[0].props.OnSelect = '=Trace("clicked")'
    start(a, 'a', def)
    start(b, 'b', counterApp(1))
    a.getState().fire('b1', 'OnSelect')
    expect(seenA).toEqual(['clicked'])
    expect(seenB).toEqual([])
  })

  it('portrait designs keep their size (no landscape swap on load)', () => {
    const a = createAppStore({ run: true })
    start(a, 'p', counterApp(1))
    expect(a.getState().app.width).toBe(360)
    expect(a.getState().app.height).toBe(800)
  })
})
