/**
 * Storage adapters. Paths are forward-slash, relative to the workspace root.
 *  - LocalFolderStorage: the Node server (server/) via /api/fs/*; real files in ./workspace.
 *  - BrowserStorage: IndexedDB, with an in-memory fallback when IndexedDB is unavailable or throws.
 *  - MemoryStorage: plain Map; used for tests and as the last resort.
 * selectStorage() probes /api/fs/health (800 ms) and never throws.
 */
import { PlatformError } from './contracts'
import type { StorageAdapter } from './contracts'

/* ------------------------------------------------------------------ memory */

export class MemoryStorage implements StorageAdapter {
  kind: StorageAdapter['kind']
  location: string
  readonly files = new Map<string, string>()
  constructor(kind: StorageAdapter['kind'] = 'browser', location = 'Browser storage') {
    this.kind = kind
    this.location = location
  }
  async readText(path: string) {
    return this.files.get(path) ?? null
  }
  async writeText(path: string, text: string) {
    this.files.set(path, text)
  }
  async remove(path: string) {
    this.files.delete(path)
  }
  async list(dir: string) {
    const prefix = dir === '' ? '' : dir.replace(/\/+$/, '') + '/'
    const out: string[] = []
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      if (rest && !rest.includes('/')) out.push(rest)
    }
    return out.sort()
  }
}

/* ------------------------------------------------------------------ local folder (server) */

export class LocalFolderStorage implements StorageAdapter {
  kind = 'local-folder' as const
  location: string
  private base: string
  constructor(location = 'workspace', base = '') {
    this.location = location
    this.base = base.replace(/\/+$/, '')
  }
  private url(route: string, key: 'path' | 'dir', value: string) {
    return `${this.base}/api/fs/${route}?${key}=${encodeURIComponent(value)}`
  }
  private async call(input: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(input, init)
    } catch (e) {
      throw new PlatformError('storage', `The local workspace server is not reachable (${(e as Error).message}).`)
    }
  }
  async readText(path: string): Promise<string | null> {
    const res = await this.call(this.url('read', 'path', path))
    // 204 is the server's "no such file" answer; 404 is still accepted as null for older servers.
    if (res.status === 204 || res.status === 404) return null
    if (!res.ok) throw new PlatformError('storage', `Could not read ${path} (HTTP ${res.status}).`)
    return res.text()
  }
  async writeText(path: string, text: string): Promise<void> {
    const res = await this.call(this.url('write', 'path', path), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    })
    if (!res.ok) throw new PlatformError('storage', `Could not write ${path} (HTTP ${res.status}).`)
  }
  async remove(path: string): Promise<void> {
    const res = await this.call(this.url('remove', 'path', path), { method: 'DELETE' })
    if (!res.ok) throw new PlatformError('storage', `Could not remove ${path} (HTTP ${res.status}).`)
  }
  async list(dir: string): Promise<string[]> {
    const res = await this.call(this.url('list', 'dir', dir))
    if (!res.ok) throw new PlatformError('storage', `Could not list ${dir} (HTTP ${res.status}).`)
    const body = (await res.json()) as { files?: unknown }
    return Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string') : []
  }
}

/* ------------------------------------------------------------------ browser (IndexedDB) */

const DB_NAME = 'appbuilder-workspace'
const STORE = 'files'

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export class BrowserStorage implements StorageAdapter {
  kind = 'browser' as const
  location = 'Browser storage'
  private fallback = new MemoryStorage()
  private dbp: Promise<IDBDatabase | null> | null = null
  /** true once IndexedDB failed and the in-memory fallback is in use (data lasts until the tab closes) */
  degraded = false

  private db(): Promise<IDBDatabase | null> {
    if (!this.dbp) {
      this.dbp = new Promise<IDBDatabase | null>((resolve) => {
        try {
          const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
          if (!idb) return resolve(null)
          const req = idb.open(DB_NAME, 1)
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
          req.onblocked = () => resolve(null)
        } catch {
          resolve(null)
        }
      }).then((db) => {
        if (!db) {
          this.degraded = true
          this.location = 'Browser storage (temporary, this tab only)'
        }
        return db
      })
    }
    return this.dbp
  }

  /** run against IndexedDB, or against memory when it is unavailable or throws */
  private async run<T>(op: (store: IDBObjectStore) => Promise<T>, mode: IDBTransactionMode, mem: () => Promise<T>): Promise<T> {
    const db = await this.db()
    if (!db) return mem()
    try {
      const tx = db.transaction(STORE, mode)
      return await op(tx.objectStore(STORE))
    } catch {
      this.degraded = true
      this.location = 'Browser storage (temporary, this tab only)'
      return mem()
    }
  }

  readText(path: string) {
    return this.run(async (s) => {
      const v = await wrap(s.get(path))
      return typeof v === 'string' ? v : null
    }, 'readonly', () => this.fallback.readText(path))
  }
  writeText(path: string, text: string) {
    return this.run(async (s) => void (await wrap(s.put(text, path))), 'readwrite', () => this.fallback.writeText(path, text))
  }
  remove(path: string) {
    return this.run(async (s) => void (await wrap(s.delete(path))), 'readwrite', () => this.fallback.remove(path))
  }
  list(dir: string) {
    const prefix = dir === '' ? '' : dir.replace(/\/+$/, '') + '/'
    return this.run(async (s) => {
      const keys = (await wrap(s.getAllKeys())) as IDBValidKey[]
      const out: string[] = []
      for (const k of keys) {
        if (typeof k !== 'string' || !k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        if (rest && !rest.includes('/')) out.push(rest)
      }
      return out.sort()
    }, 'readonly', () => this.fallback.list(dir))
  }
}

/* ------------------------------------------------------------------ selection */

/**
 * Prefer the local folder server when /api/fs/health answers within `timeoutMs` on an http(s) origin;
 * otherwise browser storage. Never throws.
 */
export async function selectStorage(timeoutMs = 800): Promise<StorageAdapter> {
  try {
    const loc = (globalThis as { location?: Location }).location
    if (loc && /^https?:$/.test(loc.protocol) && typeof fetch === 'function') {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setTimeout(() => ctl?.abort(), timeoutMs)
      try {
        const res = await Promise.race([
          fetch('/api/fs/health', { signal: ctl?.signal, cache: 'no-store' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ])
        if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
          const body = (await res.json()) as { ok?: boolean; root?: string }
          if (body.ok === true) return new LocalFolderStorage(typeof body.root === 'string' ? body.root : 'workspace')
        }
      } finally {
        clearTimeout(timer)
      }
    }
  } catch {
    /* fall through to browser storage */
  }
  try {
    return new BrowserStorage()
  } catch {
    return new MemoryStorage()
  }
}
