/**
 * One-time migration of a phase-2 workspace (workspace.yaml, apps/*.app.yaml, tables/*.csv + *.schema.yaml)
 * into the server stores (SPEC3 section 8). Tables become files-connector tables (the CSV is copied into the
 * files folder as a data file, row ids are kept), apps/roles/solutions keep their ids, users arrive without
 * passwords. The legacy files are moved to workspace/legacy-phase2/ afterwards and never deleted.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppMeta, ColumnDef, DataFileDef, RoleDef, SolutionDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { Services } from '../../core/contracts.ts'
import { removeDataFile, storeDataFile } from '../../connectors/files/index.ts'
import {
  fromYaml, isObj, parseCsvText, sanitizeTableDef, toIdentifier, uniqueIdentifier, uniqueLabel, unparseCsv,
} from './util.ts'
import type { RoleX } from './util.ts'
import { FILES_CONNECTION_ID, ensureFilesConnection, grantDefaults } from './tables-core.ts'
import { validateDef } from './packages.ts'

export { seedSample } from './seed.ts'

const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
const exists = (p: string) => fs.stat(p).then(() => true, () => false)
const readText = (p: string) => fs.readFile(p, 'utf8').catch(() => null)

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(suffix)).sort()
  } catch {
    return []
  }
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : [])

/** highest autonumber value in the rows (so the counter continues after the migrated data) */
function maxAutonumber(col: ColumnDef, values: string[]): number {
  const prefix = col.prefix ?? ''
  let max = 0
  for (const v of values) {
    if (!v.startsWith(prefix)) continue
    const n = Number(v.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

async function seedCounter(s: Services, key: string, value: number): Promise<boolean> {
  try {
    await s.meta.db.exec('INSERT INTO ab_counters (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = GREATEST(v, VALUES(v))', [key, value])
    return true
  } catch {
    return false
  }
}

/** called by the core after the first admin is created; returns a human summary */
export async function migrateLegacyWorkspace(s: Services, adminUserId: string): Promise<{ migrated: boolean; summary: string }> {
  const dir = s.config.workspaceDir
  const wsPath = path.join(dir, 'workspace.yaml')
  const tableFiles = await listFiles(path.join(dir, 'tables'), '.schema.yaml')
  const appFiles = await listFiles(path.join(dir, 'apps'), '.app.yaml')
  const hasWs = await exists(wsPath)
  if (!hasWs && !tableFiles.length && !appFiles.length) return { migrated: false, summary: 'No phase-2 workspace found; nothing to migrate.' }

  const notes: string[] = []
  const admin = await s.meta.users.get(adminUserId)
  const now = s.now()
  let ws: Record<string, unknown> = {}
  if (hasWs) {
    try {
      const parsed = fromYaml((await readText(wsPath)) ?? '')
      if (isObj(parsed)) ws = parsed
    } catch (e) {
      notes.push(`workspace.yaml could not be read (${(e as Error).message}); roles and users were not migrated`)
    }
  }

  /* ---- plan users: legacy id -> target id (existing users are matched by email) */
  const userMap = new Map<string, string>()
  const newUsers: { id: string; name: string; email: string; legacyRoles: string[]; status: 'active' | 'disabled' }[] = []
  let skippedUsers = 0
  const takenIds = new Set<string>()
  for (const u of arr(ws.users)) {
    const legacyId = typeof u.id === 'string' ? u.id : ''
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : ''
    const name = typeof u.name === 'string' && u.name.trim() ? u.name.trim().slice(0, 100) : email || 'User'
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      if (legacyId) userMap.set(legacyId, adminUserId)
      skippedUsers++
      continue
    }
    const hit = (await s.meta.users.byEmail(email)) ?? newUsers.find((n) => n.email === email)
    if (hit) {
      if (legacyId) userMap.set(legacyId, hit.id)
      continue
    }
    const id = ID_OK.test(legacyId) && !takenIds.has(legacyId) && !(await s.meta.users.get(legacyId)) ? legacyId : s.uid('user')
    takenIds.add(id)
    if (legacyId) userMap.set(legacyId, id)
    newUsers.push({ id, name, email, legacyRoles: Array.isArray(u.roleIds) ? u.roleIds.map(String) : [], status: u.status === 'disabled' ? 'disabled' : 'active' })
  }

  /* ---- tables -> files connector */
  await ensureFilesConnection(s)
  const migratedTables: TableDef[] = []
  const storedFileIds: string[] = []
  let tableRows = 0
  try {
    const existingTables = await s.meta.tables.list()
    const usedNames = existingTables.map((t) => t.name)
    for (const f of tableFiles) {
      const schemaName = f.slice(0, -'.schema.yaml'.length)
      try {
        const raw = fromYaml((await readText(path.join(dir, 'tables', f))) ?? '')
        const def0 = sanitizeTableDef(isObj(raw) ? { ...raw, name: typeof raw.name === 'string' ? raw.name : schemaName } : raw, now)
        const name = uniqueIdentifier(def0.name, usedNames)
        usedNames.push(name)
        const id = def0.id && ID_OK.test(def0.id) && !(await s.meta.tables.get(def0.id)) && !migratedTables.some((t) => t.id === def0.id) ? def0.id : s.uid('tbl')
        const def: TableDef = { ...def0, id, name }
        const csvText = (await readText(path.join(dir, 'tables', `${schemaName}.csv`))) ?? ''
        const parsed = parseCsvText(csvText)
        const headers = parsed.headers.length ? parsed.headers : def.columns.map((c) => c.name)
        const ownerCols = new Set(['owner', 'createdBy'])
        const rows = parsed.records.map((rec) => {
          const out = headers.map((h) => rec[h] ?? '')
          headers.forEach((h, i) => {
            if (ownerCols.has(h)) out[i] = userMap.get(out[i]) ?? (out[i] && newUsers.some((n) => n.id === out[i]) ? out[i] : adminUserId)
            if (h === 'id' && !out[i]) out[i] = randomUUID()
          })
          return out
        })
        if (!headers.includes('id')) {
          headers.unshift('id')
          rows.forEach((r) => r.unshift(randomUUID()))
        }
        const bytes = Buffer.from(unparseCsv(headers, rows), 'utf8')
        const fileId = s.uid('file')
        const fileName = `${name}.csv`
        const stored = await storeDataFile(s.env, fileId, bytes, fileName)
        storedFileIds.push(fileId)
        const sheet = stored.sheets[0]
        // keep the legacy column names; if the files connector sanitised a header differently, follow it (order is the same)
        const userHeaders = headers.filter((h) => !def.columns.some((c) => c.system && c.name === h))
        const mapped = new Map<string, string>()
        sheet.columns.forEach((c, i) => { if (userHeaders[i] !== undefined) mapped.set(userHeaders[i], c.name) })
        const columns = def.columns.map((c) => {
          const to = mapped.get(c.name)
          if (!c.system && to && to !== c.name) {
            notes.push(`column "${c.name}" of table "${name}" was renamed to "${to}"`)
            return { ...c, name: to }
          }
          return c
        })
        const renamedPrimary = mapped.get(def.primaryColumn)
        const fileDef: DataFileDef & { storageKey: string; originalName: string } = {
          id: fileId, connectionId: FILES_CONNECTION_ID, fileName, kind: 'csv', sizeBytes: stored.sizeBytes, checksum: stored.checksum, importedOn: now,
          tableIds: [id], modifiedSinceImport: false, storageKey: stored.storageKey, originalName: fileName,
        }
        const final: TableDef = {
          ...def, columns, ...(renamedPrimary ? { primaryColumn: renamedPrimary } : {}), connectionId: FILES_CONNECTION_ID, source: `${fileId}/${sheet.sheet}`,
          origin: { kind: 'file', fileId, fileName, sheet: sheet.sheet, importedOn: now },
        }
        await s.meta.files.upsert(fileDef)
        await s.meta.tables.upsert(final)
        migratedTables.push(final)
        tableRows += rows.length
        for (const col of final.columns) {
          if (col.type !== 'autonumber') continue
          const idx = headers.indexOf(mapped.get(col.name) ? col.name : col.name)
          const vals = idx >= 0 ? rows.map((r) => r[idx]) : []
          const max = maxAutonumber(col, vals)
          if (max > 0 && !(await seedCounter(s, `${final.id}:${col.name}`, max))) notes.push(`could not continue the autonumber of ${name}.${col.name}`)
        }
      } catch (e) {
        notes.push(`table "${schemaName}" was skipped: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (migratedTables.length) await grantDefaults(s, migratedTables)
  } catch (e) {
    for (const id of storedFileIds) await removeDataFile(s.env, id).catch(() => {})
    throw e
  }
  const tableIds = new Set(migratedTables.map((t) => t.id))
  // legacy table ids that were re-issued are not tracked (privileges for them are dropped)

  /* ---- apps */
  const appIdMap = new Map<string, string>()
  let appCount = 0
  const appNames = (await s.meta.apps.list()).map((a) => a.name)
  for (const f of appFiles) {
    const fileId = f.slice(0, -'.app.yaml'.length)
    try {
      const doc = fromYaml((await readText(path.join(dir, 'apps', f))) ?? '')
      if (!isObj(doc) || !isObj(doc.meta)) throw new Error('not an app file')
      const def = validateDef(doc.definition)
      const m = doc.meta
      const id = ID_OK.test(fileId) && !(await s.meta.apps.get(fileId)) ? fileId : s.uid('app')
      const name = uniqueLabel((typeof m.name === 'string' && m.name.trim() ? m.name.trim() : def.name || fileId).slice(0, 100), appNames)
      appNames.push(name)
      def.name = name
      const meta: AppMeta = {
        id, name, width: typeof m.width === 'number' ? m.width : def.width, height: typeof m.height === 'number' ? m.height : def.height,
        createdOn: typeof m.createdOn === 'string' ? m.createdOn : now, modifiedOn: typeof m.modifiedOn === 'string' ? m.modifiedOn : now,
        modifiedBy: typeof m.modifiedBy === 'string' ? m.modifiedBy : 'Migrated',
        ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
      }
      await s.meta.apps.upsert(meta, def)
      appIdMap.set(fileId, id)
      if (typeof m.id === 'string') appIdMap.set(m.id, id)
      appCount++
    } catch (e) {
      notes.push(`app file "${f}" was skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* ---- roles (merged into the built-in roles by name) */
  const roleMap = new Map<string, string>()
  const existing = (await s.meta.roles.list()) as RoleX[]
  let roleCount = 0
  for (const r of arr(ws.roles)) {
    const legacyId = typeof r.id === 'string' ? r.id : ''
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : ''
    if (!name) continue
    const privileges: TablePrivilege[] = arr(r.privileges)
      .filter((p) => typeof p.table === 'string' && tableIds.has(p.table))
      .map((p) => {
        const scope = (v: unknown) => (v === 'all' || v === 'own' ? v : 'none')
        return { table: p.table as string, create: p.create === true, read: scope(p.read), update: scope(p.update), delete: scope(p.delete) }
      })
    const apps: string[] | 'all' = r.apps === 'all' ? 'all' : (Array.isArray(r.apps) ? r.apps.map(String) : []).map((a) => appIdMap.get(a)).filter((a): a is string => !!a)
    const hit = existing.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (hit) {
      roleMap.set(legacyId, hit.id)
      if (hit.isAdmin) continue
      const merged = hit.privileges.filter((p) => !privileges.some((q) => q.table === p.table)).concat(privileges)
      const mergedApps: string[] | 'all' = apps === 'all' || hit.apps === 'all' ? 'all' : [...new Set([...hit.apps, ...apps])]
      const next: RoleX = { ...hit, privileges: merged, apps: mergedApps }
      await s.meta.roles.upsert(next)
      existing[existing.indexOf(hit)] = next
    } else {
      const id = ID_OK.test(legacyId) && !existing.some((x) => x.id === legacyId) ? legacyId : s.uid('role')
      const role: RoleX = {
        id, name, privileges: r.isAdmin ? [] : privileges, apps,
        ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
        ...(r.isAdmin ? { isAdmin: true } : {}),
      } as RoleDef & { isMaker?: boolean }
      await s.meta.roles.upsert(role)
      existing.push(role)
      roleMap.set(legacyId, id)
      roleCount++
    }
  }

  /* ---- users (no passwords) */
  let userCount = 0
  for (const u of newUsers) {
    const roleIds = [...new Set(u.legacyRoles.map((r) => roleMap.get(r)).filter((r): r is string => !!r))]
    await s.meta.users.insert({ id: u.id, name: u.name, email: u.email, roleIds, status: u.status, passwordHash: null })
    userCount++
  }

  /* ---- solutions */
  let solCount = 0
  const sols = await s.meta.solutions.list()
  const solNames = sols.map((x) => x.name)
  const solLabels = sols.map((x) => x.displayName)
  for (const sol of arr(ws.solutions)) {
    const displayName = typeof sol.displayName === 'string' && sol.displayName.trim() ? sol.displayName.trim() : typeof sol.name === 'string' ? sol.name : ''
    if (!displayName) continue
    const components = arr(sol.components).flatMap((c): SolutionDef['components'] => {
      const id = String(c.id ?? '')
      if (c.kind === 'app' && appIdMap.has(id)) return [{ kind: 'app', id: appIdMap.get(id)! }]
      if (c.kind === 'table' && tableIds.has(id)) return [{ kind: 'table', id }]
      if (c.kind === 'role' && roleMap.has(id)) return [{ kind: 'role', id: roleMap.get(id)! }]
      return []
    })
    const label = uniqueLabel(displayName.slice(0, 200), solLabels)
    solLabels.push(label)
    const name = uniqueIdentifier(typeof sol.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sol.name) ? sol.name : toIdentifier(label, 'Solution'), solNames)
    solNames.push(name)
    await s.meta.solutions.upsert({
      id: s.uid('sol'), name, displayName: label, publisher: typeof sol.publisher === 'string' && sol.publisher ? sol.publisher : (admin?.name ?? 'Migrated'),
      version: typeof sol.version === 'string' && sol.version ? sol.version : '1.0.0',
      ...(typeof sol.description === 'string' && sol.description ? { description: sol.description } : {}),
      components, createdOn: now, modifiedOn: now,
    })
    solCount++
  }
  s.security.invalidate()

  /* ---- move the legacy files away (never delete) */
  let target = path.join(dir, 'legacy-phase2')
  for (let i = 2; await exists(target); i++) target = path.join(dir, `legacy-phase2-${i}`)
  let moved = true
  try {
    await fs.mkdir(target, { recursive: true })
    for (const entry of ['workspace.yaml', 'apps', 'tables']) {
      if (await exists(path.join(dir, entry))) await fs.rename(path.join(dir, entry), path.join(target, entry))
    }
    for (const f of await fs.readdir(dir)) if (/^workspace\.yaml\.corrupt-.*\.bak$/.test(f)) await fs.rename(path.join(dir, f), path.join(target, f))
  } catch (e) {
    moved = false
    notes.push(`the legacy files could not be moved (${e instanceof Error ? e.message : String(e)})`)
  }

  const parts = [
    `${appCount} app(s)`, `${migratedTables.length} table(s) with ${tableRows} row(s), stored as data files (device only)`,
    `${roleCount} new role(s) (built-in roles were merged by name)`, `${userCount} user(s)`, `${solCount} solution(s)`,
  ]
  let summary = `Migrated the phase-2 workspace: ${parts.join(', ')}.`
  if (userCount) summary += ' Migrated users have no password yet: an administrator must set one before they can sign in.'
  if (skippedUsers) summary += ` ${skippedUsers} user(s) without a usable email were not migrated.`
  if (moved) summary += ` The legacy files were moved to ${path.basename(target)}/ (nothing was deleted).`
  if (notes.length) summary += ` Notes: ${notes.join('; ')}.`
  return { migrated: true, summary }
}
