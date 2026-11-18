/**
 * The data model designer's backend (docs/dev/data-model.md). Server mode: /api/v1/model (plans with row counts and
 * conversion pre-checks, one-transaction apply, explicit relationships with delete behaviours, reporting views).
 * Demo mode: the browser workspace; relationships, layout and draft in localStorage; apply runs the changes one by
 * one through platform.tables (not transactional), and what needs the server (reporting views, summary tables) is
 * explained instead. Delete behaviours are enforced by the browser store too (src/platform/delete-rules.ts).
 */
import { PlatformError, platform } from '@/platform'
import type { ColumnDef, TableDef } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import type { Model, ModelApplyResult, ModelDraft, ModelLayout, ModelOp, ModelPlan, ModelPlanItem, ModelResponse, RelationshipDef } from '@/model/types'
import { applyOps, checkOps, describeOp, isSystemColumn, withImplicitRelationships } from '@/model/ops'
import type { ColumnStats } from '@/model/lint'

export interface IntrospectResult { model: Model; tables: string[]; warnings: string[]; found: number }

export interface ModelBackend {
  mode: 'server' | 'demo'
  load(): Promise<ModelResponse>
  saveDraft(d: ModelDraft): Promise<void>
  discardDraft(): Promise<void>
  saveLayout(layout: ModelLayout, scope: 'shared' | 'mine'): Promise<void>
  forgetMyLayout(): Promise<void>
  plan(ops: ModelOp[]): Promise<ModelPlan>
  apply(ops: ModelOp[], token: string, layout: ModelLayout, scope: 'shared' | 'mine'): Promise<ModelApplyResult>
  introspect(connectionId: string, mode: 'link' | 'copy', into: Model): Promise<IntrospectResult>
  stats(): Promise<ColumnStats[]>
  exportPackage(tableIds: string[], displayName: string): Promise<{ fileName: string; yaml: string }>
}

/** an API error that carries the server's plan (409 stale plan, 422 blocked) */
export class ModelApiError extends PlatformError {
  plan?: ModelPlan
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...environmentHeaders() },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: PlatformError['code']; message?: string }; plan?: ModelPlan } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    const code = b?.error?.code ?? (res.status === 403 ? 'denied' : res.status === 409 ? 'conflict' : res.status === 422 ? 'invalid' : 'storage')
    const e = new ModelApiError(code, b?.error?.message ?? `The server answered ${res.status}`)
    if (b?.plan) e.plan = b.plan
    throw e
  }
  return (await res.json()) as T
}

const serverBackend: ModelBackend = {
  mode: 'server',
  load: () => call<ModelResponse>('GET', '/model'),
  saveDraft: async (draft) => { await call('PUT', '/model/draft', { draft }) },
  discardDraft: async () => { await call('DELETE', '/model/draft') },
  saveLayout: async (layout, scope) => { await call('PUT', '/model/layout', { layout, scope }) },
  forgetMyLayout: async () => { await call('DELETE', '/model/layout') },
  plan: (ops) => call<ModelPlan>('POST', '/model/plan', { ops }),
  apply: (ops, token, layout, scope) => call<ModelApplyResult>('POST', '/model/apply', { ops, token, layout, layoutScope: scope, clearDraft: true }),
  introspect: (connectionId, mode, into) => call<IntrospectResult>('POST', '/model/introspect', { connectionId, mode, into }),
  stats: async () => (await call<{ items: ColumnStats[] }>('GET', '/model/stats')).items,
  exportPackage: (tables, displayName) => call<{ fileName: string; yaml: string }>('POST', '/model/package', { tables, displayName }),
}

/* ------------------------------------------------------------------ demo mode (browser workspace) */

const key = (k: string) => `appbuilder-model:${platform.getState().environmentId || 'default'}:${k}`
function read<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(key(k))
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}
function write(k: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(key(k))
    else localStorage.setItem(key(k), JSON.stringify(v))
  } catch {
    /* storage refused (quota, private mode): the change lasts for this page */
  }
}

function demoLive(): Model {
  const tables = platform.getState().tables
  return withImplicitRelationships({ tables, relationships: read<RelationshipDef[]>('relationships', []) })
}

const SERVER_ONLY = 'needs the local server (reporting views, summary tables and links to other databases are created by the server)'

