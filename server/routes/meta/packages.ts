/**
 * YAML packages (ported from the phase-2 platform core, same document shapes so demo-mode and server-mode
 * packages are interchangeable): app packages and the shared pieces of solution packages.
 * Importing always creates NEW instances: new ids, unique names; tables that already exist by name are reused,
 * rows are only ever loaded into tables created by the import.
 */
import type { RelationshipDef } from '../../../src/model/types.ts'
import { pkgRelationshipsOf, prepareViewDef, readPkgRelationships, restorePkgRelationships } from '../../core/model/packages.ts'
import type { AppDef } from '../../../src/contracts.ts'
import type { AppMeta, TableDef } from '../../../src/platform/contracts.ts'
import type { TableEventInput } from '../../../src/platform/events.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, Connector, ConnectionRecord, Services, UserContext } from '../../core/contracts.ts'
import {
  clone, fromYaml, invalid, isObj, jsonCellToCsv, sanitizeTableDef, toYaml, uniqueLabel, unparseCsv,
} from './util.ts'
import {
  createPhysical, csvToRows, importRowsSystem, pickSource, plainTableDef, queryAll, resolveConnection, unregisterTable,
} from './tables-core.ts'
import type { TableRows } from './tables-core.ts'

export const PACKAGE_VERSION = 1

/* ------------------------------------------------------------------ app helpers */

export function validateDef(def: unknown): AppDef {
  if (!isObj(def) || !Array.isArray(def.screens)) throw invalid('The app definition is malformed (no screens).')
  return def as unknown as AppDef
}

export function checkSize(width: unknown, height: unknown): void {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200 || width > 16000 || height > 16000) {
    throw invalid('Width and height must be numbers between 200 and 16000.')
  }
}

export async function addApp(s: Services, actor: string, def: AppDef, name: string, description?: string): Promise<AppMeta> {
  const apps = await s.meta.apps.list()
  const unique = uniqueLabel(name, apps.map((a) => a.name))
  const now = s.now()
  const meta: AppMeta = { id: s.uid('app'), name: unique, width: def.width, height: def.height, createdOn: now, modifiedOn: now, modifiedBy: actor }
  if (description) meta.description = description
  def.name = unique
  await s.meta.apps.upsert(meta, def)
  return meta
}

export function blankApp(name: string, width: number, height: number, nodeId: () => string): AppDef {
  return {
    formatVersion: 2, name, width, height, scaleMode: 'responsive', theme: { mode: 'light' }, dataSources: [],
    appProps: { OnStart: '=false' },
    screens: [{ id: nodeId(), name: 'Screen1', type: 'Screen', props: { Fill: '=Color.White' }, children: [] }],
  } as AppDef
}

/* ------------------------------------------------------------------ tables used by an app */

function formulasOf(def: AppDef): string[] {
  const out: string[] = Object.values(def.appProps ?? {})
  const walk = (nodes: AppDef['screens']) => {
    for (const n of nodes) {
      for (const f of Object.values(n.props ?? {})) if (typeof f === 'string') out.push(f)
      walk(n.children ?? [])
    }
  }
  walk(def.screens)
  return out.filter((f): f is string => typeof f === 'string')
}

/** tables an app uses: dataSources + names mentioned in formulas (outside strings) + lookup targets */
export function tablesUsedBy(def: AppDef, tables: TableDef[]): TableDef[] {
  const byLower = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const names = new Set<string>()
  for (const src of def.dataSources ?? []) {
    const t = byLower.get(String(src).toLowerCase())
    if (t) names.add(t.name)
  }
  const known = new Set(tables.map((t) => t.name))
  for (const f of formulasOf(def)) {
    const bare = f.replace(/"(?:[^"]|"")*"/g, '""')
    for (const m of bare.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (known.has(m[0])) names.add(m[0])
  }
  const queue = [...names]
  while (queue.length) {
    const t = byLower.get(queue.pop()!.toLowerCase())
    if (!t) continue
    for (const c of t.columns) {
      if (c.type === 'lookup' && c.lookupTable && byLower.has(c.lookupTable.toLowerCase()) && !names.has(byLower.get(c.lookupTable.toLowerCase())!.name)) {
        const target = byLower.get(c.lookupTable.toLowerCase())!
        names.add(target.name)
        queue.push(target.name)
      }
    }
  }
  // system tables (Users through createdBy / owner) are in every environment: never part of an app package
  return [...names].map((n) => byLower.get(n.toLowerCase())!).filter((t) => t && !t.system)
}

