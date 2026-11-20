/**
 * TEST FIXTURE (not built in, not shipped): version 1.1.0 of the CRM pack, derived from the built-in 1.0.0, for the
 * upgrade check (scripts/exit-check/p3-crm.mjs) and crm.test.ts. Registered with catalogue.ts registerTestTemplates,
 * never loaded by the product.
 *
 *   1.1.0  Leads gets a Campaign column; a new lead source (Exhibition) and a changed loss reason (Bad timing ->
 *          Timing was wrong); the Sales app's title and the Sales pipeline dashboard's description change; the
 *          dashboard gets a "Deals by source" tile; the new-lead flow's description changes; the quote sequence gets
 *          five digits (its next value stays).
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

export function crm(): TemplatePackage {
  const raw = JSON.parse(fs.readFileSync(new URL('../builtin/crm.json', import.meta.url), 'utf8')) as TemplatePackage
  delete raw.signature
  return raw
}

export function crmNext(): TemplatePackage {
  const p = clone(crm())
  p.version = '1.1.0'
  p.slots.find((s) => s.id === 'Leads')!.columns.push({ id: 'Campaign', label: 'Campaign', types: ['text'], required: false, create: { type: 'text' } })
  p.payload.reference!.LeadSources.push({ _id: 'expo', Name: 'Exhibition', Active: true })
  p.payload.reference!.LossReasons.find((r) => r._id === 'timing')!.Name = 'Timing was wrong'
  const sales = p.payload.apps!.find((a) => a.key === 'Sales')!
  find(sales.app.screens as unknown as Node[], 'HeaderTitle')!.props.Text = '="Sales (1.1)"'
  const board = p.payload.dashboards!.find((d) => d.key === 'SalesPipeline')!
  board.def.description = 'Sales pipeline with deals by source (version 1.1).'
  ;(board.def.tiles as unknown[]).push({ id: 'bysource', title: 'Deals by source', kind: 'bar', layout: { x: 0, y: 11, w: 12, h: 3 }, query: { table: 'Slot_Opportunities', groupBy: ['Slot_Opportunities_Source'], measures: [{ id: 'Deals', label: 'Deals', fn: 'count' }] }, visual: { category: 'Slot_Opportunities_Source', series: [{ key: 'Deals' }] } })
  p.payload.flows!.find((f) => f.key === 'NewLead')!.description = 'A new lead notifies its owner and the sales managers (version 1.1).'
  p.payload.sequences!.find((s) => s.key === 'Quote')!.padding = 5
  return p
}
