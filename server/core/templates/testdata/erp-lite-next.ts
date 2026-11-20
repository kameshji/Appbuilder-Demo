/**
 * TEST FIXTURE (not built in, not shipped): version 1.1.0 of the ERP-lite pack, derived from the built-in 1.0.0, for the
 * upgrade check (scripts/exit-check/p3-erp.mjs and erp-lite.integration.test.ts). Registered with catalogue.ts
 * registerTestTemplates, never loaded by the product.
 *
 *   1.1.0  Locations get an Address column; a new movement reason (Sample sent to a customer) and a changed one
 *          (Correction -> Stock correction); the Stores app's title and the Stock dashboard's description change; the
 *          delivery challan sequence gets five digits (its next value stays).
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

export function erpLite(): TemplatePackage {
  const raw = JSON.parse(fs.readFileSync(new URL('../builtin/erp-lite.json', import.meta.url), 'utf8')) as TemplatePackage
  delete raw.signature
  return raw
}

export function erpLiteNext(): TemplatePackage {
  const p = clone(erpLite())
  p.version = '1.1.0'
  p.slots.find((s) => s.id === 'Locations')!.columns.push({ id: 'Address', label: 'Address', types: ['multiline', 'text'], required: false, create: { type: 'multiline' } })
  const reasons = p.payload.reference!.MovementReasons
  reasons.push({ _id: 'sample-out', Name: 'Sample sent to a customer · ग्राहक को नमूना', Kind: 'Issue', Active: true })
  reasons.find((r) => r._id === 'correction')!.Name = 'Stock correction · स्टॉक सुधार'
  const stores = p.payload.apps!.find((a) => a.key === 'Stores')!
  find(stores.app.screens as unknown as Node[], 'HeaderTitle')!.props.Text = '="Stores (1.1)"'
  p.payload.dashboards!.find((d) => d.key === 'Stock')!.def.description = 'Stock value, items below their reorder level, stock by location (version 1.1).'
  p.payload.sequences!.find((s) => s.key === 'Delivery')!.padding = 5
  return p
}
