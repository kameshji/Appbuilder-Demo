/**
 * TEMPLATE PACKAGES (P2 package D, master-plan 11.3; docs/dev/templates.md). Shared by the browser and the server like
 * src/model: relative `.ts` imports, erasable TypeScript, no React, DOM or packages; types only from src/platform.
 *
 * A template package is one JSON document (`format: "appbuilder/template"`, `formatVersion: 1`):
 *   kind         component (single or composite UI component) | screen | app | dataModel
 *   slots        the tables (and their columns, with the types they accept and whether they are required) the template
 *                needs. The binding step maps each slot to an existing table and its columns, or creates the table.
 *   payload      component: { controls }  screen: { screen }  app: { app, roles? }  dataModel: { } (its tables ARE its
 *                slots, created by default) ; optional `sample` rows (data models only, clearly labelled SAMPLE)
 *   signature    { alg: 'sha256', digest } over the canonical JSON of the package without `signature`; built-in packages
 *                are also listed in the built-in manifest (server/core/templates/builtin/manifest.json); optionally
 *                `ed25519: { keyId, signature }` over the digest, checked against the release keys.
 *
 * Formulas inside a template never name a table or column directly: they use SLOT TOKENS, `Slot_<slot>` for the table
 * and `Slot_<slot>_<column>` for a column (as identifiers, member names, record field names, or the whole of a text value
 * such as a Form's DataSource or a comma list such as Fields). Binding rewrites them through the formula parser
 * (rewrite.ts), never by text replacement.
 *
 * FORMAT VERSION 2 (P3 package M1, docs/dev/solution-templates.md) adds the kind `solution` (a pack: tables, apps for
 * desktop and phone, flows, approval policies, dashboards, print templates, roles with row rules, number sequences,
 * reference rows, SAMPLE rows, dependencies on other packs) and COMPONENT TOKENS for what a pack creates:
 * `Slot_App_<key>`, `Slot_Role_<key>`, `Slot_Flow_<key>`, `Slot_Policy_<key>`, `Slot_Dashboard_<key>`, `Slot_Print_<key>`
 * (each becomes the id the component gets here) and `Slot_Seq_<key>` (the number sequence's name here). Version 1
 * packages stay valid.
 */
import type { AppDef, ControlNode } from '../contracts.ts'
import type { AccessScope, BalanceDef, ColumnDef, ColumnType } from '../platform/contracts.ts'
import type { TableEventInput } from '../platform/events.ts'
import type { DeleteBehaviour } from '../model/types.ts'
import { IDENT, SYSTEM_COLUMN_NAMES } from '../model/names.ts'