/* ------------------------------------------------------------------ export */

/** the table events and validation rules of a table as they travel in a package (ids kept, no times) */
async function eventsOf(s: Services, tableId: string): Promise<PkgEvent[]> {
  if (!s.kernel) return []
  return (await s.kernel.listEvents(tableId)).map((e) => {
    const { tableId: _t, createdOn: _c, modifiedOn: _m, modifiedBy: _b, ...rest } = e
    void _t; void _c; void _m; void _b
    return rest
  })
}

export async function tableEntry(s: Services, user: UserContext | null, def: TableDef, includeData: boolean): Promise<Record<string, unknown>> {
  // core data model: a system table is never exported as schema, only the columns makers added (and never its rows:
  // collaboration data stays in the environment)
  if (def.system) {
    const custom = plainTableDef({ ...def, columns: def.columns.filter((c) => !c.locked) })
    return { schema: { id: custom.id, name: custom.name, displayName: custom.displayName, primaryColumn: custom.primaryColumn, columns: custom.columns, system: true }, events: await eventsOf(s, def.id) }
  }
  const schema = plainTableDef(def)
  const events = await eventsOf(s, def.id)
  // events always travel (an empty list removes the target's events on an upgrade; old packages have no key)
  // relationships (package K) travel with their child table
  const relationships = await pkgRelationshipsOf(s, def.id)
  if (!includeData) return { schema, events, ...(relationships.length ? { relationships } : {}) }
  const visible = user ? user.visibleDef(def) : def
  const rows = await queryAll(s, user, def)
  const csv = unparseCsv(visible.columns.map((c) => c.name), rows.map((r) => visible.columns.map((c) => jsonCellToCsv(r[c.name]))))
  return { schema, csv, events, ...(relationships.length ? { relationships } : {}) }
}

export async function appEntry(s: Services, id: string): Promise<{ id: string; name: string; description?: string; definition: AppDef }> {
  const a = await s.meta.apps.get(id)
  if (!a) throw new HttpError(404, 'not-found', 'App not found.')
  return { id, name: a.meta.name, ...(a.meta.description ? { description: a.meta.description } : {}), definition: clone(a.definition) }
}

export async function exportAppPackage(s: Services, ctx: Ctx, id: string, includeData: boolean): Promise<string> {
  const entry = await appEntry(s, id)
  const used = tablesUsedBy(entry.definition, await s.meta.tables.list())
  const tables = []
  for (const t of used) tables.push(await tableEntry(s, ctx.user ?? null, t, includeData))
  return toYaml({ kind: 'appbuilder/app', packageVersion: PACKAGE_VERSION, exportedOn: s.now(), app: entry, tables })
}

/* ------------------------------------------------------------------ import */

export function parsePackage(text: unknown, kind: 'appbuilder/app' | 'appbuilder/solution'): Record<string, unknown> {
  if (typeof text !== 'string' || !text.trim()) throw invalid('The package is empty.', 'yaml')
  const doc = fromYaml(text)
  if (!isObj(doc)) throw invalid('This is not an Appbuilder package.', 'yaml')
  if (doc.kind !== kind) {
    const word = kind.split('/')[1]
    if (doc.kind === 'appbuilder/app' || doc.kind === 'appbuilder/solution') throw invalid(`This is a ${word === 'app' ? 'solution' : 'app'} package, not a ${word} package.`, 'yaml')
    throw invalid(`This is not an Appbuilder ${word} package (kind: ${String(doc.kind ?? 'missing')}).`, 'yaml')
  }
  if (doc.packageVersion !== PACKAGE_VERSION) throw invalid(`Unsupported package version ${String(doc.packageVersion)} (expected ${PACKAGE_VERSION}).`, 'yaml')
  return doc
}

/** a table event in a package (TableEventDef without table and times) */
export type PkgEvent = TableEventInput & { id?: string }
export interface PkgTable { def: TableDef; csv?: string; events?: PkgEvent[]; relationships?: RelationshipDef[] }

const EVENT_KEYS = ['name', 'kind', 'timing', 'operations', 'order', 'enabled', 'condition', 'actions', 'message', 'field', 'runAs', 'description'] as const
function readPkgEvents(v: unknown): PkgEvent[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw invalid('The "events" of a table in the package must be a list.')
  return v.map((e) => {
    if (!isObj(e) || typeof e.name !== 'string') throw invalid('A table event in the package is malformed.')
    const out: Record<string, unknown> = {}
    for (const k of EVENT_KEYS) if (e[k] !== undefined) out[k] = e[k]
    if (typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.id)) out.id = e.id
    return out as PkgEvent
  })
}

