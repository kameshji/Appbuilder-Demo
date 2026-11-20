/**
 * A small key-value store over IndexedDB for the offline store (one database per user: `appbuilder-offline-<userId>`,
 * object stores `outbox`, `cache`, `meta`), and an in-memory twin with the same interface for tests and browsers
 * without IndexedDB. Values are structured-cloned (ArrayBuffers, typed arrays and plain objects).
 */
export type StoreName = 'outbox' | 'cache' | 'meta'
const STORES: StoreName[] = ['outbox', 'cache', 'meta']

export interface KV {
  get<T = unknown>(store: StoreName, key: string): Promise<T | undefined>
  put(store: StoreName, key: string, value: unknown): Promise<void>
  delete(store: StoreName, key: string): Promise<void>
  entries<T = unknown>(store: StoreName): Promise<Array<[string, T]>>
  clear(store?: StoreName): Promise<void>
  /** delete the whole database (sign-out, wipe) */
  destroy(): Promise<void>
}

export class MemoryKV implements KV {
  private data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]))
  async get<T>(store: StoreName, key: string) {
    return this.data.get(store)!.get(key) as T | undefined
  }
  async put(store: StoreName, key: string, value: unknown) {
    this.data.get(store)!.set(key, structuredClone(value))
  }
  async delete(store: StoreName, key: string) {
    this.data.get(store)!.delete(key)
  }
  async entries<T>(store: StoreName) {
    return [...this.data.get(store)!.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as Array<[string, T]>
  }
  async clear(store?: StoreName) {
    for (const s of store ? [store] : STORES) this.data.get(s)!.clear()
  }
  async destroy() {
    await this.clear()
  }
}

const req = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})

export const dbNameFor = (userId: string) => `appbuilder-offline-${userId}`

export class IndexedKV implements KV {
  private dbp: Promise<IDBDatabase> | null = null
  constructor(private readonly name: string) {}
  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(this.name, 1)
      open.onupgradeneeded = () => {
        for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s)
      }
      open.onsuccess = () => {
        const db = open.result
        // another tab deleting the database (sign-out there): let it, and reopen next time
        db.onversionchange = () => {
          db.close()
          this.dbp = null
        }
        resolve(db)
      }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error('The offline store is busy in another tab.'))
    })
    return this.dbp
  }
  private async tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db()
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode)
      const r = fn(t.objectStore(store))
      let out: T
      r.onsuccess = () => {
        out = r.result
      }
      // resolve on commit: the write is durable when we return
      t.oncomplete = () => resolve(out)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error('The offline store write was aborted (storage full?).'))
    })
  }
  async get<T>(store: StoreName, key: string) {
    return (await this.tx(store, 'readonly', (s) => s.get(key))) as T | undefined
  }
  async put(store: StoreName, key: string, value: unknown) {
    await this.tx(store, 'readwrite', (s) => s.put(value, key))
  }
  async delete(store: StoreName, key: string) {
    await this.tx(store, 'readwrite', (s) => s.delete(key))
  }
  async entries<T>(store: StoreName) {
    const db = await this.db()
    return new Promise<Array<[string, T]>>((resolve, reject) => {
      const t = db.transaction(store, 'readonly')
      const s = t.objectStore(store)
      const keys = req(s.getAllKeys())
      const values = req(s.getAll())
      Promise.all([keys, values]).then(([k, v]) => resolve(k.map((key, i) => [String(key), v[i] as T])), reject)
    })
  }
  async clear(store?: StoreName) {
    for (const s of store ? [store] : STORES) await this.tx(s, 'readwrite', (o) => o.clear())
  }
  async destroy() {
    try {
      const db = await this.dbp
      db?.close()
    } catch {
      /* not open */
    }
    this.dbp = null
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(this.name)
      r.onsuccess = r.onerror = r.onblocked = () => resolve()
    })
  }
}

export function openKV(userId: string): KV {
  return typeof indexedDB !== 'undefined' ? new IndexedKV(dbNameFor(userId)) : new MemoryKV()
}