export const TEMPLATE_FORMAT = 'appbuilder/template'
/** the newest package format this Appbuilder reads (1 stays valid) */
export const TEMPLATE_FORMAT_VERSION = 2
export const TEMPLATE_FORMAT_VERSIONS: readonly number[] = [1, 2]
export const SLOT_PREFIX = 'Slot_'
export const TEMPLATE_KINDS = ['component', 'screen', 'app', 'dataModel', 'solution'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export type TemplateMode = 'copy' | 'linked'

export const KIND_LABEL: Record<TemplateKind, string> = { component: 'UI component', screen: 'Screen', app: 'App', dataModel: 'Data model', solution: 'Solution' }
/** Linked (versioned, upgrade in place) is implemented for these kinds only; the others are Copy only */
export const LINKED_KINDS: readonly TemplateKind[] = ['app', 'dataModel', 'solution']

/** component tokens of a solution pack: Slot_<word>_<key> (format.ts header) */
export const COMPONENT_TOKEN_WORDS = { app: 'App', role: 'Role', flow: 'Flow', policy: 'Policy', dashboard: 'Dashboard', print: 'Print', sequence: 'Seq' } as const
export type PackComponentKind = keyof typeof COMPONENT_TOKEN_WORDS
export const componentToken = (kind: PackComponentKind, key: string): string => `${SLOT_PREFIX}${COMPONENT_TOKEN_WORDS[kind]}_${key}`
/** slot ids a solution pack may not use (they would read like component tokens) */
const RESERVED_SLOTS = new Set(Object.values(COMPONENT_TOKEN_WORDS).map((w) => w.toLowerCase()))

const COLUMN_TYPES: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file']

/** one column a slot needs */
export interface SlotColumn {
  /** identifier; the column's name when the table is created; token Slot_<slot>_<id> */
  id: string
  label: string
  description?: string
  /** the column types it accepts when mapped to an existing column (the first is used when the table is created) */
  types: ColumnType[]
  required: boolean
  /** lookup columns: the slot whose table it must point at */
  lookupSlot?: string
  /** format 2: lookup columns to a table of the core data model (Users, Teams, Currencies ...), by its name */
  lookupSystem?: string
  /** when the table is created: the column's settings (type defaults to types[0]); a default starting with = is a formula (tokens allowed) */
  create?: Partial<Pick<ColumnDef, 'displayName' | 'required' | 'unique' | 'indexed' | 'default' | 'choices' | 'prefix' | 'computed'>> & { type?: ColumnType; onDelete?: DeleteBehaviour }
}

export interface TemplateSlot {
  /** identifier; token Slot_<id> */
  id: string
  label: string
  description?: string
  /** false: the slot may be left out (its formulas then read Blank()) */
  required: boolean
  columns: SlotColumn[]
  /** present: the binding step may create the table (name, display name and display column it gets by default) */
  create?: { name: string; displayName: string; primaryColumn?: string; description?: string; uniqueTogether?: string[][]; balance?: BalanceDef }
  /**
   * data models: created unless the maker maps it. Solution packs: `create` (default) creates the table and a name clash
   * must be resolved; `map` uses a table of the same name when there is one (shared tables such as Accounts), else creates
   */
  defaultMode?: 'create' | 'map'
  /** validation rules and events of the table when it is created (formulas use slot tokens) */
  events?: TableEventInput[]
  /**
   * format 2, solution packs: a SHARED slot, the table of a slot of a pack this one depends on (for example the common
   * business model's Accounts). It is never created by this pack: it is mapped to the table the dependency installed
   * (or installs first, in the same transaction). Its column ids are the dependency's column ids.
   */
  from?: { template: string; slot: string }
}

/** a scope of a template role (format 1: none, own, all; format 2: every organisation scope) */
export type TemplateScope = 'none' | AccessScope

export interface TemplateRole {
  /** format 2: identifier; token Slot_Role_<key> (required in solution packs) */
  key?: string
  name: string
  description?: string
  isMaker?: boolean
  /**
   * privileges on the tables of slots: create / read / update / delete scopes; format 2 also `share`, column security
   * (`columns`: slot column id -> none / read / update) and relationship row rules (`rowFilter`, tokens allowed)
   */
  tables: Record<string, { create?: boolean; read?: TemplateScope; update?: TemplateScope; delete?: TemplateScope; share?: TemplateScope; columns?: Record<string, 'none' | 'read' | 'update'>; rowFilter?: unknown[] }>
}

/** format 2 pack components (solution kind); every key is an identifier, unique within its kind */
export interface PackApp { key: string; name: string; description?: string; /** a phone app (portrait design, usually "works offline (entry)") */ phone?: boolean; app: AppDef }
export interface PackFlow {
  key: string
  name: string
  description?: string
  /** trigger, steps, variables, settings as in docs/dev/flows.md (tokens anywhere; no connection references) */
  definition: Record<string, unknown>
  /** role tokens (Slot_Role_<key>) that may run it */
  runRoles?: string[]
}
export interface PackApprovalPolicy { key: string; name: string; description?: string; /** approvers as role:Slot_Role_<key>, manager, team: ... (never people) */ definition: Record<string, unknown> }
export interface PackDashboard { key: string; name: string; /** the dashboard definition (docs/dev/dashboards.md), tables and columns as tokens */ def: Record<string, unknown>; /** viewer roles (Slot_Role_<key>) */ roles?: string[] }
export interface PackPrintTemplate { key: string; name: string; description?: string; /** the print document (docs/dev/pdf.md), tokens in {...} */ doc: Record<string, unknown> }
export interface PackSequence { key: string; name: string; prefix?: string; suffix?: string; padding?: number; resetRule?: 'never' | 'yearly' | 'financialYear'; description?: string }
export interface TemplateDependency { /** the template id (builtin.business-model) */ id: string; /** the oldest version that works */ minVersion: string }

export type TemplateRow = Record<string, string | number | boolean | null>

export interface TemplatePayload {
  controls?: ControlNode[]
  screen?: ControlNode
  app?: AppDef
  roles?: TemplateRole[]
  /** dataModel, solution: SAMPLE rows per slot ({ _id: local id, <column id>: value; lookups name a local id }) */
  sample?: Record<string, TemplateRow[]>
  /** solution: reference rows the pack needs (stages, reasons), always loaded into tables it creates; `_id` required */
  reference?: Record<string, TemplateRow[]>
  /** solution */
  apps?: PackApp[]
  flows?: PackFlow[]
  approvalPolicies?: PackApprovalPolicy[]
  dashboards?: PackDashboard[]
  printTemplates?: PackPrintTemplate[]
  sequences?: PackSequence[]
  /** anything else is refused or stripped by the safety check (safety.ts) */
  [k: string]: unknown
}

export interface TemplateSignature {
  alg: 'sha256'
  digest: string
  ed25519?: { keyId: string; signature: string }
}

export interface TemplatePackage {
  format: typeof TEMPLATE_FORMAT
  formatVersion: 1 | 2
  /** stable id, e.g. builtin.request-tracker */
  id: string
  /** semantic version */
  version: string
  kind: TemplateKind
  name: string
  description: string
  publisher?: string
  tags?: string[]
  /** format 2: the pack's short name, put before the names of its flows, dashboards, print templates and policies ("Visitor log: Visit pass") */
  shortName?: string
  /** format 2: the prefix proposed for a table name that is taken (Vis + Visitors = VisVisitors) */
  prefix?: string
  /** format 2: packs this one needs (installed first, in the same transaction, when missing) */
  dependencies?: TemplateDependency[]
  /** the oldest Appbuilder version it runs on */
  minPlatformVersion: string
  /** what "Use" offers: copy always; linked only for LINKED_KINDS */
  modes: TemplateMode[]
  slots: TemplateSlot[]
  payload: TemplatePayload
  signature?: TemplateSignature
}

/* ------------------------------------------------------------------ binding request / plan shapes (HTTP) */

export type SlotBinding =
  | { mode: 'create'; name: string; displayName?: string }
  /** table: id (or name) of an existing table; columns: slot column id -> column name there (null / absent: not mapped) */
  | { mode: 'map'; table: string; columns?: Record<string, string | null> }
  | { mode: 'skip' }

export interface TemplateUseRequest {
  mode?: TemplateMode
  bindings?: Record<string, SlotBinding>
  /** app templates: the new app's name */
  appName?: string
  /** data models: load the SAMPLE rows */
  sample?: boolean
  /** an administrator allows what runs as the system (rule 8) */
  approveSystem?: boolean
  /** component / screen: the app open in the Studio (for the plan's words and unique names) */
  target?: { appId?: string; appName?: string; screenName?: string; takenNames?: string[] }
  /** install: the plan's token */
  confirm?: string
  proceedWithoutBackup?: boolean
}

export interface CandidateColumn { name: string; displayName: string; type: ColumnType; ok: boolean; reason?: string }

export interface SlotColumnReport {
  id: string
  label: string
  required: boolean
  types: ColumnType[]
  lookupSlot?: string
  bound: string | null
  /** why the chosen column does not fit, or that a required one is missing (words) */
  problem?: string
  candidates: CandidateColumn[]
}

export interface SlotReport {
  slot: string
  label: string
  description?: string
  required: boolean
  canCreate: boolean
  mode: SlotBinding['mode']
  /** the table bound (map) or to be created (create) */
  table?: { id?: string; name: string; displayName: string }
  /** create: a table of that name exists here; resolve it (use it, or another name) */
  clash?: { id: string; name: string; displayName: string; suggestion: string }
  /** format 2: a shared slot, bound to the table of a pack this one depends on (not editable here) */
  shared?: { template: string; templateName: string; slot: string; table: string; planned: boolean }
  columns: SlotColumnReport[]
  problems: string[]
}

/** format 2: a pack this one needs, as the plan sees it */
export interface DependencyReport {
  id: string
  name: string
  minVersion: string
  /** installed: already here (and new enough); install: installed first, in the same transaction; missing: not usable */
  action: 'installed' | 'install' | 'missing'
  version?: string
  installId?: string
  /** install: its plan (also part of this install's token) */
  plan?: import('../platform/http.ts').SolutionPlan
  slots?: SlotReport[]
  problems: string[]
}

export interface TemplateSummary {
  id: string
  version: string
  kind: TemplateKind
  name: string
  description: string
  publisher?: string
  tags: string[]
  minPlatformVersion: string
  modes: TemplateMode[]
  /** builtin: listed in the built-in manifest with a matching digest; signed: Ed25519 by a trusted key; damaged: refused */
  integrity: 'builtin' | 'signed' | 'damaged'
  integrityNote?: string
  /** the running server is older than minPlatformVersion */
  tooNew?: boolean
  /** what it contains, in words ("12 UI components", "3 tables, 2 relationships, 9 SAMPLE rows") */
  contains: string[]
  /** what it needs, in words */
  needs: string[]
}

export interface TemplateDetail extends TemplateSummary {
  slots: TemplateSlot[]
  /** the default binding for this environment (create where it can, else the same-named table) */
  defaults: Record<string, SlotBinding>
  roles: string[]
  sampleRows: number
  digest: string
  /** format 2 */
  dependencies?: { id: string; name: string; minVersion: string; installed?: string }[]
  shortName?: string
}

/** POST /templates/:id/plan */
export interface TemplatePlanResponse {
  /** the same plan shape (and screen) as a solution import */
  plan: import('../platform/http.ts').SolutionPlan
  slots: SlotReport[]
  /** the bindings the plan used (defaults filled in): send them back with the install */
  bindings: Record<string, SlotBinding>
  mode: TemplateMode
  /** app templates: the new app's name, and a free one when it is taken */
  appName?: { value: string; clash?: boolean; suggestion?: string }
  /** rule 8: what the safety check removed, and what needs an administrator's approval */
  stripped: string[]
  systemItems: string[]
  /** format 2: the packs this one needs (installed here, or installed first by this install) */
  dependencies?: DependencyReport[]
  /** format 2: what each number sequence of the pack becomes here */
  sequences?: { key: string; name: string; action: 'create' | 'reuse' | 'renamed'; note?: string }[]
}

export interface TemplateCreated {
  apps: { id: string; name: string; key?: string; phone?: boolean }[]
  tables: { id: string; name: string; slot: string }[]
  roles: { id: string; name: string; key?: string }[]
  flows: { id: string; name: string; key?: string }[]
  events: { id: string; table: string; name: string }[]
  mapped: { slot: string; table: string; name: string }[]
  sampleRows: number
  /** UI components and screens: where they went */
  target?: { appId?: string; appName?: string; screenName?: string }
  /** format 2 */
  approvalPolicies?: { id: string; name: string; key: string }[]
  dashboards?: { id: string; name: string; key: string }[]
  printTemplates?: { id: string; name: string; key: string }[]
  /** reused: an existing sequence with the same name and format (not created, never removed by an uninstall) */
  sequences?: { id: string; name: string; key: string; reused?: boolean }[]
  referenceRows?: number
}

export interface TemplateInstallRecord {
  id: string
  templateId: string
  templateVersion: string
  kind: TemplateKind
  mode: TemplateMode
  name: string
  status: 'installed' | 'uninstalled'
  bindings: Record<string, SlotBinding>
  created: TemplateCreated
  solutionId?: string
  installedBy?: string
  installedOn: string
  uninstalledOn?: string
  /** Linked: a newer version is in the catalogue */
  upgradeTo?: string
  /** app, data model and solution installs can be uninstalled */
  canUninstall: boolean
  /** format 2: SAMPLE rows of this install still here ("Remove sample data") */
  sampleRemaining?: number
  /** format 2: the flows of this install that are turned off ("Switch on these flows", administrators) */
  flowsOff?: { id: string; name: string }[]
  /** format 2: the installs this one depends on, and those that depend on it */
  dependsOn?: { template: string; install: string; name: string }[]
  usedBy?: { template: string; install: string; name: string }[]
}

/** POST /templates/:id/install */
export interface TemplateInstallResult {
  install: TemplateInstallRecord
  /** component: the bound UI components; screen: the bound screen (the Studio inserts them) */
  controls?: ControlNode[]
  screen?: ControlNode
  /** tables the inserted part reads (the Studio adds them as data sources) */
  dataSources: string[]
  appId?: string
  backup?: { taken: boolean; message: string }
  warnings: string[]
}

export interface UninstallItem { kind: 'app' | 'table' | 'role' | 'flow' | 'solution' | 'approvalPolicy' | 'dashboard' | 'printTemplate' | 'numberSequence'; id: string; name: string; action: 'removed' | 'kept'; note?: string; rows?: number; destructive?: boolean }
/** POST /templates/installed/:id/uninstall/plan */
export interface UninstallPlan {
  install: TemplateInstallRecord
  items: UninstallItem[]
  problems: string[]
  warnings: string[]
  /** tables with rows that "delete tables with data" would remove */
  tablesWithData: { id: string; name: string; rows: number }[]
  /** the text to type to confirm deleting tables with data */
  confirmText: string
  backup: { available: boolean; message: string }
  token: string
}

/** POST /templates/installed/:id/upgrade/plan */
export interface UpgradePlan {
  plan: import('../platform/http.ts').SolutionPlan
  from: string
  to: string
  /** components changed here since the template delivered them: kept (default) or replaced by the new version */
  localChanges: { key: string; kind: LocalChangeKind; name: string; choice: 'keep' | 'replace' }[]
  /** format 2: what the new version no longer has, kept here (tables, columns, number sequences; data is never removed by an upgrade) */
  noLongerUsed?: string[]
}

/** what an upgrade compares by hash, per component (UpgradePlan.localChanges keys are `<kind>:<id>`) */
export type LocalChangeKind = 'app' | 'table' | 'role' | 'flow' | 'approvalPolicy' | 'dashboard' | 'printTemplate' | 'numberSequence' | 'referenceRow'
export const LOCAL_CHANGE_LABEL: Record<LocalChangeKind, string> = {
  app: 'App', table: 'Table', role: 'Role', flow: 'Flow', approvalPolicy: 'Approval policy', dashboard: 'Dashboard', printTemplate: 'Print template', numberSequence: 'Number sequence', referenceRow: 'Reference row',
}

/* ------------------------------------------------------------------ helpers */

export const tableToken = (slot: string): string => `${SLOT_PREFIX}${slot}`
export const columnToken = (slot: string, col: string): string => `${SLOT_PREFIX}${slot}_${col}`
export const isToken = (name: string): boolean => name.startsWith(SLOT_PREFIX)

/** JSON with object keys sorted (stable over key order): the input of the digest */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
}

