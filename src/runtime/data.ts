/**
 * Safe bridge to the platform (tables, users). Every call is wrapped so the runtime keeps working
 * when the platform is unavailable (stub, tests, storage failure): reads return empty values and
 * writes throw a PlatformError the host turns into a formula failure.
 */
import type { FxRecord, FxValue } from '@/contracts'
import { platform, PlatformError, userRecord, type ColumnDef, type DataErrorEvent, type Row, type TableDef, type WorkspaceState } from '@/platform'
import { CODE_MESSAGES } from '@/platform/errorMessages'

export const SYSTEM_COLUMNS = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])

export function platformState(): WorkspaceState | null {
  try {
    return platform.getState()
  } catch {
    return null
  }
}

export function platformReady(): boolean {
  return !!platformState()?.ready
}

export function tableDef(name: string): TableDef | undefined {
  try {
    return platform.tables.get(name)
  } catch {
    return undefined
  }
}

/** a platform table with exactly this (formula) name */
export function isTable(name: string): boolean {
  const t = tableDef(name)
  return !!t && t.name === name
}

export function tableNames(): string[] {
  return platformState()?.tables.map((t) => t.name) ?? []
}

export function tableRows(name: string): Row[] {
  try {
    return platform.tables.rows(name)
  } catch {
    return []
  }
}

export function tableColumns(name: string): ColumnDef[] {
  return tableDef(name)?.columns ?? []
}

export function currentUserRecord(): FxRecord | null {
  try {
    const st = platform.getState()
    return userRecord(platform.security.currentUser(), st.roles)
  } catch {
    return null
  }
}

export function currentUserId(): string {
  return platformState()?.currentUserId ?? ''
}

export function platformMode(): 'server' | 'demo' {
  return platformState()?.mode === 'server' ? 'server' : 'demo'
}

/** table names that are loading from the server / hit the row cap (server mode) */
export function loadingTables(): string[] {
  return platformState()?.loading ?? []
}
export function truncatedTables(): string[] {
  return platformState()?.truncated ?? []
}

/**
 * Load the rows of these tables (plus the tables their lookup columns point at) into the platform cache.
 * Idempotent; never throws (a failure just leaves the table empty and shows in the platform state).
 */
export function ensureTablesLoaded(names: string[]): void {
  try {
    const seen = new Set<string>()
    const queue = names.slice()
    while (queue.length) {
      const n = queue.pop() as string
      if (seen.has(n)) continue
      const def = tableDef(n)
      if (!def) continue
      seen.add(def.name)
      for (const c of def.columns) if (c.type === 'lookup' && c.lookupTable && !seen.has(c.lookupTable)) queue.push(c.lookupTable)
    }
    if (seen.size === 0) return
    void Promise.resolve(platform.tables.ensureLoaded([...seen])).catch(() => {})
  } catch {
    /* platform unavailable */
  }
}

export function dataVersion(): number {
  return platformState()?.dataVersion ?? 0
}

export function errorMessage(e: unknown): string {
  if (e instanceof PlatformError) return CODE_MESSAGES[e.code] ?? e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError || (e instanceof Error && typeof (e as { code?: unknown }).code === 'string')
}

/** values a formula may write to a table row: drop hidden and system fields */
export function writableValues(rec: FxRecord): FxRecord {
  const out: FxRecord = {}
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('__') || SYSTEM_COLUMNS.has(k)) continue
    out[k] = v as FxValue
  }
  return out
}

export function rowId(rec: FxRecord | null | undefined): string | null {
  if (!rec) return null
  if (typeof rec.__id === 'string' && rec.__id) return rec.__id
  if (typeof rec.id === 'string' && rec.id) return rec.id
  return null
}

export const tables = {
  insert(name: string, values: FxRecord): Row {
    return platform.tables.insert(name, writableValues(values))
  },
  update(name: string, id: string, changes: FxRecord): Row {
    return platform.tables.update(name, id, writableValues(changes))
  },
  delete(name: string, ids: string[]) {
    platform.tables.delete(name, ids)
  },
  reload(name: string) {
    try {
      void platform.tables.reload(name).catch(() => {})
    } catch {
      /* ignore */
    }
  },
}

/** the async tail of a Form submit talks to the platform through these */
export const submitDeps = {
  flush: () => platform.tables.flush(),
  upload: (table: string, column: string, id: string, file: File) => platform.attachments.upload(table, column, id, file),
  reload: (table: string) => platform.tables.reload(table),
}

/** the freshest copy of a row from the cache (after an upload refreshed its file cells) */
export function currentRow(name: string, id: string): Row | undefined {
  return tableRows(name).find((r) => r.__id === id)
}

/** subscribe to platform changes; returns a no-op unsubscribe when the platform is unavailable */
export function subscribePlatform(fn: () => void): () => void {
  try {
    return platform.subscribe(fn)
  } catch {
    return () => {}
  }
}

/** server-side write refusals (after the platform rolled the optimistic change back) */
export function subscribeDataErrors(fn: (e: DataErrorEvent) => void): () => void {
  try {
    if (typeof platform.onDataError === 'function') return platform.onDataError(fn)
  } catch {
    /* ignore */
  }
  return () => {}
}
