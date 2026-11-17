/**
 * Platform entry point: the workspace singleton and the React hook.
 *
 * `platform` is a stable facade. On init() it probes GET /api/v1/status (800 ms): an answer with
 * `app === 'appbuilder'` selects RemotePlatform (server mode: real login, MySQL, server-enforced security);
 * anything else selects the browser-only demo core (IndexedDB, simulated security). After init,
 * `platform.getState().mode` says which one is active ('server' | 'demo').
 */
import { useRef, useSyncExternalStore } from 'react'
import { createPlatform } from './core'
import { createRemotePlatform } from './remote'
import { BrowserStorage, MemoryStorage } from './storage'
import { PlatformError } from './contracts'
import type { PlatformApi, StorageAdapter, UserDef, WorkspaceState } from './contracts'

export * from './contracts'
export { createPlatform } from './core'
export { createRemotePlatform } from './remote'
export { LocalFolderStorage, BrowserStorage, MemoryStorage, selectStorage } from './storage'

/* ------------------------------------------------------------------ mode probe */

export type PlatformMode = 'server' | 'demo'

/** Ask the server whether it is an Appbuilder backend. Never throws. */
export async function probeServer(timeoutMs = 800, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    const f = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined)
    const loc = (globalThis as { location?: Location }).location
    if (!f || (!fetchImpl && !(loc && /^https?:$/.test(loc.protocol)))) return false
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = await Promise.race([
        f('/api/v1/status', { signal: ctl?.signal, cache: 'no-store', credentials: 'same-origin' }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl?.abort()
            reject(new Error('timeout'))
          }, timeoutMs)
        }),
      ])
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return false
      const body = (await res.json()) as { app?: unknown }
      return body?.app === 'appbuilder'
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ facade */

const demoStorage = async (): Promise<StorageAdapter> => {
  try {
    return new BrowserStorage()
  } catch {
    return new MemoryStorage()
  }
}

const NOT_READY: WorkspaceState = {
  ready: false, mode: 'demo', setup: { needsDatabase: false, needsAdmin: false }, session: null,
  storage: { kind: 'browser', location: 'Loading…' },
  apps: [], tables: [], roles: [], users: [], currentUserId: '', connections: [], solutions: [], dataFiles: [],
  dataVersion: 0, loading: [], truncated: [],
}
const NOBODY: UserDef = { id: '', name: '', email: '', roleIds: [] }

/**
 * Build the facade. `makeDemo` / `makeRemote` / `probe` are injectable for tests. Before init() chooses a
 * backend only getState, subscribe, onDataError and a few harmless reads work; async methods wait for init.
 */
export function createPlatformFacade(deps: {
  probe?: () => Promise<boolean>
  makeDemo?: () => PlatformApi
  makeRemote?: () => PlatformApi
} = {}): PlatformApi {
  const probe = deps.probe ?? (() => probeServer(800))
  const makeDemo = deps.makeDemo ?? (() => createPlatform(demoStorage))
  const makeRemote = deps.makeRemote ?? (() => createRemotePlatform())

  let impl: PlatformApi | null = null
  let choosing: Promise<PlatformApi> | null = null
  let initPromise: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const errorListeners = new Set<(e: Parameters<Parameters<PlatformApi['onDataError']>[0]>[0]) => void>()
  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch (e) {
        console.error('[platform] listener failed', e)
      }
    }
  }

  function choose(): Promise<PlatformApi> {
    if (!choosing) {
      choosing = (async () => {
        const server = await probe()
        const p = server ? makeRemote() : makeDemo()
        p.subscribe(notify)
        p.onDataError((e) => {
          for (const l of [...errorListeners]) l(e)
        })
        impl = p
        notify()
        return p
      })()
    }
    return choosing
  }

  const notInit = (what: string): never => {
    throw new PlatformError('unavailable', `platform.${what} was called before platform.init() finished.`)
  }

  /** a group of methods: forwards to the chosen backend; before that, `wait` methods await init, `safe` return a fallback */
  function group<G extends object>(name: keyof PlatformApi, wait: string[], safe: Record<string, (...a: never[]) => unknown>): G {
    return new Proxy({} as G, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined
        if (impl) {
          const target = (impl[name] as unknown) as Record<string, unknown>
          const v = target[prop]
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        }
        if (prop in safe) return safe[prop]
        if (wait.includes(prop)) {
          return async (...args: unknown[]) => {
            const p = await choose()
            await p.init()
            const target = (p[name] as unknown) as Record<string, (...a: unknown[]) => unknown>
            return target[prop](...args)
          }
        }
        return (..._a: unknown[]) => notInit(`${String(name)}.${prop}`)
      },
    })
  }

  const facade: PlatformApi = {
    init() {
      if (!initPromise) {
        initPromise = choose().then((p) => p.init()).catch((e) => {
          // a failed init (server unreachable mid-start) may be retried
          initPromise = null
          choosing = null
          impl = null
          throw e
        })
      }
      return initPromise
    },
    getState: () => (impl ? impl.getState() : NOT_READY),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onDataError(listener) {
      errorListeners.add(listener)
      return () => {
        errorListeners.delete(listener)
      }
    },
    apps: group('apps', ['create', 'load', 'save', 'rename', 'duplicate', 'remove', 'exportPackage', 'importPackage'], {}),
    tables: group('tables', ['create', 'remove', 'addColumn', 'updateColumn', 'removeColumn', 'reload', 'importCsv', 'createFromCsv', 'flush', 'ensureLoaded', 'listSourceTables', 'linkSourceTable', 'moveToConnection'], {
      get: () => undefined,
      rows: () => [],
      exportCsv: () => '',
    }),
    auth: group('auth', ['login', 'logout', 'changePassword', 'setupDatabase', 'setupAdmin'], {}),
    attachments: group('attachments', ['upload', 'resolve', 'remove'], { url: ((id: string) => `/api/v1/attachments/${encodeURIComponent(id)}`) as (...a: never[]) => unknown }),
    files: group('files', ['add', 'replace', 'download', 'remove'], {}),
    security: group('security', ['createRole', 'updateRole', 'removeRole', 'createUser', 'updateUser', 'removeUser', 'setPassword'], {
      currentUser: () => NOBODY,
      can: () => false,
      canRunApp: () => false,
    }),
    connections: group('connections', ['create', 'update', 'remove', 'test', 'setDefault'], {}),
    solutions: group('solutions', ['create', 'update', 'remove', 'addComponent', 'removeComponent', 'exportPackage', 'importPackage'], {}),
  }
  return facade
}

export const platform: PlatformApi = createPlatformFacade()

/* ------------------------------------------------------------------ React hook */

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Date || b instanceof Date) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => Object.is(x, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * Subscribe a component to a slice of the workspace state. The selector may return a new array or
 * object each time (it is compared shallowly), and may be an inline function.
 */
export function usePlatform<T>(selector: (s: WorkspaceState) => T): T {
  const cache = useRef<{ state: WorkspaceState; selector: (s: WorkspaceState) => T; value: T } | null>(null)
  const getSnapshot = (): T => {
    const s = platform.getState()
    const c = cache.current
    if (c && c.state === s && c.selector === selector) return c.value
    let value = selector(s)
    if (c && shallowEqual(c.value, value)) value = c.value
    cache.current = { state: s, selector, value }
    return value
  }
  return useSyncExternalStore(platform.subscribe, getSnapshot, getSnapshot)
}
