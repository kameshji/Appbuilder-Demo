/**
 * Environment selection shared by both backends. Environments are a real API with, today, exactly one built-in
 * environment per install ("Default", type production; see docs/plan/master-plan.md, P0). The id the user picked is
 * remembered per user in this browser (`appbuilder-environment:<userId>`, every access in try/catch), so the picker
 * keeps working unchanged when the server starts to return more than one.
 */
import { PlatformError, type EnvironmentDef } from './contracts'

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

/** the environment to show: the saved one when it still exists, else the built-in, else the first */
export function pickEnvironment(list: EnvironmentDef[], saved: string | null): EnvironmentDef | null {
  return list.find((e) => e.id === saved) ?? list.find((e) => e.builtIn) ?? list[0] ?? null
}

/** select(id) for both backends: validates against the list and remembers the choice */
export function selectEnvironment(list: EnvironmentDef[], id: string, userId: string): EnvironmentDef {
  const env = list.find((e) => e.id === id)
  if (!env) throw new PlatformError('not-found', `There is no environment "${id}".`)
  writeSelectedEnvironment(userId, env.id)
  return env
}
