/**
 * Summary (aggregate) tables of the data model designer: a real table refreshed from its source by the job
 * `model.summary.refresh` (scheduled per table, cron from TableDef.reporting). The refresh runs as the system in one
 * transaction: delete every row, insert the groups (GROUP BY the chosen columns, the chosen aggregates), then one
 * `bulk` outbox row so open screens refresh. Its readers are limited by role access set at creation (engine.ts).
 */
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { SummaryDef } from '../../../src/model/types.ts'
import { hasRecycleBin, liveRowsSql, quoteId } from '../../connectors/postgres/sql.ts'
import type { CoreServices } from '../services.ts'
import { currentEnvironment } from '../env-context.ts'
import { JobError } from '../jobs.ts'

export const SUMMARY_JOB = 'model.summary.refresh'

const AGG: Record<SummaryDef['measures'][number]['fn'], (c: string) => string> = {
  sum: (c) => `SUM(${c})`, avg: (c) => `AVG(${c})`, min: (c) => `MIN(${c})`, max: (c) => `MAX(${c})`, count: () => 'COUNT(*)',
}

/** DELETE + INSERT ... SELECT ... GROUP BY of one refresh (identifiers checked by quoteId) */
export function summaryRefreshSql(schema: string, def: TableDef, src: TableDef): string[] {
  const r = def.reporting
  if (r?.kind !== 'summary') throw new Error('not a summary table')
  if (!def.source || !src.source) throw new Error('a physical table is missing')
  const T = `${quoteId(schema)}.${quoteId(def.source)}`
  const S = `${quoteId(schema)}.${quoteId(src.source)}`
  const cols = ['"id"', '"createdOn"', '"modifiedOn"', '"createdBy"', '"owner"']
  const sel = ['gen_random_uuid()::text', 'date_trunc(\'milliseconds\', now())', 'date_trunc(\'milliseconds\', now())', 'NULL', 'NULL']
  for (const g of r.groupBy) {
    if (!src.columns.some((c) => c.name === g)) throw new Error(`the source has no column ${g}`)
    cols.push(quoteId(g))
    sel.push(`s.${quoteId(g)}`)
  }
  for (const m of r.measures) {
    if (m.fn !== 'count' && (!m.column || !src.columns.some((c) => c.name === m.column))) throw new Error(`the source has no column ${m.column ?? ''}`)
    const target = def.columns.find((c) => c.name === m.name)
    cols.push(quoteId(m.name))
    const agg = AGG[m.fn](m.column ? `s.${quoteId(m.column)}` : '*')
    sel.push(target?.type === 'number' ? `(${agg})::bigint` : target?.type === 'currency' ? `(${agg})::numeric(19,4)` : `(${agg})::double precision`)
  }
  if (def.columns.some((c) => c.name === 'RefreshedOn')) {
    cols.push('"RefreshedOn"')
    sel.push('date_trunc(\'milliseconds\', now())')
  }
  const group = r.groupBy.length ? ` GROUP BY ${r.groupBy.map((g) => `s.${quoteId(g)}`).join(', ')}` : ''
  // one refresh at a time per table: two concurrent refreshes would each delete what they see and both insert
  // recycle bin: deleted source rows are not summarised
  const live = hasRecycleBin(src) ? ` WHERE ${liveRowsSql(src, 's')}` : ''
  return [`LOCK TABLE ${T} IN SHARE ROW EXCLUSIVE MODE`, `DELETE FROM ${T}`, `INSERT INTO ${T} (${cols.join(', ')}) SELECT ${sel.join(', ')} FROM ${S} AS s${live}${group}`]
}

export function registerSummaryJob(s: CoreServices): void {
  const jobs = s.kernel?.jobs
  if (!jobs) return
  jobs.register<{ tableId: string }>({
    type: SUMMARY_JOB,
    schedule: 'custom',
    description: 'Recomputes a summary table of the data model designer from its source table.',
    concurrency: 2,
    maxAttempts: 3,
    parse: (raw) => {
      const o = raw as { tableId?: unknown }
      if (!o || typeof o.tableId !== 'string' || !o.tableId) throw new JobError('The payload needs "tableId".', { retry: false })
      return { tableId: o.tableId }
    },
    handler: async (p) => {
      const def = await s.meta.tables.get(p.tableId)
      if (!def || def.reporting?.kind !== 'summary') throw new JobError('The summary table no longer exists.', { retry: false })
      const src = await s.meta.tables.get(def.reporting.source)
      if (!src) throw new JobError('The source table of the summary no longer exists.', { retry: false })
      const db = s.state.db
      if (!db) throw new Error('The database is not available.')
      let rows = 0
      await s.transaction(async () => {
        for (const stmt of summaryRefreshSql(currentEnvironment().schema, def, src)) {
          const r = await db.exec(stmt)
          rows = r.affectedRows
        }
        await s.kernel.hooks.outbox(null, def, { op: 'bulk', rowCount: rows, details: { action: 'summary.refresh' } })
      })
      return { rows }
    },
  })
}
