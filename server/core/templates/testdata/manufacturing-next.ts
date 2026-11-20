/**
 * TEST FIXTURE (not built in, not shipped): version 1.1.0 of the Manufacturing pack, derived from the built-in 1.0.0,
 * for the upgrade check (scripts/exit-check/p3-manufacturing.mjs) and manufacturing.test.ts. Registered with
 * catalogue.ts registerTestTemplates, never loaded by the product.
 *
 *   1.1.0  Machines gets a Criticality column; a new downtime reason (Waiting for crane or forklift) and a changed one
 *          (Other -> Other reason); the Supervisor console's title and the Plant overview's description change; the
 *          Plant overview gets an "Output by shift" tile; the routing flow's description changes; the work order
 *          sequence gets five digits (its next value stays).
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

export function manufacturing(): TemplatePackage {
  const raw = JSON.parse(fs.readFileSync(new URL('../builtin/manufacturing.json', import.meta.url), 'utf8')) as TemplatePackage
  delete raw.signature
  return raw
}

export function manufacturingNext(): TemplatePackage {
  const p = clone(manufacturing())
  p.version = '1.1.0'
  p.slots.find((s) => s.id === 'Machines')!.columns.push({ id: 'Criticality', label: 'Criticality', types: ['choice', 'text'], required: false, create: { type: 'choice', choices: ['A (critical)', 'B', 'C'], default: 'B' } })
  const reasons = p.payload.reference!.DowntimeReasons
  reasons.push({ _id: 'nm-crane', Name: 'Waiting for crane or forklift · क्रेन का इंतज़ार', Category: 'No material', Code: 'NM-CRANE', Planned: false, Active: true })
  reasons.find((r) => r._id === 'other')!.Name = 'Other reason · अन्य कारण'
  const console_ = p.payload.apps!.find((a) => a.key === 'SupervisorConsole')!
  find(console_.app.screens as unknown as Node[], 'HeaderTitle')!.props.Text = '="Supervisor console (1.1)"'
  const overview = p.payload.dashboards!.find((d) => d.key === 'PlantOverview')!
  overview.def.description = 'Production overview with quality and maintenance tiles (version 1.1).'
  ;(overview.def.tiles as unknown[]).push({ id: 'byshift', title: 'Output by shift', kind: 'bar', layout: { x: 0, y: 17, w: 12, h: 3 }, query: { table: 'Slot_ProductionLog', groupBy: ['Slot_ProductionLog_Shift'], measures: [{ id: 'Good', label: 'Good', fn: 'sum', col: 'Slot_ProductionLog_Good' }], dateColumn: { col: 'Slot_ProductionLog_LoggedOn', kind: 'datetime' } }, visual: { category: 'Slot_ProductionLog_Shift', series: [{ key: 'Good' }] } })
  p.payload.flows!.find((f) => f.key === 'RouteRequest')!.description = 'A new request goes to the machine\'s technician (or the Maintenance role); unacknowledged after 30 minutes it escalates to the plant manager (version 1.1).'
  p.payload.sequences!.find((s) => s.key === 'WorkOrder')!.padding = 5
  return p
}
