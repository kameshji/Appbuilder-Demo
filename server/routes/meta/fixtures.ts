/** a phase-2 workspace written to disk (workspace.yaml, apps/, tables/) for the migration tests */
import fs from 'node:fs'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { sampleAppDef } from './seed.ts'

const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

export const C1 = '11111111-1111-4111-8111-111111111111'
export const C2 = '22222222-2222-4222-8222-222222222222'
export const O1 = '33333333-3333-4333-8333-333333333333'

export function legacy(dir: string) {
  const sys = [
    { name: 'id', displayName: 'Id', type: 'text', system: true }, { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
    { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true }, { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
    { name: 'owner', displayName: 'Owner', type: 'text', system: true },
  ]
  put(dir, 'workspace.yaml', yaml.dump({
    formatVersion: 1, currentUserId: 'user_sam',
    users: [
      { id: 'user_admin', name: 'Admin', email: 'admin@appbuilder.local', roleIds: ['role_admin'] },
      { id: 'user_sam', name: 'Sam Maker', email: 'sam@appbuilder.local', roleIds: ['role_maker'] },
      { id: 'user_vera', name: 'Vera Viewer', email: 'vera@appbuilder.local', roleIds: ['role_viewer', 'role_custom'] },
      { id: 'user_blank', name: 'No Email', email: '', roleIds: [] },
    ],
    roles: [
      { id: 'role_admin', name: 'Administrator', isAdmin: true, privileges: [], apps: 'all' },
      { id: 'role_maker', name: 'Maker', privileges: [{ table: 'tbl_contacts', create: true, read: 'all', update: 'all', delete: 'all' }, { table: 'tbl_orders', create: true, read: 'all', update: 'all', delete: 'all' }], apps: 'all' },
      { id: 'role_viewer', name: 'Viewer', privileges: [{ table: 'tbl_contacts', create: false, read: 'all', update: 'none', delete: 'none' }], apps: 'all' },
      { id: 'role_custom', name: 'Own rows', privileges: [{ table: 'tbl_orders', create: true, read: 'own', update: 'own', delete: 'none' }, { table: 'tbl_gone', create: true, read: 'all', update: 'all', delete: 'all' }], apps: ['app_contacts'] },
    ],
    connections: [{ id: 'conn_local_csv', name: 'Local CSV', connector: 'local-csv', status: 'connected', settings: {} }],
    solutions: [{ id: 'sol_default', name: 'Default', displayName: 'Default', publisher: 'Appbuilder', version: '1.0.0', components: [{ kind: 'app', id: 'app_contacts' }, { kind: 'table', id: 'tbl_contacts' }, { kind: 'role', id: 'role_custom' }, { kind: 'connection', id: 'conn_local_csv' }], createdOn: 'x', modifiedOn: 'x' }],
  }))
  put(dir, 'tables/Contacts.schema.yaml', yaml.dump({ id: 'tbl_contacts', name: 'Contacts', displayName: 'Contacts', primaryColumn: 'Name', columns: [...sys, { name: 'Name', displayName: 'Name', type: 'text', required: true }, { name: 'Active', displayName: 'Active', type: 'boolean' }], createdOn: 'x', modifiedOn: 'x' }))
  put(dir, 'tables/Contacts.csv', `id,createdOn,modifiedOn,createdBy,owner,Name,Active\r\n${C1},2026-01-01T00:00:00.000Z,2026-01-01T00:00:00.000Z,user_admin,user_sam,Asha,true\r\n${C2},2026-01-02T00:00:00.000Z,2026-01-02T00:00:00.000Z,user_blank,user_vera,Ben,false\r\n`)
  put(dir, 'tables/Orders.schema.yaml', yaml.dump({ id: 'tbl_orders', name: 'Orders', displayName: 'Orders', primaryColumn: 'OrderNo', columns: [...sys, { name: 'OrderNo', displayName: 'Order no', type: 'autonumber', prefix: 'ORD-' }, { name: 'Customer', displayName: 'Customer', type: 'lookup', lookupTable: 'Contacts' }, { name: 'Amount', displayName: 'Amount', type: 'currency' }], createdOn: 'x', modifiedOn: 'x' }))
  put(dir, 'tables/Orders.csv', `id,createdOn,modifiedOn,createdBy,owner,OrderNo,Customer,Amount\r\n${O1},2026-02-01T00:00:00.000Z,2026-02-01T00:00:00.000Z,user_sam,user_sam,ORD-0007,${C1},12.5\r\n`)
  const def = sampleAppDef()
  put(dir, 'apps/app_contacts.app.yaml', yaml.dump({ formatVersion: 1, meta: { id: 'app_contacts', name: 'Contacts app', width: 1920, height: 1080, createdOn: 'a', modifiedOn: 'b', modifiedBy: 'Sam Maker' }, definition: def }))
  put(dir, 'apps/broken.app.yaml', 'meta: {name: x}\ndefinition: {nope: 1}\n')
}

