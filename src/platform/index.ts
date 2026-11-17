/**
 * Platform entry point: the workspace singleton and the React hook.
 * The storage backend is chosen at init(): local folder server when /api/fs/health answers within
 * 800 ms on an http(s) origin, else browser storage (IndexedDB, in-memory fallback).
 */
import { useRef, useSyncExternalStore } from 'react'
import { createPlatform } from './core'
import { selectStorage } from './storage'
import type { PlatformApi, WorkspaceState } from './contracts'

export * from './contracts'
export { createPlatform } from './core'
export { LocalFolderStorage, BrowserStorage, MemoryStorage, selectStorage } from './storage'

export const platform: PlatformApi = createPlatform(() => selectStorage(800))

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
