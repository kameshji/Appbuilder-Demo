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
  solution: ['apps', 'roles', 'flows', 'approvalPolicies', 'dashboards', 'printTemplates', 'sequences', 'reference', 'sample'],
}
/** payload parts whose keys are slot ids (a slot may be called Accounts): their rows are checked, not their keys */
const ROWS_BY_SLOT = new Set(['sample', 'reference'])

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
      // a role's privileges are keyed by slot ids (a slot may be called Accounts): not people
      if (PEOPLE_KEY.test(k) && !/\.roles\[\d+\]\.tables$/.test(path) && (Array.isArray(val) || (val && typeof val === 'object'))) {
        stripped.push(`Removed people from the template (${path}.${k}): users are never part of a template.`)
        delete o[k]
        continue
      }
      walk(val, `${path}.${k}`)
    }
  }
  const { signature, ...content } = pkg
  const { payload, ...head } = content
  walk(head, 'template')
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (ROWS_BY_SLOT.has(k) && v && typeof v === 'object' && !Array.isArray(v)) for (const [slot, rows] of Object.entries(v as Record<string, unknown>)) walk(rows, `template.payload.${k}.${slot}`)
    else walk(v, `template.payload.${k}`)
  }
  Object.assign(pkg, head, { payload }, signature ? { signature } : {})
  // roles: never the administrator flag
  for (const r of pkg.payload.roles ?? []) {
    const x = r as unknown as Record<string, unknown>
    if (x.isAdmin) { stripped.push(`The administrator flag of the role "${r.name}" was removed.`); delete x.isAdmin }
  }
  // format 2 packs: no people in approval policies (user:<email or id> approvers), flows never run as a service account
  // and carry no connection references (connections are made in each environment)
  if (pkg.kind === 'solution') {
    const isPerson = (ref: unknown): boolean => typeof ref === 'string' && (/^user:/i.test(ref.trim()) || (!/^[a-z-]+:/i.test(ref.trim()) && ref.includes('@')))
    const clean = (list: unknown, where: string): unknown => {
      if (!Array.isArray(list)) return list
      const kept = list.filter((x) => !isPerson(x))
      if (kept.length !== list.length) stripped.push(`Removed people from the template (${where}): approvers are roles, teams, departments or managers, never named people.`)
      return kept
    }
    for (const a of pkg.payload.approvalPolicies ?? []) {
      const d = a.definition as Record<string, unknown>
      if (!d || typeof d !== 'object') continue
      d.approvers = clean(d.approvers, `approval policy ${a.key}`)
      for (const st of Array.isArray(d.stages) ? d.stages as Record<string, unknown>[] : []) st.approvers = clean(st.approvers, `approval policy ${a.key}`)
      for (const ru of Array.isArray(d.rules) ? d.rules as Record<string, unknown>[] : []) ru.approvers = clean(ru.approvers, `approval policy ${a.key}`)
      const esc = d.escalation as Record<string, unknown> | undefined
      if (esc && isPerson(esc.to)) { delete esc.to; stripped.push(`Removed a person from the template (approval policy ${a.key} escalation).`) }
    }
    for (const f of pkg.payload.flows ?? []) {
      const x = f as unknown as Record<string, unknown>
      if (x.runAs !== undefined && x.runAs !== 'owner' && x.runAs !== 'triggeringUser') { stripped.push(`The flow "${f.name}" ran as a service account: here it runs as its owner (the administrator who installs it).`); delete x.runAs }
      if (x.connections !== undefined) { stripped.push(`Removed connection references from the flow "${f.name}" (connections are made in each environment).`); delete x.connections }
    }
  }
  // events that run as the system: approval needed
  for (const s of pkg.slots) for (const e of s.events ?? []) if (e.runAs === 'system') systemItems.push(`${s.label}: ${e.name ?? 'event'}`)
  return { pkg, stripped: [...new Set(stripped)], systemItems }
}
