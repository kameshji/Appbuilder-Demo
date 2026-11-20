/**
 * How an app starts from an address (P3-D), pure: no React, no DOM, no store. The only start-parameter mechanism is the
 * address fragment `#u-<appId>?name=value` (Param("name") reads it: src/runtime/evaluator.ts). One parameter has a meaning
 * of its own: `screen`, the NAME of the screen to open first (`#u-<appId>?screen=Machine+detail&Machine=Press+1`); an id
 * of a screen works too. `RunApp.tsx` uses `startPlan` when an app finishes loading (the address it was opened with) and
 * whenever the address changes while the app is open (a drill-through from a dashboard into an app that is already open).
 */
import { DRILL_SCREEN_PARAM } from '../dashboards/types.ts'

export const START_SCREEN_PARAM = DRILL_SCREEN_PARAM

export interface StartAddress {
  page: 'u' | 'run'
  appId: string
  /** the screen asked for, or null */
  screen: string | null
  /** the other parameters, in address order (what Param("name") sees) */
  params: [string, string][]
}

/** `#u-<appId>?...` or `#run-<appId>?...` -> its parts; null for any other address (and for the kiosk page, which is not an app) */
export function parseStartHash(hash: string): StartAddress | null {
  const m = /^#(u|run)-([A-Za-z0-9_-]{1,80})(?:\?(.*))?$/.exec(hash)
  if (!m || m[2] === 'kiosk') return null
  let q: URLSearchParams
  try { q = new URLSearchParams(m[3] ?? '') } catch { return null }
  let screen: string | null = null
  const params: [string, string][] = []
  for (const [k, v] of q) {
    if (k === START_SCREEN_PARAM) { if (screen === null && v.trim()) screen = v.trim() }
    else params.push([k, v])
  }
  return { page: m[1] as 'u' | 'run', appId: m[2]!, screen, params }
}

/** the id of the screen a request names: an id, else a name (exactly, else ignoring case and surrounding blanks); null when there is none */
export function findStartScreen(screens: { id: string; name: string }[], requested: string | null): string | null {
  if (!requested) return null
  const r = requested.trim()
  if (!r) return null
  const byId = screens.find((s) => s.id === r)
  if (byId) return byId.id
  const exact = screens.find((s) => s.name === r)
  if (exact) return exact.id
  const lower = r.toLocaleLowerCase()
  return screens.find((s) => s.name.trim().toLocaleLowerCase() === lower)?.id ?? null
}

export interface StartPlan {
  /** run the app's start again (its OnStart reads Param(...) again) before opening the screen */
  restart: boolean
  /** the screen to open on top of the current one, or null to leave the app where it is */
  open: string | null
  /** the screen that was asked for but does not exist (the start screen shows instead) */
  unknown: string | null
}

/**
 * What an address means for the app `appId` that is open now.
 * - an address of another app, or one without any parameter: nothing (switching tabs must not restart anything);
 * - values passed (anything besides `screen`) and `fresh` false (the app was already running): start again so the start
 *   formulas read the new values; at app load (`fresh` true) the start has just run and is not repeated;
 * - `screen` known: open it, unless it is already the current screen; unknown: stay on the start screen and say so.
 */
export function startPlan(hash: string, appId: string, screens: { id: string; name: string }[], current: string | undefined, fresh: boolean): StartPlan {
  const a = parseStartHash(hash)
  if (!a || a.appId !== appId || (a.screen === null && a.params.length === 0)) return { restart: false, open: null, unknown: null }
  const restart = !fresh && a.params.length > 0
  if (a.screen === null) return { restart, open: null, unknown: null }
  const id = findStartScreen(screens, a.screen)
  // after a restart the app is on its first screen, whatever it showed before
  const here = restart ? screens[0]?.id : current
  // an unknown screen opens the start screen (when the open app is somewhere else, it goes back there)
  if (id === null) return { restart, open: screens[0] && here !== screens[0].id ? screens[0].id : null, unknown: a.screen }
  return { restart, open: id === here ? null : id, unknown: null }
}
