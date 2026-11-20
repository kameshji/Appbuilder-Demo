/**
 * Rule 8 of master-plan 11.3: a template cannot bring connection secrets, users, or anything that runs as the system
 * without an explicit administrator approval step. Pure; the server runs it on every package it plans or installs.
 *
 *   - secrets (password, secret, apiKey, token, privateKey, clientSecret, connectionString ... with a value) anywhere in
 *     the package: STRIPPED, with a visible warning (a template never carries one; connections are made here);
 *   - users and people (users, members, userIds, people, assignees, owners lists), and connections: STRIPPED, with a warning;
 *   - payload parts the kind does not use (flows, connections, events at the top ...): STRIPPED, with a warning;
 *   - roles: never the administrator flag (stripped, warning);
 *   - table events that run as the system: kept, listed in `systemItems`: only an administrator can install them, and
 *     only after ticking the approval on the plan screen (recorded in the audit log).
 */
import type { TemplatePackage } from './format.ts'

const SECRET_KEY = /^(password|passwd|pwd|secret|secrets|apikey|api_key|apisecret|token|accesstoken|refreshtoken|privatekey|private_key|clientsecret|client_secret|connectionstring|secret_sealed|secretsealed)$/i
const PEOPLE_KEY = /^(users|members|userids|people|assignees|owners|accounts|emails)$/i
const ALLOWED_PAYLOAD: Record<TemplatePackage['kind'], string[]> = {
  component: ['controls'],
  screen: ['screen'],
  app: ['app', 'roles'],
  dataModel: ['sample'],
}

export interface SafetyResult {
  /** the package with what may not be installed removed */
  pkg: TemplatePackage
  /** what was removed, in words (shown on the plan screen) */
  stripped: string[]
  /** what runs as the system (an administrator must approve it) */
  systemItems: string[]
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function checkSafety(input: TemplatePackage): SafetyResult {
  const pkg = clone(input)
  const stripped: string[] = []
  const systemItems: string[] = []
  // payload parts the kind does not use
  for (const k of Object.keys(pkg.payload ?? {})) {
    if (ALLOWED_PAYLOAD[pkg.kind].includes(k)) continue
    const what = /^connections?$/i.test(k) ? 'connections (they are made in each environment, with their own secrets)' : PEOPLE_KEY.test(k) ? 'users and people (they are never part of a template)' : `"${k}" (not part of a ${pkg.kind} template)`
    stripped.push(`Removed from the template: ${what}.`)
    delete pkg.payload[k]
  }
  // secrets and people anywhere (the signature is not content)
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    for (const k of Object.keys(o)) {
      const val = o[k]
      // a formula (UI component property) is code, not a stored value: its properties may be called Password
      const formula = typeof val === 'string' && val.trimStart().startsWith('=')
      if (SECRET_KEY.test(k) && !formula && val !== null && val !== '' && val !== undefined && typeof val !== 'boolean') {
        stripped.push(`Removed a secret from the template (${path}.${k}): templates never carry passwords or keys.`)
        delete o[k]
        continue
      }
      if (PEOPLE_KEY.test(k) && (Array.isArray(val) || (val && typeof val === 'object'))) {
        stripped.push(`Removed people from the template (${path}.${k}): users are never part of a template.`)
        delete o[k]
        continue
      }
      walk(val, `${path}.${k}`)
    }
  }
  const { signature, ...content } = pkg
  walk(content, 'template')
  Object.assign(pkg, content, signature ? { signature } : {})
  // roles: never the administrator flag
  for (const r of pkg.payload.roles ?? []) {
    const x = r as unknown as Record<string, unknown>
    if (x.isAdmin) { stripped.push(`The administrator flag of the role "${r.name}" was removed.`); delete x.isAdmin }
  }
  // events that run as the system: approval needed
  for (const s of pkg.slots) for (const e of s.events ?? []) if (e.runAs === 'system') systemItems.push(`${s.label}: ${e.name ?? 'event'}`)
  return { pkg, stripped: [...new Set(stripped)], systemItems }
}
