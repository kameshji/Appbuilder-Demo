/**
 * Tiny hash router. Routes are plain ASCII names with hyphens (safe for sandboxed hosts):
 *   #home  #apps  #tables  #table-<tableId>  #roles  #solutions  #solution-<id>  #connections
 *   #studio-<appId>   the editor
 *   #run-<appId>      the running app (debug window / player)
 */
import { useSyncExternalStore } from 'react'

export type Route =
  | { page: 'home' | 'apps' | 'tables' | 'roles' | 'solutions' | 'connections' }
  | { page: 'table' | 'solution' | 'studio' | 'run'; id: string }

const SIMPLE = ['home', 'apps', 'tables', 'roles', 'solutions', 'connections'] as const
const WITH_ID = ['table', 'solution', 'studio', 'run'] as const

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  for (const p of WITH_ID) if (h.startsWith(p + '-') && h.length > p.length + 1) return { page: p, id: h.slice(p.length + 1) }
  for (const p of SIMPLE) if (h === p) return { page: p }
  return { page: 'home' }
}
export function routeToHash(r: Route): string {
  return '#' + ('id' in r ? `${r.page}-${r.id}` : r.page)
}
export function go(r: Route) {
  const h = routeToHash(r)
  if (location.hash !== h) location.hash = h
}
let cachedHash = ''
let cached: Route = { page: 'home' }
function snapshot(): Route {
  if (location.hash !== cachedHash) { cachedHash = location.hash; cached = parseRoute(cachedHash) }
  return cached
}
function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot)
}
