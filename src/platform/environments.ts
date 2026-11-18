/**
 * Environment selection shared by both backends. Server mode: the environments the user may enter come from the server
 * (GET /api/v1/environments, also in the workspace payload); the selected one is sent with every request (header
 * X-Appbuilder-Environment, see src/platform/http.ts) and remembered on the user record (POST .../select) and, as a
 * fallback, in this browser (`appbuilder-environment:<userId>`, every access in try/catch). Demo mode: one built-in
 * "Default" environment.
 */
import { PlatformError, type EnvironmentDef } from './contracts'
import { ENVIRONMENT_HEADER, ENVIRONMENT_QUERY } from './http'

export const DEFAULT_ENVIRONMENT_ID = 'default'
const KEY = 'appbuilder-environment'

export const ENVIRONMENT_TYPE_LABEL: Record<EnvironmentDef['type'], string> = {
  production: 'Production',
  sandbox: 'Sandbox',
  developer: 'Developer',
}

export function readSelectedEnvironment(userId: string): string | null {
  if (!userId) return null
  try {
    const v = localStorage.getItem(`${KEY}:${userId}`)
    return v && v.length <= 64 ? v : null
  } catch {
    return null
  }
}

export function writeSelectedEnvironment(userId: string, id: string): void {
  if (!userId) return
  try {
    localStorage.setItem(`${KEY}:${userId}`, id)
  } catch {
    /* storage refused: the choice lasts for this page only */
  }
}

/**
 * the environment to show: the one this browser selected when it still exists, else the server's choice for the
 * session (the user's last environment), else the built-in, else the first
 */
export function pickEnvironment(list: EnvironmentDef[], saved: string | null, server?: string | null): EnvironmentDef | null {
  return list.find((e) => e.id === saved) ?? list.find((e) => e.id === server) ?? list.find((e) => e.builtIn) ?? list[0] ?? null
}

/** select(id) for both backends: validates against the list and remembers the choice */
export function selectEnvironment(list: EnvironmentDef[], id: string, userId: string): EnvironmentDef {
  const env = list.find((e) => e.id === id)
  if (!env) throw new PlatformError('not-found', `There is no environment "${id}".`)
  writeSelectedEnvironment(userId, env.id)
  return env
}

/* ------------------------------------------------------------------ the environment of every request */

let requestEnvironment = ''

/** the environment requests go to (set by the remote platform when the workspace loads or the user switches) */
export function setRequestEnvironment(id: string): void {
  requestEnvironment = id
}
export function getRequestEnvironment(): string {
  return requestEnvironment
}

/** headers naming the current environment (empty before one is known: the server then uses the user's last one) */
export function environmentHeaders(): Record<string, string> {
  return requestEnvironment ? { [ENVIRONMENT_HEADER]: requestEnvironment } : {}
}

/** a GET link (attachments in <img src>) that names the current environment */
export function withEnvironment(url: string, id: string = requestEnvironment): string {
  if (!id || url.includes(`${ENVIRONMENT_QUERY}=`)) return url
  return `${url}${url.includes('?') ? '&' : '?'}${ENVIRONMENT_QUERY}=${encodeURIComponent(id)}`
}