function demoPlan(ops: ModelOp[]): ModelPlan {
  const live = demoLive()
  const problems = checkOps(live, ops)
  const items: ModelPlanItem[] = []
  const rows = (id: string) => {
    const t = live.tables.find((x) => x.id === id)
    return t ? platform.tables.rows(t.name, { secure: false }).length : undefined
  }
  for (const o of ops) {
    if (o.op === 'createTable') {
      if (o.table.link || (o.table.reporting && o.table.reporting.kind !== 'date')) problems.push(`"${o.table.displayName}" ${SERVER_ONLY}.`)
      items.push({ kind: o.table.reporting?.kind === 'view' ? 'view' : 'table', change: 'new', table: o.table.displayName, name: o.table.name, note: `${o.table.columns.filter((c) => !isSystemColumn(c)).length} columns` })
    } else if (o.op === 'dropTable') {
      const n = rows(o.id)
      items.push({ kind: 'table', change: 'removed', table: o.name, name: o.name, rows: n, destructive: (n ?? 0) > 0, note: `The table and its ${n ?? ''} rows are deleted.` })
    } else if (o.op === 'dropColumn') {
      const t = live.tables.find((x) => x.id === o.table)
      const n = t ? platform.tables.rows(t.name, { secure: false }).filter((r) => r[o.name] !== null && r[o.name] !== '').length : undefined
      items.push({ kind: 'column', change: 'removed', table: t?.displayName ?? o.table, name: o.name, rows: n, destructive: (n ?? 0) > 0 })
    } else if (o.op === 'addColumn') {
      items.push({ kind: 'column', change: 'new', table: live.tables.find((x) => x.id === o.table)?.displayName ?? o.table, name: o.column.displayName, note: o.column.type })
    } else if (o.op === 'updateColumn') {
      items.push({ kind: 'column', change: 'changed', table: live.tables.find((x) => x.id === o.table)?.displayName ?? o.table, name: o.after.displayName, note: o.after.type !== o.before.type ? `type ${o.before.type} → ${o.after.type} (checked when applied)` : 'settings change' })
    } else if (o.op === 'updateTable') {
      if (o.patch.uniqueTogether?.length) problems.push(`Unique pairs ${SERVER_ONLY}.`)
      items.push({ kind: 'table', change: 'changed', table: live.tables.find((x) => x.id === o.id)?.displayName ?? o.id, name: '' })
    } else if (o.op === 'putRelationship') {
      items.push({ kind: 'relationship', change: o.before ? 'changed' : 'new', table: live.tables.find((x) => x.id === o.rel.fromTable)?.displayName ?? o.rel.fromTable, name: describeOp(applyOps(live, ops).model, o), note: `on delete: ${o.rel.onDelete}` })
    } else if (o.op === 'dropRelationship') {
      items.push({ kind: 'relationship', change: 'removed', table: '', name: o.id })
    }
  }
  for (const o of ops) if (o.op === 'createTable' && o.table.uniqueTogether?.length) problems.push(`"${o.table.displayName}": unique pairs ${SERVER_ONLY}.`)
  const rollups = ops.flatMap((o) => (o.op === 'createTable' ? o.table.columns.map((c) => ({ t: o.table.displayName, c })) : o.op === 'addColumn' ? [{ t: o.table, c: o.column }] : [])).filter((x) => x.c.computed?.kind === 'rollup')
  const warnings = ['Demo mode: changes are applied one by one in this browser (no single transaction, no backup).']
  if (rollups.length) warnings.push(`Rollup columns are skipped in demo mode (the server keeps them up to date): ${rollups.map((x) => `${x.t}.${x.c.displayName}`).join(', ')}.`)
  return {
    items, destructive: items.some((i) => i.destructive), problems: [...new Set(problems)],
    warnings,
    backup: { available: false, message: 'Demo mode keeps everything in this browser: no backup is taken.' },
    token: String(JSON.stringify(ops).length), opCount: ops.length,
  }
}

const userCols = (cols: ColumnDef[]) => cols.filter((c) => !isSystemColumn(c))

