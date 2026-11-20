/**
 * Opens the app (and screen) a tile drills through to (P2-C, P3-D). The address is built by src/dashboards/drill.ts
 * (`#u-<appId>?screen=<name>&name=value`); the app reads the values with Param("name") and opens on the named screen
 * (src/runtime/startparams.ts, applied by RunApp.tsx). Returns a message in plain words when it cannot open (the app is
 * gone, or the user may not run it: the server enforces that anyway), otherwise null.
 *
 * An app that is already open in a tab is NOT closed and reopened any more: its address changes and the running app
 * reads the new address (it starts again when values are passed, so its start formulas see them, and opens the screen).
 * When the address is exactly the one in the address bar no `hashchange` would fire, so the bar is first reset to the
 * plain app address (no history entry) and then set again.
 */
import { platform } from '@/platform'
import type { TileDrill } from '@/dashboards/types'
import { drillHash } from '@/dashboards/drill'
import { canRun, useWorkspace } from '../workspace'

export function openDrill(drill: TileDrill, row?: Record<string, unknown>): string | null {
  const app = platform.getState().apps.find((a) => a.id === drill.appId)
  if (!app) return 'The app this tile opens no longer exists.'
  if (!canRun(app.id)) return `You do not have access to ${app.name}.`
  const hash = drillHash(drill, row)
  useWorkspace.getState().openTab(app.id)
  if (location.hash === hash) {
    try { history.replaceState(null, '', `${location.pathname}${location.search}#u-${app.id}`) } catch { /* not allowed here: the app stays as it is */ }
  }
  location.hash = hash
  return null
}
