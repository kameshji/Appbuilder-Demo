/**
 * Opens the app a tile drills through to (P2-C). The address is built by src/dashboards/drill.ts (`#u-<appId>?name=value`,
 * read by the app with Param("name")). Returns a message in plain words when it cannot open (the app is gone, or the user may
 * not run it: the server enforces that anyway), otherwise null. An app that is already open in a tab is closed and opened again
 * when values are passed, because an app reads its parameters when it starts.
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
  const open = () => { useWorkspace.getState().openTab(app.id); location.hash = hash }
  if (hash.includes('?') && useWorkspace.getState().tabs.includes(app.id)) {
    useWorkspace.getState().closeTab(app.id)
    setTimeout(open, 0)
  } else open()
  return null
}
