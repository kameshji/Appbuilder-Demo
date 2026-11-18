/**
 * Storage adapters. Paths are forward-slash, relative to the workspace root.
 *  - BrowserStorage: IndexedDB, with an in-memory fallback when IndexedDB is unavailable or throws.
 *  - MemoryStorage: plain Map; used for tests and as the last resort.
 */
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
