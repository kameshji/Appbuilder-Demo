/**
 * Data model designer storage (P0-K, docs/dev/data-model.md), per environment schema:
 *   ab_relationships   one row per relationship (from table + lookup column -> to table, kind, delete behaviour)
 *   ab_model_layouts   diagram positions and areas: the shared layout (user_id '') and per-user layouts
 *   ab_model_drafts    one draft per user (the edited model, its base snapshot, undo/redo)
 * Reporting views, summary tables and date dimensions are registered tables (ab_tables, TableDef.reporting).
 */
import type { SqlDb } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { ModelDraft, ModelLayout, RelationshipDef } from '../../../src/model/types.ts'
import { defaultDeleteBehaviour } from '../../../src/model/ops.ts'
import { toIso } from '../util.ts'

const q = (id: string): string => `"${id}"`
type Row = Record<string, unknown>

/** the designer's tables of one environment schema (appended to environmentDdl, idempotent) */
export function modelEnvironmentDdl(schema: string): string[] {
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_relationships')} (
      id text PRIMARY KEY,
      from_table text NOT NULL,
      from_column text NOT NULL,
      to_table text NOT NULL,
      kind text NOT NULL DEFAULT 'oneToMany',
      on_delete text NOT NULL DEFAULT 'setBlank',
      def jsonb NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_relationships_from ON ${E('ab_relationships')} (from_table, from_column)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_relationships_to ON ${E('ab_relationships')} (to_table)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_model_layouts')} (
      user_id text PRIMARY KEY,
      layout jsonb NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_model_drafts')} (
      user_id text PRIMARY KEY,
      draft jsonb NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
  ]
}
export const MODEL_TABLES = ['ab_relationships', 'ab_model_layouts', 'ab_model_drafts']

export interface RelationshipStore {
  list(): Promise<RelationshipDef[]>
  /** relationships whose parent is this table */
  toTable(tableId: string): Promise<RelationshipDef[]>
  put(r: RelationshipDef): Promise<void>
  remove(id: string): Promise<void>
  /** a table was removed: its relationships (both ends) go */
  removeForTable(tableId: string): Promise<void>
  /**
   * every lookup column gets a record (default behaviour: required -> restrict, optional -> set blank); records whose
   * lookup column is gone are removed. Returns what it changed.
   */
  sync(tables: TableDef[]): Promise<{ added: number; removed: number }>
  layouts: {
    get(userId: string): Promise<ModelLayout | null>
    put(userId: string, layout: ModelLayout): Promise<void>
    remove(userId: string): Promise<void>
  }
  drafts: {
    get(userId: string): Promise<ModelDraft | null>
    put(userId: string, draft: ModelDraft): Promise<string>
    remove(userId: string): Promise<void>
  }
}

/** system columns (createdBy, owner: lookups to the system User table, package N) are never modelled relationships */
const isSystemCol = (c: { name: string; system?: boolean }): boolean => !!c.system || ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'].includes(c.name)
const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v)

function fromRow(r: Row): RelationshipDef {
  const extra = (parse(r.def) ?? {}) as Partial<RelationshipDef>
  const out: RelationshipDef = {
    id: String(r.id), fromTable: String(r.from_table), fromColumn: String(r.from_column), toTable: String(r.to_table),
    kind: String(r.kind) as RelationshipDef['kind'], onDelete: String(r.on_delete) as RelationshipDef['onDelete'],
  }
  if (extra.preventCycles) out.preventCycles = true
  if (extra.junction?.group) out.junction = { group: String(extra.junction.group) }
  return out
}

/** relationships implied by lookup columns (what sync() records) */
export function implicitRelationships(tables: TableDef[], have: RelationshipDef[]): { add: RelationshipDef[]; stale: string[] } {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const valid = new Set<string>()
  const stale: string[] = []
  for (const r of have) {
    const t = tables.find((x) => x.id === r.fromTable)
    const c = t?.columns.find((x) => x.name === r.fromColumn)
    const target = c?.type === 'lookup' && !isSystemCol(c) ? byName.get((c.lookupTable ?? '').toLowerCase()) : undefined
    if (t && c && target && target.id === r.toTable) valid.add(`${r.fromTable}\u0000${r.fromColumn}`)
    else stale.push(r.id)
  }
  const add: RelationshipDef[] = []
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.type !== 'lookup' || isSystemCol(c) || valid.has(`${t.id}\u0000${c.name}`)) continue
      const target = byName.get((c.lookupTable ?? '').toLowerCase())
      if (!target) continue
      add.push({
        id: `rel_${t.id}_${c.name}`.slice(0, 64), fromTable: t.id, fromColumn: c.name, toTable: target.id,
        kind: target.id === t.id ? 'self' : c.unique ? 'oneToOne' : 'oneToMany', onDelete: defaultDeleteBehaviour(c),
      })
    }
  }
  return { add, stale }
}