/**
 * Events of the tables an import created (new copies): created with new ids. Events that run as the system are imported
 * disabled (an administrator reviews and enables them); the warnings say so.
 */
export async function importPkgEventsAsCopies(s: Services, list: PkgTable[], map: Map<string, string>, created: TableDef[], by: string | null, warnings: string[]): Promise<void> {
  if (!s.kernel) return
  for (const p of list) {
    if (!p.events?.length) continue
    const target = created.find((t) => t.id === map.get(p.def.id || p.def.name) || t.name.toLowerCase() === p.def.name.toLowerCase())
    if (!target) continue
    for (const e of p.events) {
      const { id: _id, ...input } = e
      void _id
      const system = input.runAs === 'system'
      await s.kernel.putEvent(target, system ? { ...input, enabled: false } : input, by)
      if (system) warnings.push(`The table event "${input.name}" of ${target.displayName} runs as the system: it was imported disabled. An administrator can review and enable it.`)
    }
  }
}
export function readPkgTables(v: unknown, now: string): PkgTable[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw invalid('The package "tables" must be a list.')
  return v.map((e) => {
    if (!isObj(e) || !isObj(e.schema)) throw invalid('A table entry in the package has no schema.')
    const events = readPkgEvents(e.events)
    const relationships = readPkgRelationships(e.relationships)
    return { def: sanitizeTableDef(e.schema, now), ...(typeof e.csv === 'string' ? { csv: e.csv } : {}), ...(events ? { events } : {}), ...(relationships?.length ? { relationships } : {}) }
  })
    // reporting views after the tables they read (package K)
    .sort((a, b) => Number(a.def.reporting?.kind === 'view') - Number(b.def.reporting?.kind === 'view'))
}

export interface PkgApp { oldId?: string; name: string; description?: string; def: AppDef }
export function readPkgApp(e: unknown): PkgApp {
  if (!isObj(e)) throw invalid('An app entry in the package is malformed.')
  const def = validateDef(e.definition)
  const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 100) : def.name || 'Imported app'
  return {
    ...(typeof e.id === 'string' ? { oldId: e.id } : {}), name,
    ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}), def: clone(def),
  }
}

/**
 * Reuse tables that exist by name, create the rest on the default connection (rows only into the new ones).
 * Returns old table id -> local table id and the tables created. Rolls everything back on failure.
 */
export async function ensurePkgTables(s: Services, list: PkgTable[], actorId?: string): Promise<{ map: Map<string, string>; created: TableDef[] }> {
  const map = new Map<string, string>()
  const existing = await s.meta.tables.list()
  const todo: PkgTable[] = []
  for (const p of list) {
    const hit = existing.find((t) => t.name.toLowerCase() === p.def.name.toLowerCase())
    if (hit) map.set(p.def.id, hit.id)
    else todo.push(p)
  }
  const created: TableDef[] = []
  const items: TableRows[] = []
  if (!todo.length) return { map, created }
  const { record, connector } = await resolveConnection(s)
  try {
    for (const p of todo) {
      const id = s.uid('tbl')
      map.set(p.def.id, id)
      const now = s.now()
      const def: TableDef = { ...p.def, id, createdOn: now, modifiedOn: now, connectionId: record.id }
      def.source = await pickSource(s, record, connector, def.name)
      // reporting settings name tables by package id (package K)
      if (def.reporting?.kind === 'view') await prepareViewDef(s, def, map)
      if (def.reporting?.kind === 'summary') def.reporting = { ...def.reporting, source: map.get(def.reporting.source) ?? def.reporting.source }
      await createPhysical(s, record, connector, def)
      created.push(def)
      if (p.csv) items.push({ def, rows: csvToRows(def, p.csv) })
    }
    if (items.length) await importRowsSystem(s, items, actorId)
    await restorePkgRelationships(s, todo, map)
  } catch (e) {
    await rollbackTables(s, connector, created)
    throw e
  }
  return { map, created }
}

export async function rollbackTables(s: Services, connector: Connector, defs: TableDef[]): Promise<void> {
  for (const d of defs) {
    await connector.dropTable(d).catch(() => {})
    await unregisterTable(s, d).catch(() => {})
  }
}

export type { ConnectionRecord }
