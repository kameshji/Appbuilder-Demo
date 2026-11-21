/**
 * TEST FIXTURES (not built in, not shipped): later versions of the Visitor log pack, derived from the built-in 1.0.0, for
 * the upgrade tests (packs.integration.test.ts) and the browser check (scripts/exit-check/p3-templates.mjs). They are
 * registered with catalogue.ts registerTestTemplates, never loaded by the product.
 *
 *   2.0.0  Visitors gets a Badge column; Visits no longer has Minutes (kept here, listed "no longer used"); the Reception
 *          desk title changes; the dashboard gets a third tile; the number sequence gets five digits (its next value
 *          stays); a new reference row (Contractor work) and a changed one (Delivery -> Deliveries); the flow's
 *          description changes.
 *   2.1.0  the Reception desk title changes again (so a change kept local in 2.0.0 can be replaced) and the dashboard's
 *          first tile is renamed.
 */
import fs from 'node:fs'
import type { TemplatePackage } from '../../../../src/templates/format.ts'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
type Node = { name: string; props: Record<string, string>; children: Node[] }
const find = (nodes: Node[], name: string): Node | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n
    const hit = find(n.children ?? [], name)
    if (hit) return hit
  }
  return undefined
}

export function visitorLog(): TemplatePackage {
  const raw = JSON.parse(fs.readFileSync(new URL('../builtin/visitor-log.json', import.meta.url), 'utf8')) as TemplatePackage
  delete raw.signature
  return raw
}

/**
 * 2.0.0 that WIDENS the Visit host role (upgrade-widening.integration.test.ts, P3-16): it reads every visit (was its own),
 * may delete its own visitors (was none) and sees the visitors' phone numbers (hidden before). Reception is unchanged.
 */
export function visitorLogWider(): TemplatePackage {
  const p = clone(visitorLog())
  p.version = '2.0.0'
  const host = p.payload.roles!.find((r) => r.key === 'Host')! as unknown as { tables: Record<string, Record<string, unknown>> }
  host.tables.Visits.read = 'all'
  host.tables.Visitors.delete = 'own'
  delete host.tables.Visitors.columns
  return p
}

export function visitorLogNext(version: '2.0.0' | '2.1.0'): TemplatePackage {
  const p = clone(visitorLog())
  p.version = '2.0.0'
  const visitors = p.slots.find((s) => s.id === 'Visitors')!
  visitors.columns.push({ id: 'Badge', label: 'Badge', types: ['text'], required: false, create: { type: 'text' } })
  const visits = p.slots.find((s) => s.id === 'Visits')!
  visits.columns = visits.columns.filter((c) => c.id !== 'Minutes')
  const desk = p.payload.apps!.find((a) => a.key === 'Desk')!
  find(desk.app.screens as unknown as Node[], 'DeskTitle')!.props.Text = '="Visitors today"'
  const dash = p.payload.dashboards![0]
  ;(dash.def.tiles as unknown[]).push({ id: 'approval', title: 'Visits by approval', kind: 'bar', layout: { x: 0, y: 3, w: 12, h: 3 }, query: { table: 'Slot_Visits', groupBy: ['Slot_Visits_Approval'], measures: [{ id: 'Visits', label: 'Visits', fn: 'count' }] }, visual: { category: 'Slot_Visits_Approval', series: [{ key: 'Visits' }] } })
  p.payload.sequences![0].padding = 5
  const ref = p.payload.reference!.VisitPurposes
  ref.push({ _id: 'contractor', Name: 'Contractor work', NeedsApproval: true })
  ref.find((r) => r._id === 'delivery')!.Name = 'Deliveries'
  p.payload.flows![0].description = 'A visit logged with Approval = Pending goes to reception (version 2).'
  if (version === '2.1.0') {
    p.version = '2.1.0'
    find(desk.app.screens as unknown as Node[], 'DeskTitle')!.props.Text = '="Front desk"'
    ;(dash.def.tiles as { title: string }[])[0].title = 'Visits (all time)'
  }
  return p
}