async function demoApply(ops: ModelOp[], layout: ModelLayout): Promise<ModelApplyResult> {
  const plan = demoPlan(ops)
  if (plan.problems.length) throw new PlatformError('invalid', plan.problems[0])
  const ids: Record<string, string> = {}
  const real = (id: string) => ids[id] ?? id
  const nameOf = (id: string) => platform.tables.get(real(id))?.name ?? id
  const rels = read<RelationshipDef[]>('relationships', [])
  for (const o of ops) if (o.op === 'dropRelationship') rels.splice(0, rels.length, ...rels.filter((r) => r.id !== o.id))
  for (const o of ops) if (o.op === 'dropColumn') await platform.tables.removeColumn(real(o.table), o.name)
  for (const o of ops) if (o.op === 'dropTable') await platform.tables.remove(o.id)
  const creates = ops.filter((o): o is Extract<ModelOp, { op: 'createTable' }> => o.op === 'createTable')
  const later: { table: string; col: ColumnDef }[] = []
  for (const o of creates) {
    const plain = userCols(o.table.columns).filter((c) => c.type !== 'lookup' && !c.computed)
    const t: TableDef = await platform.tables.create({ displayName: o.table.displayName, name: o.table.name, description: o.table.description, columns: plain.length ? plain : [{ displayName: 'Name', type: 'text' }] })
    ids[o.table.id] = t.id
    for (const c of userCols(o.table.columns)) if (c.type === 'lookup' || c.computed) later.push({ table: o.table.id, col: c })
  }
  const serverOnly = (c: ColumnDef) => c.computed?.kind === 'rollup'
  for (const l of later) if (!serverOnly(l.col)) await platform.tables.addColumn(real(l.table), { ...l.col })
  for (const o of ops) if (o.op === 'addColumn' && !serverOnly(o.column)) await platform.tables.addColumn(real(o.table), { ...o.column })
  for (const o of ops) if (o.op === 'updateColumn') await platform.tables.updateColumn(real(o.table), o.name, { ...o.after })
  for (const o of ops) {
    if (o.op !== 'updateTable') continue
    const { uniqueTogether: _u, ...patch } = o.patch
    void _u
    if (Object.keys(patch).length) await platform.tables.update(real(o.id), patch)
  }
  for (const o of creates) {
    if (o.table.primaryColumn && platform.tables.get(real(o.table.id))?.columns.some((c) => c.name === o.table.primaryColumn)) await platform.tables.update(real(o.table.id), { primaryColumn: o.table.primaryColumn })
  }
  // date dimension rows (the one reporting table demo mode can make)
  for (const o of creates) {
    if (o.table.reporting?.kind !== 'date') continue
    const { dateDimRows } = await import('@/model/datedim')
    const name = nameOf(o.table.id)
    for (const r of dateDimRows(o.table.reporting)) platform.tables.insert(name, { ...r }, { secure: false })
    await platform.tables.flush()
  }
  for (const o of ops) {
    if (o.op !== 'putRelationship') continue
    const r = { ...o.rel, fromTable: real(o.rel.fromTable), toTable: real(o.rel.toTable) }
    const i = rels.findIndex((x) => x.id === r.id)
    if (i >= 0) rels[i] = r
    else rels.push(r)
  }
  write('relationships', rels)
  const positions = { ...read<ModelLayout>('layout', { positions: {}, areas: [] }).positions }
  for (const [k, p] of Object.entries(layout.positions)) positions[real(k)] = p
  write('layout', { positions, areas: layout.areas.map((a) => ({ ...a, tables: a.tables.map(real) })) })
  write('draft', null)
  return { ids, plan, backup: { taken: false, message: plan.backup.message } }
}

const demoBackend: ModelBackend = {
  mode: 'demo',
  async load() {
    const model = demoLive()
    return { model, layout: read<ModelLayout>('layout', { positions: {}, areas: [] }), myLayout: read<ModelLayout | null>('mylayout', null) ?? undefined, draft: read<ModelDraft | null>('draft', null), locked: false, version: String(model.tables.length) }
  },
  saveDraft: async (d) => write('draft', d),
  discardDraft: async () => write('draft', null),
  saveLayout: async (l, scope) => write(scope === 'mine' ? 'mylayout' : 'layout', l),
  forgetMyLayout: async () => write('mylayout', null),
  plan: async (ops) => demoPlan(ops),
  apply: (ops, _token, layout) => demoApply(ops, layout),
  introspect: async () => { throw new PlatformError('unavailable', 'Reading another database needs the local server.') },
  stats: async () => {
    const out: ColumnStats[] = []
    for (const t of platform.getState().tables) {
      const rows = platform.tables.rows(t.name, { secure: false }).slice(0, 5000)
      for (const c of t.columns) {
        if (c.system || (c.type !== 'text' && c.type !== 'multiline')) continue
        const vs = rows.map((r) => r[c.name]).filter((v) => typeof v === 'string' && v.trim() !== '') as string[]
        out.push({ table: t.id, column: c.name, values: vs.length, numeric: vs.filter((v) => /^\s*[+-]?\d+([.,]\d+)?\s*$/.test(v)).length, dates: vs.filter((v) => /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/.test(v)).length })
      }
    }
    return out
  },
  exportPackage: async () => { throw new PlatformError('unavailable', 'The solution package export needs the local server. Use DBML in demo mode.') },
}

export const modelBackend = (): ModelBackend => (platform.getState().mode === 'server' ? serverBackend : demoBackend)

/** a spreadsheet read into sheets (server: xlsx and csv; demo: csv only, parsed here) */
export async function readSheets(file: File): Promise<{ name: string; headers: string[]; rows: string[][] }[]> {
  if (platform.getState().mode === 'server') {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/model/sheets?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/octet-stream', ...environmentHeaders() }, body: file })
    } catch {
      throw new PlatformError('unavailable', 'The server cannot be reached.')
    }
    const b = await res.json().catch(() => null)
    if (!res.ok) throw new PlatformError('invalid', b?.error?.message ?? `The server answered ${res.status}`)
    return b.sheets
  }
  if (!/\.csv$/i.test(file.name)) throw new PlatformError('unavailable', 'Excel files are read by the local server; in demo mode pick a CSV file.')
  const { parseCsvText } = await import('@/platform/csv')
  const p = parseCsvText(await file.text())
  return [{ name: file.name.replace(/\.csv$/i, ''), headers: p.headers, rows: p.records.map((r) => p.headers.map((h) => r[h] ?? '')) }]
}
