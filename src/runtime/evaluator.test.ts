import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import type { AppDef } from '@/contracts'
import { Evaluator, ROOT_CTX, type RuntimeView } from './evaluator'
import { placeStyle, surfaceSize } from './layout'
import { runFormula } from './host'
import { migrateApp } from './store'
import { sampleApp, blankApp } from './sample'

const rt = (over: Partial<RuntimeView> = {}): RuntimeView => ({
  vars: {}, context: {}, collections: {}, outputs: {}, resetKeys: {}, focusKeys: {}, formModes: {}, dataKey: '0', userId: '', ...over,
})

function app(): AppDef {
  const a = blankApp('T', 1920, 1080)
  a.screens[0].children = [
    { id: 'in1', name: 'Input1', type: 'TextInput', props: {}, children: [] },
    { id: 'l1', name: 'Label1', type: 'Label', props: { Text: '="Hi " & Input1.Value' }, children: [] },
    { id: 'l2', name: 'Label2', type: 'Label', props: { Text: '="Static"' }, children: [] },
    { id: 'l3', name: 'Label3', type: 'Label', props: { Text: '=App.Width & "x" & Parent.Height' }, children: [] },
  ]
  return a
}

describe('evaluator dependency tracking', () => {
  it('re-evaluates only what depends on a changed output', () => {
    const a = app()
    const r0 = rt()
    const ev = new Evaluator(a, r0, { w: 1920, h: 1080 })
    const n = (id: string) => ev.byId.get(id)!.node
    expect(ev.evalProp(n('l1'), 'Text', ROOT_CTX).value).toBe('Hi ')
    ev.evalProp(n('l2'), 'Text', ROOT_CTX)
    const v1 = ev.versionOf('l1')
    const v2 = ev.versionOf('l2')
    ev.update(rt({ outputs: { in1: { Value: 'Sam' } } }), { w: 1920, h: 1080 })
    expect(ev.versionOf('l1')).toBeGreaterThan(v1)
    expect(ev.versionOf('l2')).toBe(v2)
    expect(ev.evalProp(n('l1'), 'Text', ROOT_CTX).value).toBe('Hi Sam')
  })

  it('withApp invalidates edited props and keeps the evaluator', () => {
    const a = app()
    const ev = new Evaluator(a, rt(), { w: 1920, h: 1080 })
    expect(ev.evalProp(ev.byId.get('l2')!.node, 'Text', ROOT_CTX).value).toBe('Static')
    const b = produce(a, (d) => {
      d.screens[0].children[2].props.Text = '="Changed"'
    })
    expect(ev.withApp(b)).toBe(true)
    expect(ev.evalProp(ev.byId.get('l2')!.node, 'Text', ROOT_CTX).value).toBe('Changed')
    const c = produce(b, (d) => {
      d.screens[0].children[2].name = 'Renamed'
    })
    expect(ev.withApp(c)).toBe(false)
  })

  it('App.Width and Parent.Height follow the actual screen size', () => {
    const ev = new Evaluator(app(), rt(), { w: 1920, h: 1080 })
    const l3 = () => ev.evalProp(ev.byId.get('l3')!.node, 'Text', ROOT_CTX).value
    expect(l3()).toBe('1920x1080')
    ev.update(ev.rt, { w: 2560, h: 1440 })
    expect(l3()).toBe('2560x1440')
  })

  it('context variables are per screen', () => {
    const a = app()
    a.screens.push({ id: 's2', name: 'Other', type: 'Screen', props: {}, children: [{ id: 'o1', name: 'OtherLabel', type: 'Label', props: { Text: '=Coalesce(x, "none")' }, children: [] }] })
    a.screens[0].children[1].props.Text = '=Coalesce(x, "none")'
    const r = runFormula({ app: a, rt: { ...rt(), navStack: [a.screens[0].id] }, env: { w: 1920, h: 1080 }, node: a.screens[0].children[1], ctx: ROOT_CTX, formula: '=UpdateContext({x: "here"})', label: 't' })
    const ev = new Evaluator(a, { ...rt(), context: r.context }, { w: 1920, h: 1080 })
    expect(ev.evalProp(ev.byId.get('l1')!.node, 'Text', ROOT_CTX).value).toBe('here')
    expect(ev.evalProp(ev.byId.get('o1')!.node, 'Text', ROOT_CTX).value).not.toBe('here')
  })

  it('named formulas resolve lazily', () => {
    const a = app()
    a.appProps.Formulas = 'Greeting = "Hello " & Input1.Value; Twice(n: Number): Number = n * 2;'
    a.screens[0].children[2].props.Text = '=Greeting & Twice(21)'
    const ev = new Evaluator(a, rt({ outputs: { in1: { Value: 'Kim' } } }), { w: 1920, h: 1080 })
    expect(ev.evalProp(ev.byId.get('l2')!.node, 'Text', ROOT_CTX).value).toBe('Hello Kim42')
  })
})

describe('layout', () => {
  const g = { x: 100, y: 50, w: 200, h: 40 }
  const manual = { kind: 'manual' as const, dw: 1920, dh: 1080, alignItems: 'auto' }
  it('anchors map to CSS', () => {
    expect(placeStyle(manual, g, { anchorH: 'end', anchorV: 'start', grow: 0, alignSelf: 'auto' })).toMatchObject({ right: '1620px', width: '200px', top: '50px' })
    expect(placeStyle(manual, g, { anchorH: 'stretch', anchorV: 'end', grow: 0, alignSelf: 'auto' })).toMatchObject({ left: '100px', right: '1620px', bottom: '990px' })
    expect(placeStyle(manual, g, { anchorH: 'scale', anchorV: 'center', grow: 0, alignSelf: 'auto' }).width).toMatch(/%$/)
  })
  it('flow items use basis and grow', () => {
    const st = placeStyle({ kind: 'row', dw: 0, dh: 0, alignItems: 'stretch' }, g, { anchorH: 'start', anchorV: 'start', grow: 1, alignSelf: 'auto' })
    expect(st.flex).toBe('1 1 200px')
    expect(st.height).toBeUndefined()
  })
  it('responsive surface size', () => {
    const a = blankApp()
    expect(surfaceSize(a, { w: 2560, h: 1080 })).toMatchObject({ w: 2560, h: 1080, scale: 1 })
    expect(surfaceSize(a, { w: 800, h: 500 })).toMatchObject({ w: 1024, h: 576 })
    expect(surfaceSize(a, { w: 1200, h: 1600 })).toMatchObject({ w: 1200, h: 675 })
    expect(surfaceSize({ ...a, scaleMode: 'fit' }, { w: 960, h: 540 })).toMatchObject({ w: 1920, h: 1080, scale: 0.5 })
  })
})

describe('apps', () => {
  it('sample app is a 1920x1080 responsive app over Contacts', () => {
    const s = sampleApp()
    expect(s.width).toBe(1920)
    expect(s.dataSources).toContain('Contacts')
    expect(JSON.stringify(s)).toContain('DataTable')
  })
  it('phase-1 apps migrate to fit', () => {
    const m = migrateApp({ ...blankApp(), formatVersion: 1, width: 960, height: 600, scaleMode: undefined })
    expect(m.formatVersion).toBe(2)
    expect(m.scaleMode).toBe('fit')
  })
})