/** the package as it is signed: without its signature */
export function signedContent(pkg: TemplatePackage): string {
  const { signature: _s, ...rest } = pkg
  return canonicalJson(rest)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const ID = /^[a-z0-9][a-z0-9.-]{1,79}$/

/** the keys of a pack's components, per kind (roles: key, else none) */
export function componentKeys(pkg: Pick<TemplatePackage, 'payload'>): Record<PackComponentKind, string[]> {
  const p = pkg.payload ?? {}
  const keys = (l: unknown): string[] => (Array.isArray(l) ? l.map((x) => (isObj(x) && typeof x.key === 'string' ? x.key : '')).filter(Boolean) : [])
  return { app: keys(p.apps), role: keys(p.roles), flow: keys(p.flows), policy: keys(p.approvalPolicies), dashboard: keys(p.dashboards), print: keys(p.printTemplates), sequence: keys(p.sequences) }
}

/** the slot tokens a package declares: token -> what it stands for (format 2: component tokens too) */
export function declaredTokens(pkg: Pick<TemplatePackage, 'slots'> & Partial<Pick<TemplatePackage, 'payload' | 'kind'>>): Map<string, { slot: string; column?: string; component?: PackComponentKind; key?: string }> {
  const out = new Map<string, { slot: string; column?: string; component?: PackComponentKind; key?: string }>()
  for (const s of pkg.slots) {
    out.set(tableToken(s.id), { slot: s.id })
    for (const c of s.columns) out.set(columnToken(s.id, c.id), { slot: s.id, column: c.id })
  }
  if (pkg.kind === 'solution' && pkg.payload) {
    const keys = componentKeys(pkg as Pick<TemplatePackage, 'payload'>)
    for (const kind of Object.keys(keys) as PackComponentKind[]) for (const key of keys[kind]) out.set(componentToken(kind, key), { slot: '', component: kind, key })
  }
  return out
}

/**
 * Structural check of a package (everything that does not need the formula parser or the environment). Returns the
 * problems in words; an empty list means the structure is sound. Formulas are checked by checkTemplateFormulas (bind.ts).
 */
export function validateTemplate(raw: unknown): string[] {
  const p: string[] = []
  if (!isObj(raw)) return ['The template is not a JSON object.']
  if (raw.format !== TEMPLATE_FORMAT) p.push(`"format" must be "${TEMPLATE_FORMAT}".`)
  if (!TEMPLATE_FORMAT_VERSIONS.includes(raw.formatVersion as number)) p.push(`"formatVersion" ${String(raw.formatVersion)} is not supported (this Appbuilder reads versions ${TEMPLATE_FORMAT_VERSIONS.join(' and ')}).`)
  if (raw.kind === 'solution' && raw.formatVersion !== 2) p.push('Solution templates need "formatVersion" 2.')
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) p.push('"id" must be lowercase letters, digits, dots and hyphens (2 to 80).')
  if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) p.push('"version" must look like 1.0.0.')
  if (typeof raw.minPlatformVersion !== 'string' || !SEMVER.test(raw.minPlatformVersion)) p.push('"minPlatformVersion" must look like 0.6.0.')
  if (!TEMPLATE_KINDS.includes(raw.kind as TemplateKind)) p.push(`"kind" must be one of ${TEMPLATE_KINDS.join(', ')}.`)
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100) p.push('"name" is required (at most 100 characters).')
  if (typeof raw.description !== 'string') p.push('"description" is required.')
  const kind = raw.kind as TemplateKind
  if (!Array.isArray(raw.modes) || !raw.modes.length || raw.modes.some((m) => m !== 'copy' && m !== 'linked')) p.push('"modes" lists copy and/or linked.')
  else {
    if (!raw.modes.includes('copy')) p.push('Every template can be used as a copy: "modes" must include copy.')
    if (raw.modes.includes('linked') && !LINKED_KINDS.includes(kind)) p.push(`Linked use is not available for ${KIND_LABEL[kind] ?? kind} templates.`)
  }
  if (!Array.isArray(raw.slots)) p.push('"slots" must be a list.')
  const slotIds = new Set<string>()
  for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!isObj(s) || typeof s.id !== 'string' || !IDENT.test(s.id)) { p.push('A slot needs an identifier "id".'); continue }
    if (slotIds.has(s.id)) p.push(`The slot "${s.id}" is declared twice.`)
    slotIds.add(s.id)
    if (typeof s.label !== 'string' || !s.label) p.push(`Slot ${s.id}: "label" is required.`)
    if (typeof s.required !== 'boolean') p.push(`Slot ${s.id}: "required" must be true or false.`)
    if (s.create !== undefined && (!isObj(s.create) || typeof s.create.name !== 'string' || !IDENT.test(s.create.name) || typeof s.create.displayName !== 'string')) p.push(`Slot ${s.id}: "create" needs an identifier "name" and a "displayName".`)
    if (s.defaultMode === 'create' && !s.create) p.push(`Slot ${s.id}: defaultMode create needs "create".`)
    if (!Array.isArray(s.columns)) { p.push(`Slot ${s.id}: "columns" must be a list.`); continue }
    const colIds = new Set<string>()
    for (const c of s.columns) {
      if (!isObj(c) || typeof c.id !== 'string' || !IDENT.test(c.id)) { p.push(`Slot ${s.id}: a column needs an identifier "id".`); continue }
      if (colIds.has(c.id.toLowerCase())) p.push(`Slot ${s.id}: the column "${c.id}" is declared twice.`)
      // every table has the system columns (src/model/names.ts); a column of the same name (in any case) cannot be created
      const cid = String(c.id)
      if (SYSTEM_COLUMN_NAMES.some((n) => n.toLowerCase() === cid.toLowerCase())) p.push(`${s.id}.${cid}: "${cid}" is the name of a system column that every table has (${SYSTEM_COLUMN_NAMES.join(', ')}); give the column another id, such as ${s.id.replace(/s$/, '')}${cid[0].toUpperCase()}${cid.slice(1)}.`)
      colIds.add(c.id.toLowerCase())
      if (!Array.isArray(c.types) || !c.types.length || c.types.some((t) => !COLUMN_TYPES.includes(t as ColumnType))) p.push(`${s.id}.${c.id}: "types" lists column types.`)
      if (typeof c.required !== 'boolean') p.push(`${s.id}.${c.id}: "required" must be true or false.`)
      if (Array.isArray(c.types) && c.types.includes('lookup') && typeof c.lookupSlot !== 'string' && typeof c.lookupSystem !== 'string') p.push(`${s.id}.${c.id}: a lookup column names its "lookupSlot" (or, format 2, "lookupSystem").`)
      if (c.lookupSystem !== undefined && (raw.formatVersion !== 2 || typeof c.lookupSystem !== 'string' || !IDENT.test(c.lookupSystem))) p.push(`${s.id}.${c.id}: "lookupSystem" (format 2) names a table of the core data model.`)
    }
    if (isObj(s.create) && typeof s.create.primaryColumn === 'string' && !colIds.has(s.create.primaryColumn.toLowerCase())) p.push(`Slot ${s.id}: the display column "${s.create.primaryColumn}" is not one of its columns.`)
    if (isObj(s.create) && s.create.uniqueTogether !== undefined && (!Array.isArray(s.create.uniqueTogether) || s.create.uniqueTogether.some((u) => !Array.isArray(u) || u.length < 2 || u.some((x) => typeof x !== 'string' || !colIds.has(x.toLowerCase()))))) p.push(`Slot ${s.id}: "uniqueTogether" lists groups of two or more of its columns.`)
    // P3-P: a synchronous balance (docs/dev/balances.md); tables and columns as tokens, checked again when bound
    if (isObj(s.create) && s.create.balance !== undefined) {
      const b = s.create.balance as unknown
      const tok = (v: unknown) => typeof v === 'string' && /^Slot_[A-Za-z0-9_]+$/.test(v)
      if (raw.kind !== 'solution' || !isObj(b) || !tok(b.movements) || !tok(b.quantity) || !tok(b.column) || !Array.isArray(b.keys) || !b.keys.length || b.keys.length > 4
        || b.keys.some((k) => !isObj(k) || !tok(k.column) || !tok(k.from)) || (b.minColumn !== undefined && !tok(b.minColumn))
        || (b.floor !== undefined && b.floor !== null && typeof b.floor !== 'number') || (b.label !== undefined && typeof b.label !== 'string') || (b.message !== undefined && typeof b.message !== 'string')) {
        p.push(`Slot ${s.id}: "balance" (solution templates) names the movements slot, its quantity and key columns and this slot's balance column as tokens, with 1 to 4 keys.`)
      }
    }
    if (s.from !== undefined) {
      if (raw.kind !== 'solution' || !isObj(s.from) || typeof s.from.template !== 'string' || typeof s.from.slot !== 'string') p.push(`Slot ${s.id}: "from" (a shared slot) needs the template and the slot it comes from (solution templates only).`)
      else if (!(Array.isArray(raw.dependencies) && raw.dependencies.some((d) => isObj(d) && d.id === (s.from as Record<string, unknown>).template))) p.push(`Slot ${s.id}: it comes from ${String(s.from.template)}, which is not one of the dependencies.`)
      if (s.create) p.push(`Slot ${s.id}: a shared slot is never created by this template (no "create").`)
    }
    if (raw.kind === 'solution' && RESERVED_SLOTS.has(s.id.toLowerCase())) p.push(`Slot ${s.id}: this id is reserved for component tokens; choose another.`)
  }
  for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!isObj(s) || !Array.isArray(s.columns)) continue
    for (const c of s.columns) if (isObj(c) && typeof c.lookupSlot === 'string' && !slotIds.has(c.lookupSlot)) p.push(`${String(s.id)}.${String(c.id)}: the lookup slot "${c.lookupSlot}" is not declared.`)
  }
  // tokens must be unique (Slot_A_B_C could be slot A column B_C or slot A_B column C)
  if (Array.isArray(raw.slots) && raw.slots.every((s) => isObj(s) && Array.isArray(s.columns))) {
    const seen = new Set<string>()
    const all = (raw.slots as TemplateSlot[]).flatMap((s) => [tableToken(s.id), ...(Array.isArray(s.columns) ? s.columns : []).map((c) => columnToken(s.id, c.id))])
    if (kind === 'solution' && isObj(raw.payload)) {
      const keys = componentKeys(raw as unknown as Pick<TemplatePackage, 'payload'>)
      for (const k of Object.keys(keys) as PackComponentKind[]) for (const key of keys[k]) all.push(componentToken(k, key))
    }
    for (const t of all) {
      if (seen.has(t.toLowerCase())) p.push(`The slot token ${t} is ambiguous: rename a slot, a column or a component key.`)
      seen.add(t.toLowerCase())
    }
  }
  if (raw.formatVersion !== 2) for (const k of ['shortName', 'prefix', 'dependencies']) if (raw[k] !== undefined) p.push(`"${k}" needs "formatVersion" 2.`)
  if (raw.shortName !== undefined && (typeof raw.shortName !== 'string' || !raw.shortName.trim() || raw.shortName.length > 40)) p.push('"shortName" is a short name (at most 40 characters).')
  if (raw.prefix !== undefined && (typeof raw.prefix !== 'string' || !/^[A-Z][A-Za-z0-9]{0,7}$/.test(raw.prefix))) p.push('"prefix" is a capitalised word of letters and digits (at most 8), such as Mfg.')
  if (raw.dependencies !== undefined) {
    if (kind !== 'solution' || !Array.isArray(raw.dependencies)) p.push('"dependencies" (solution templates) lists { id, minVersion }.')
    else for (const d of raw.dependencies) {
      if (!isObj(d) || typeof d.id !== 'string' || !ID.test(d.id) || typeof d.minVersion !== 'string' || !SEMVER.test(d.minVersion)) p.push('A dependency needs a template "id" and a "minVersion" such as 1.0.0.')
      else if (d.id === raw.id) p.push('A template cannot depend on itself.')
    }
  }
  const payload = raw.payload
  if (!isObj(payload)) p.push('"payload" must be an object.')
  else {
    if (kind === 'solution') p.push(...validatePack(raw, payload, slotIds))
    if (kind === 'component' && (!Array.isArray(payload.controls) || !payload.controls.length)) p.push('A UI component template carries one or more UI components in its payload.')
    if (kind === 'screen' && (!isObj(payload.screen) || payload.screen.type !== 'Screen')) p.push('A screen template has payload.screen (a node of type Screen).')
    if (kind === 'app' && (!isObj(payload.app) || !Array.isArray(payload.app.screens) || !payload.app.screens.length)) p.push('An app template has payload.app (an app definition with screens).')
    if (kind === 'dataModel') {
      if (!Array.isArray(raw.slots) || !raw.slots.length || raw.slots.some((s) => !isObj(s) || !s.create)) p.push('Every table of a data model template is a slot that can be created.')
    }
    if (payload.sample !== undefined) {
      if (kind !== 'dataModel' && kind !== 'solution') p.push('Only data model and solution templates carry sample rows.')
      else if (!isObj(payload.sample)) p.push('payload.sample maps slots to lists of rows.')
      else for (const k of Object.keys(payload.sample)) if (!slotIds.has(k)) p.push(`payload.sample: "${k}" is not a slot.`)
    }
  }
  return p
}

const KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/

/** the format 2 parts of a solution pack */
function validatePack(raw: Record<string, unknown>, payload: Record<string, unknown>, slotIds: Set<string>): string[] {
  const p: string[] = []
  if (typeof raw.shortName !== 'string') p.push('A solution template has a "shortName" (put before the names of its flows, dashboards and print templates).')
  if (typeof raw.prefix !== 'string') p.push('A solution template has a "prefix" for table names that are taken (such as Mfg).')
  const list = (k: string, need: (x: Record<string, unknown>) => string | null) => {
    const v = payload[k]
    if (v === undefined) return
    if (!Array.isArray(v)) { p.push(`payload.${k} must be a list.`); return }
    const keys = new Set<string>()
    for (const x of v) {
      if (!isObj(x) || typeof x.key !== 'string' || !KEY.test(x.key)) { p.push(`payload.${k}: every item has a "key" (letters and digits, starting with a letter).`); continue }
      if (keys.has(x.key.toLowerCase())) p.push(`payload.${k}: the key "${x.key}" is used twice.`)
      keys.add(x.key.toLowerCase())
      if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 100) p.push(`payload.${k} ${x.key}: "name" is required (at most 100 characters).`)
      const why = need(x)
      if (why) p.push(`payload.${k} ${x.key}: ${why}`)
    }
  }
  list('apps', (x) => (!isObj(x.app) || !Array.isArray(x.app.screens) || !x.app.screens.length ? '"app" is an app definition with screens.' : null))
  list('flows', (x) => (!isObj(x.definition) || !isObj(x.definition.trigger) || !Array.isArray(x.definition.steps) ? '"definition" has a trigger and steps.' : x.runRoles !== undefined && !Array.isArray(x.runRoles) ? '"runRoles" lists role tokens.' : null))
  list('approvalPolicies', (x) => (!isObj(x.definition) ? '"definition" is an approval definition.' : null))
  list('dashboards', (x) => (!isObj(x.def) || !Array.isArray(x.def.tiles) ? '"def" is a dashboard definition with tiles.' : x.roles !== undefined && !Array.isArray(x.roles) ? '"roles" lists role tokens.' : null))
  list('printTemplates', (x) => (!isObj(x.doc) || !isObj(x.doc.source) ? '"doc" is a print document with a source.' : null))
  list('sequences', (x) => {
    if (x.padding !== undefined && (typeof x.padding !== 'number' || x.padding < 1 || x.padding > 12)) return '"padding" is 1 to 12 digits.'
    if (x.resetRule !== undefined && !['never', 'yearly', 'financialYear'].includes(String(x.resetRule))) return '"resetRule" is never, yearly or financialYear.'
    if ('nextValue' in x || 'NextValue' in x) return 'a pack never sets the next value of a sequence.'
    return null
  })
  const roles = payload.roles
  if (Array.isArray(roles)) for (const r of roles) if (!isObj(r) || typeof r.key !== 'string' || !KEY.test(r.key)) p.push(`Role ${isObj(r) ? String(r.name ?? '') : ''}: solution packs give every role a "key".`)
  if (payload.reference !== undefined) {
    if (!isObj(payload.reference)) p.push('payload.reference maps slots to lists of rows.')
    else for (const [k, rows] of Object.entries(payload.reference)) {
      if (!slotIds.has(k)) p.push(`payload.reference: "${k}" is not a slot.`)
      if (!Array.isArray(rows) || rows.some((r) => !isObj(r) || typeof r._id !== 'string' || !r._id)) p.push(`payload.reference ${k}: every row has an "_id" (it identifies the row across versions).`)
    }
  }
  if (isObj(payload.sample)) {
    for (const [k, rows] of Object.entries(payload.sample)) {
      if (!Array.isArray(rows)) continue
      const slot = (raw.slots as TemplateSlot[]).find((s) => isObj(s) && s.id === k)
      const primary = slot?.create?.primaryColumn
      if (primary && rows.some((r) => isObj(r) && !String(r[primary] ?? '').startsWith('SAMPLE'))) p.push(`payload.sample ${k}: the ${primary} of every SAMPLE row starts with SAMPLE.`)
    }
  }
  return p
}