export function createRelationshipStore(db: SqlDb, schemaOf: () => string): RelationshipStore {
  const E = (t: string): string => `${q(schemaOf())}.${q(t)}`
  const put = async (r: RelationshipDef): Promise<void> => {
    const now = new Date()
    const extra: Record<string, unknown> = {}
    if (r.preventCycles) extra.preventCycles = true
    if (r.junction) extra.junction = r.junction
    // one relationship per lookup column: a record with another id for the same column is replaced
    await db.exec(`DELETE FROM ${E('ab_relationships')} WHERE from_table = $1 AND from_column = $2 AND id <> $3`, [r.fromTable, r.fromColumn, r.id])
    await db.exec(
      `INSERT INTO ${E('ab_relationships')} (id, from_table, from_column, to_table, kind, on_delete, def, created_on, modified_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
       ON CONFLICT (id) DO UPDATE SET from_table = EXCLUDED.from_table, from_column = EXCLUDED.from_column, to_table = EXCLUDED.to_table,
         kind = EXCLUDED.kind, on_delete = EXCLUDED.on_delete, def = EXCLUDED.def, modified_on = EXCLUDED.modified_on`,
      [r.id, r.fromTable, r.fromColumn, r.toTable, r.kind, r.onDelete, JSON.stringify(extra), now],
    )
  }
  const list = async (): Promise<RelationshipDef[]> => (await db.query<Row>(`SELECT * FROM ${E('ab_relationships')} ORDER BY id`)).map(fromRow)
  return {
    list,
    async toTable(tableId) {
      return (await db.query<Row>(`SELECT * FROM ${E('ab_relationships')} WHERE to_table = $1 ORDER BY id`, [tableId])).map(fromRow)
    },
    put,
    async remove(id) {
      await db.exec(`DELETE FROM ${E('ab_relationships')} WHERE id = $1`, [id])
    },
    async removeForTable(tableId) {
      await db.exec(`DELETE FROM ${E('ab_relationships')} WHERE from_table = $1 OR to_table = $1`, [tableId])
    },
    async sync(tables) {
      const { add, stale } = implicitRelationships(tables, await list())
      if (stale.length) await db.exec(`DELETE FROM ${E('ab_relationships')} WHERE id = ANY($1::text[])`, [stale])
      for (const r of add) await put(r)
      return { added: add.length, removed: stale.length }
    },
    layouts: {
      async get(userId) {
        const r = await db.query<Row>(`SELECT layout FROM ${E('ab_model_layouts')} WHERE user_id = $1`, [userId])
        return r.length ? (parse(r[0].layout) as ModelLayout) : null
      },
      async put(userId, layout) {
        await db.exec(
          `INSERT INTO ${E('ab_model_layouts')} (user_id, layout, modified_on) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id) DO UPDATE SET layout = EXCLUDED.layout, modified_on = EXCLUDED.modified_on`,
          [userId, JSON.stringify(layout), new Date()],
        )
      },
      async remove(userId) {
        await db.exec(`DELETE FROM ${E('ab_model_layouts')} WHERE user_id = $1`, [userId])
      },
    },
    drafts: {
      async get(userId) {
        const r = await db.query<Row>(`SELECT draft, modified_on FROM ${E('ab_model_drafts')} WHERE user_id = $1`, [userId])
        if (!r.length) return null
        const d = parse(r[0].draft) as ModelDraft
        d.modifiedOn = toIso(r[0].modified_on) ?? undefined
        return d
      },
      async put(userId, draft) {
        const now = new Date()
        const { modifiedOn: _m, ...rest } = draft
        void _m
        await db.exec(
          `INSERT INTO ${E('ab_model_drafts')} (user_id, draft, modified_on) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id) DO UPDATE SET draft = EXCLUDED.draft, modified_on = EXCLUDED.modified_on`,
          [userId, JSON.stringify(rest), now],
        )
        return now.toISOString()
      },
      async remove(userId) {
        await db.exec(`DELETE FROM ${E('ab_model_drafts')} WHERE user_id = $1`, [userId])
      },
    },
  }
}

/**
 * Version 7 environment step (package K, independent of the other version 7 steps): the designer's tables exist
 * (environmentDdl created them just before), and every existing lookup column gets an explicit relationship record
 * with the default delete behaviour (required: restrict, optional: set blank), making today's behaviour explicit.
 */
export async function upgradeEnvironmentTo7Model(db: SqlDb, schema: string): Promise<void> {
  for (const t of MODEL_TABLES) {
    const r = await db.query<Row>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (r[0]?.ok !== true) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
  const rows = await db.query<Row>(`SELECT def FROM ${q(schema)}.${q('ab_tables')}`)
  const tables = rows.map((r) => parse(r.def) as TableDef).filter((t) => t && Array.isArray(t.columns))
  await createRelationshipStore(db, () => schema).sync(tables)
}
