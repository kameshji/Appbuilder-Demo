/**
 * The sample workspace: Contacts and Orders tables with rows, and the Contacts app.
 * src/runtime/sample.ts cannot be imported by Node (extensionless './util' import), so the app definition is a
 * JSON snapshot (sample-app.json) generated from sampleApp(); a test checks it still matches the source.
 */
import fs from 'node:fs'
import type { AppDef } from '../../../src/contracts.ts'
import type { AppMeta, ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { QueryValue } from '../../../src/platform/http.ts'
import type { Services } from '../../core/contracts.ts'
import { systemColumns } from './util.ts'
import { createPhysical, pickSource, resolveConnection } from './tables-core.ts'
import { addApp } from './packages.ts'

export const CONTACT_STATUSES = ['Lead', 'Customer', 'Partner', 'Churned']
export const ORDER_STATUSES = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled']

export const SEED_CONTACTS: Array<{ Name: string; Company: string; City: string; Email: string; Active: boolean; Status: string }> = [
  { Name: 'Asha Rao', Company: 'Northwind', City: 'Pune', Email: 'asha.rao@northwind.example', Active: true, Status: 'Customer' },
  { Name: 'Ben Carter', Company: 'Contoso Labs', City: 'Austin', Email: 'ben.carter@contoso-labs.example', Active: true, Status: 'Lead' },
  { Name: 'Chitra Menon', Company: 'Fabrikam', City: 'Kochi', Email: 'chitra.menon@fabrikam.example', Active: false, Status: 'Churned' },
  { Name: 'Dmitri Volkov', Company: 'Tailspin', City: 'Riga', Email: 'dmitri.volkov@tailspin.example', Active: true, Status: 'Partner' },
  { Name: 'Elena Rossi', Company: 'Wingtip', City: 'Milan', Email: 'elena.rossi@wingtip.example', Active: true, Status: 'Customer' },
  { Name: 'Farid Khan', Company: 'Adventure Works', City: 'Dubai', Email: 'farid.khan@adventure-works.example', Active: false, Status: 'Lead' },
  { Name: 'Grace Liu', Company: 'Litware', City: 'Singapore', Email: 'grace.liu@litware.example', Active: true, Status: 'Customer' },
  { Name: 'Hiro Tanaka', Company: 'Proseware', City: 'Osaka', Email: 'hiro.tanaka@proseware.example', Active: true, Status: 'Partner' },
]

/** customer = index into SEED_CONTACTS */
export const SEED_ORDERS: Array<{ customer: number; amount: number; date: string; status: string }> = [
  { customer: 0, amount: 1250, date: '2026-01-05', status: 'Delivered' },
  { customer: 1, amount: 480.5, date: '2026-01-12', status: 'Delivered' },
  { customer: 4, amount: 2310, date: '2026-01-19', status: 'Shipped' },
  { customer: 6, amount: 89.99, date: '2026-01-27', status: 'Delivered' },
  { customer: 0, amount: 640, date: '2026-02-03', status: 'Processing' },
  { customer: 3, amount: 5200, date: '2026-02-10', status: 'Shipped' },
  { customer: 7, amount: 310.75, date: '2026-02-14', status: 'Delivered' },
  { customer: 4, amount: 1180, date: '2026-02-21', status: 'New' },
  { customer: 2, amount: 75, date: '2026-02-25', status: 'Cancelled' },
  { customer: 6, amount: 960, date: '2026-03-02', status: 'Processing' },
  { customer: 1, amount: 2750.25, date: '2026-03-09', status: 'New' },
  { customer: 5, amount: 420, date: '2026-03-16', status: 'New' },
]

export function sampleAppDef(): AppDef {
  const text = fs.readFileSync(new URL('./sample-app.json', import.meta.url), 'utf8')
  return JSON.parse(text) as AppDef
}

const contactsCols = (): ColumnDef[] => [
  { name: 'Name', displayName: 'Name', type: 'text', required: true },
  { name: 'Company', displayName: 'Company', type: 'text' },
  { name: 'City', displayName: 'City', type: 'text' },
  { name: 'Email', displayName: 'Email', type: 'email' },
  { name: 'Active', displayName: 'Active', type: 'boolean', default: 'true' },
  { name: 'Status', displayName: 'Status', type: 'choice', choices: [...CONTACT_STATUSES], default: 'Lead' },
]
const ordersCols = (): ColumnDef[] => [
  { name: 'OrderNo', displayName: 'Order no', type: 'autonumber', prefix: 'ORD-' },
  { name: 'Customer', displayName: 'Customer', type: 'lookup', lookupTable: 'Contacts', required: true },
  { name: 'Amount', displayName: 'Amount', type: 'currency', default: '0' },
  { name: 'OrderDate', displayName: 'Order date', type: 'date', default: 'today' },
  { name: 'Status', displayName: 'Status', type: 'choice', choices: [...ORDER_STATUSES], default: 'New' },
]

/** creates the Contacts and Orders tables (with sample rows) on the default connection when they are missing */
export async function ensureSampleTables(s: Services): Promise<TableDef[]> {
  const created: TableDef[] = []
  const have = (n: string) => s.meta.tables.get(n)
  const { record, connector } = await resolveConnection(s)
  const make = async (name: string, description: string, primary: string, cols: ColumnDef[]): Promise<TableDef> => {
    const now = s.now()
    const def: TableDef = {
      id: s.uid('tbl'), name, displayName: name, description, primaryColumn: primary,
      columns: [...systemColumns(), ...cols], createdOn: now, modifiedOn: now, connectionId: record.id,
    }
    def.source = await pickSource(s, record, connector, name)
    await createPhysical(s, record, connector, def)
    created.push(def)
    return def
  }
  let contactIds: string[] = []
  if (!(await have('Contacts'))) {
    const cd = await make('Contacts', 'People and companies you work with.', 'Name', contactsCols())
    for (const c of SEED_CONTACTS) {
      const row = await s.data.insert(null, cd, c as unknown as Record<string, QueryValue>)
      contactIds.push(String(row.id))
    }
  }
  if (!(await have('Orders'))) {
    const od = await make('Orders', 'Customer orders.', 'OrderNo', ordersCols())
    if (!contactIds.length) {
      const cd = await have('Contacts')
      if (cd) {
        const r = await s.data.query(null, cd, { orderBy: [{ col: 'createdOn', dir: 'asc' }], top: SEED_CONTACTS.length })
        contactIds = r.rows.map((x) => String(x.id))
      }
    }
    if (contactIds.length >= SEED_CONTACTS.length) {
      for (const o of SEED_ORDERS) {
        await s.data.insert(null, od, { Customer: contactIds[o.customer], Amount: o.amount, OrderDate: o.date, Status: o.status })
      }
    }
  }
  return created
}

export async function createSampleApp(s: Services, actor: string, name = 'Contacts app'): Promise<AppMeta> {
  await ensureSampleTables(s)
  return addApp(s, actor, sampleAppDef(), name, 'A contacts list with search, details and an add form.')
}

/** seed sample tables, rows and the Contacts app into the default store (when there is nothing to migrate) */
export async function seedSample(services: Services, adminUserId: string): Promise<void> {
  const admin = await services.meta.users.get(adminUserId)
  await createSampleApp(services, admin?.name ?? 'Admin')
}