/** words for "what it contains" */
export function describeContents(pkg: TemplatePackage): string[] {
  const out: string[] = []
  const count = (nodes: ControlNode[]): number => nodes.reduce((n, c) => n + 1 + count(c.children ?? []), 0)
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (pkg.kind === 'component') out.push(pl(count(pkg.payload.controls ?? []), 'UI component'))
  if (pkg.kind === 'screen' && pkg.payload.screen) out.push(`1 screen with ${pl(count(pkg.payload.screen.children ?? []), 'UI component')}`)
  if (pkg.kind === 'app' && pkg.payload.app) {
    out.push(`1 app with ${pl(pkg.payload.app.screens.length, 'screen')} (${pl(count(pkg.payload.app.screens.flatMap((s) => s.children ?? [])), 'UI component')})`)
    if (pkg.payload.roles?.length) out.push(pl(pkg.payload.roles.length, 'role'))
  }
  const creatable = pkg.slots.filter((s) => s.create)
  if (pkg.kind === 'solution') {
    const p = pkg.payload
    out.push(pl(creatable.length, 'table'))
    const rels = pkg.slots.flatMap((s) => s.columns.filter((c) => c.lookupSlot)).length
    if (rels) out.push(pl(rels, 'relationship'))
    const rules = pkg.slots.reduce((n, s) => n + (s.events?.length ?? 0), 0)
    if (rules) out.push(pl(rules, 'table event or validation rule'))
    const apps = p.apps ?? []
    if (apps.length) out.push(`${pl(apps.length, 'app')} (${apps.map((a) => `${a.name}${a.phone ? ', phone' : ''}`).join('; ')})`)
    if (p.flows?.length) out.push(`${pl(p.flows.length, 'flow')} (they arrive turned off)`)
    if (p.approvalPolicies?.length) out.push(pl(p.approvalPolicies.length, 'approval policy').replace('policys', 'policies'))
    if (p.dashboards?.length) out.push(pl(p.dashboards.length, 'dashboard'))
    if (p.printTemplates?.length) out.push(pl(p.printTemplates.length, 'print template'))
    if (p.roles?.length) out.push(`${pl(p.roles.length, 'role')} (${p.roles.map((r) => r.name).join(', ')})`)
    if (p.sequences?.length) out.push(pl(p.sequences.length, 'number sequence'))
    const ref = Object.values(p.reference ?? {}).reduce((n, r) => n + r.length, 0)
    if (ref) out.push(`${ref} reference rows`)
    const rows = Object.values(p.sample ?? {}).reduce((n, r) => n + r.length, 0)
    if (rows) out.push(`${rows} SAMPLE rows (optional, removable)`)
  } else if (pkg.kind === 'dataModel') {
    out.push(pl(creatable.length, 'table'))
    const rels = pkg.slots.flatMap((s) => s.columns.filter((c) => c.lookupSlot)).length
    if (rels) out.push(pl(rels, 'relationship'))
    const rules = pkg.slots.reduce((n, s) => n + (s.events?.length ?? 0), 0)
    if (rules) out.push(pl(rules, 'validation rule'))
    const rows = Object.values(pkg.payload.sample ?? {}).reduce((n, r) => n + r.length, 0)
    if (rows) out.push(`${rows} SAMPLE rows (optional)`)
  } else if (creatable.length) out.push(`${pl(creatable.length, 'table')} it can create for you`)
  return out
}

/** words for "what it needs" */
export function describeNeeds(pkg: TemplatePackage): string[] {
  if (pkg.kind === 'solution') {
    const deps = (pkg.dependencies ?? []).map((d) => `The template ${d.id} ${d.minVersion} or newer (installed first when it is not here)${pkg.slots.some((s) => s.from?.template === d.id) ? `: its ${pkg.slots.filter((s) => s.from?.template === d.id).map((s) => s.label).join(', ')}` : ''}.`)
    return [...deps, 'An administrator of the environment (it creates roles); its tables are created, or mapped to tables you already have.']
  }
  if (pkg.kind === 'dataModel') return ['Nothing: its tables are created (or mapped to tables you already have).']
  if (!pkg.slots.length) return ['No data: it works on its own.']
  return pkg.slots.map((s) => {
    const cols = s.columns.map((c) => `${c.label} (${c.types.join(' or ')}${c.required ? '' : ', optional'})`).join(', ')
    return `${s.label}${s.required ? '' : ' (optional)'}: a table with ${cols}${s.create ? '; can be created' : ''}`
  })
}
