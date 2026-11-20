/**
 * Tiny hash router. Routes are plain ASCII names with hyphens (safe for sandboxed hosts):
 *   #home  #apps  #tables  #datafiles  #table-<tableId>  #roles  #solutions  #solution-<id>  #connections  #datamodel
 *   #flows  #flow-<flowId>   Flows (P1): the list, one flow
 *   #printtemplates  #printtemplate-<id>   Print templates (P2-B): the list, the designer
 *   #templates        the templates catalogue (P2-D); #studio-<appId>?template=<id> opens the Studio with that template's use dialog
 *   #studio-<appId>   the editor
 *   #run-<appId>      the running app (debug window / player, standalone window)
 *   #u                User mode: the app launcher ("My apps")
 *   #u-<appId>        User mode with that app open as a tab
 *   #u-kiosk?t=<token> the dashboard TV / kiosk page (a view token; App.tsx shows it without the platform or a session)
 *   #soon-<key>       placeholder page of a planned module (src/portal/modules.ts), in the current mode
 *   #settings         the user's Settings page (full window, in the current mode); #settings-<section> opens a section
 *   #admin            the Admin console (Dev mode, administrators); #admin-<section> opens a section
 *   #chat             the chat panel in its own window (pop-out)
 * Every other page is Dev mode (the maker portal).
 */
import { useSyncExternalStore } from 'react'

export type Route =
  | { page: 'home' | 'apps' | 'tables' | 'roles' | 'solutions' | 'connections' | 'datafiles' | 'u' | 'chat' | 'settings' | 'admin' | 'datamodel' | 'reports' | 'flows' | 'printtemplates' | 'templates' }
  | { page: 'table' | 'solution' | 'studio' | 'run' | 'u' | 'soon' | 'settings' | 'admin' | 'flow' | 'printtemplate'; id: string }

const SIMPLE = ['home', 'apps', 'tables', 'roles', 'solutions', 'connections', 'datafiles', 'u', 'chat', 'settings', 'admin', 'datamodel', 'reports', 'flows', 'printtemplates', 'templates'] as const
const WITH_ID = ['table', 'solution', 'studio', 'run', 'u', 'soon', 'settings', 'admin', 'flow', 'printtemplate'] as const

export function parseRoute(hash: string): Route {
  // a query after the route (#u-<appId>?record=<id>) is for the app (Param("record")), not part of the id
  const h = hash.replace(/^#/, '').replace(/\?.*$/, '')
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
