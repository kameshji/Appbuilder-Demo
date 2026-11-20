/**
 * Who may open a dashboard (P2-C), pure: no React, DOM or packages; shared-code rules. The server decides
 * (server/core/dashboards/routes.ts `canView`): the owner, makers, administrators and every user holding a role listed
 * on the dashboard. This file only prepares the list and says it in plain words for the editor.
 */

export interface ViewerRole { id: string; name: string; isAdmin?: boolean; isMaker?: boolean }

/** administrators and makers open every dashboard whatever is listed (so listing them changes nothing) */
export const alwaysSees = (r: ViewerRole): boolean => !!(r.isAdmin || r.isMaker)

/** the listed role ids that exist, once each, in the order of `roles` (what is sent to the server, which refuses unknown ids) */
export function cleanRoles(ids: string[], roles: ViewerRole[]): string[] {
  const want = new Set(ids)
  return roles.filter((r) => want.has(r.id)).map((r) => r.id)
}

export function toggleRole(ids: string[], id: string, on: boolean): string[] {
  const rest = ids.filter((x) => x !== id)
  return on ? [...rest, id] : rest
}

const list = (names: string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** how many listed ids are not (any more) roles of this environment */
export const missingRoles = (ids: string[], roles: ViewerRole[]): number => ids.filter((id) => !roles.some((r) => r.id === id)).length

/** who can see the dashboard, in a sentence. Roles of makers and administrators are left out: they see it anyway. */
export function viewerSummary(ids: string[], roles: ViewerRole[]): string {
  const extra = roles.filter((r) => ids.includes(r.id) && !alwaysSees(r)).map((r) => r.name)
  if (!extra.length) return 'Only the owner, makers and administrators can see this dashboard.'
  return `The owner, makers and administrators, and people with the ${extra.length === 1 ? 'role' : 'roles'} ${list(extra)}, can see this dashboard.`
}

/** the reminder shown under the sentence */
export const VIEWER_NOTE = 'What each person sees on it still depends on their own access to the data: nobody sees rows or columns they could not open elsewhere.'
