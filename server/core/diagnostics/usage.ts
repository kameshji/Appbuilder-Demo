/**
 * Usage basics for Admin console > Usage (package L): users (active, signed in recently, online now), storage sizes
 * (database, workspace folders, backups, logs), tables and row counts per environment, job statistics per environment.
 * Row counts are exact for tables up to EXACT_COUNT_LIMIT rows (by the planner's estimate) and the estimate above that.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CoreServices } from '../services.ts'
import type { UsageReport } from '../../../src/platform/ops.ts'
import { runInEnvironment } from '../env-context.ts'
import { errText, log } from '../util.ts'
import { activeFileLog } from './logger.ts'

export const EXACT_COUNT_LIMIT = 100_000
const MAX_WALK_ENTRIES = 500_000

/** bytes under a folder (regular files; symbolic links are not followed); stops counting after MAX_WALK_ENTRIES */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0
  let seen = 0
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        try {
          total += (await fs.promises.stat(p)).size
        } catch { /* gone */ }
      }
    }
  }
  await walk(dir)
  return total
}

type Row = Record<string, unknown>
const n = (v: unknown): number => Number(v ?? 0) || 0

export async function usageReport(services: CoreServices, live: { onlineUsers(): string[] } | null): Promise<UsageReport> {
  const db = services.state.db
  if (!services.ready() || !db) throw Object.assign(new Error('The database is not available.'), { status: 503 })
  const ws = services.config.workspaceDir

  const u = (await db.query<Row>(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status <> 'disabled' AND kind <> 'service')::int AS active,
      count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
      count(*) FILTER (WHERE kind = 'service')::int AS service,
      count(*) FILTER (WHERE last_login > now() - interval '1 day')::int AS d1,
      count(*) FILTER (WHERE last_login > now() - interval '7 days')::int AS d7,
      count(*) FILTER (WHERE last_login > now() - interval '30 days')::int AS d30
    FROM "ab"."users"`))[0]

  let databaseBytes: number | null = null
  try {
    databaseBytes = n((await db.query<Row>(`SELECT pg_database_size(current_database())::bigint AS b`))[0]?.b)
  } catch { /* no privilege */ }

  const envs = (await services.environments.list()).filter((e) => e.state === 'ready')
  const environments: UsageReport['environments'] = []
  let attachmentsBytes = 0
  let filesBytes = 0
  for (const e of envs) {
    const tables = await db.query<Row>(
      `SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS est, pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`, [e.schema])
    const out: UsageReport['environments'][number]['tables'] = []
    for (const t of tables) {
      const name = String(t.name)
      const est = n(t.est)
      let rows = est
      let approximate = true
      if (est <= EXACT_COUNT_LIMIT) {
        try {
          rows = n((await db.query<Row>(`SELECT count(*)::bigint AS c FROM "${e.schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`))[0]?.c)
          approximate = false
        } catch (err) {
          log('warn', `usage: counting ${e.schema}.${name} failed: ${errText(err)}`)
        }
      }
      out.push({ name, system: name.startsWith('ab_'), rows, approximate, bytes: n(t.bytes) })
    }
    let jobs: UsageReport['environments'][number]['jobs'] = null
    try {
      const T = `"${e.schema.replace(/"/g, '""')}"."ab_jobs"`
      const s = (await db.query<Row>(`SELECT
          count(*) FILTER (WHERE state = 'succeeded' AND finished_on > now() - interval '24 hours')::int AS ok,
          count(*) FILTER (WHERE state IN ('failed', 'dead') AND modified_on > now() - interval '24 hours')::int AS bad,
          count(*) FILTER (WHERE state = 'dead')::int AS dead,
          count(*) FILTER (WHERE state = 'queued')::int AS queued
        FROM ${T}`))[0]
      const byType = await db.query<Row>(`SELECT type,
          count(*) FILTER (WHERE state = 'succeeded' AND finished_on > now() - interval '24 hours')::int AS ok,
          count(*) FILTER (WHERE state IN ('failed', 'dead') AND modified_on > now() - interval '24 hours')::int AS bad
        FROM ${T} GROUP BY type ORDER BY type`)
      jobs = {
        succeeded24h: n(s?.ok), failed24h: n(s?.bad), dead: n(s?.dead), queued: n(s?.queued),
        byType: byType.map((r) => ({ type: String(r.type), succeeded24h: n(r.ok), failed24h: n(r.bad) })).filter((r) => r.succeeded24h || r.failed24h),
      }
    } catch { /* no job table in this environment */ }
    environments.push({ id: e.id, name: e.name, schemaBytes: out.reduce((s, t) => s + t.bytes, 0), tables: out, jobs })
    await runInEnvironment(e.id, async () => {
      attachmentsBytes += await folderBytes(path.join(ws, 'env', e.id, 'attachments'))
      filesBytes += await folderBytes(path.join(ws, 'env', e.id, 'files'))
    })
  }

  let backupsBytes = 0
  try {
    const folder = (await services.backup.settings()).folder
    if (folder) backupsBytes = await folderBytes(folder)
  } catch { /* backups not available */ }
  const fl = activeFileLog()
  const logsBytes = fl ? fl.files().reduce((s, f) => s + f.bytes, 0) : 0

  return {
    generatedAt: new Date().toISOString(),
    users: {
      total: n(u?.total), active: n(u?.active), disabled: n(u?.disabled), serviceAccounts: n(u?.service),
      signedIn: { day: n(u?.d1), week: n(u?.d7), month: n(u?.d30) },
      onlineNow: live ? live.onlineUsers().length : 0,
    },
    storage: { databaseBytes, workspaceBytes: await folderBytes(ws), attachmentsBytes, filesBytes, backupsBytes, logsBytes },
    environments,
  }
}
