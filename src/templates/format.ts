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
 */
import type { AppDef, ControlNode } from '../contracts.ts'
import type { ColumnDef, ColumnType } from '../platform/contracts.ts'
import type { TableEventInput } from '../platform/events.ts'
import type { DeleteBehaviour } from '../model/types.ts'
import { IDENT } from '../model/names.ts'

export const TEMPLATE_FORMAT = 'appbuilder/template'
export const TEMPLATE_FORMAT_VERSION = 1
export const SLOT_PREFIX = 'Slot_'
export const TEMPLATE_KINDS = ['component', 'screen', 'app', 'dataModel'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export type TemplateMode = 'copy' | 'linked'

export const KIND_LABEL: Record<TemplateKind, string> = { component: 'UI component', screen: 'Screen', app: 'App', dataModel: 'Data model' }
/** Linked (versioned, upgrade in place) is implemented for these kinds only; the others are Copy only */
export const LINKED_KINDS: readonly TemplateKind[] = ['app', 'dataModel']

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
  /** when the table is created: the column's settings (type defaults to types[0]) */
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
  create?: { name: string; displayName: string; primaryColumn?: string; description?: string }
  /** data models: created unless the maker maps it */
  defaultMode?: 'create' | 'map'
  /** validation rules and events of the table when it is created (formulas use slot tokens) */
  events?: TableEventInput[]
}

export interface TemplateRole {
  name: string
  description?: string
  isMaker?: boolean
  /** privileges on the tables of slots: create / read / update / delete scopes */
  tables: Record<string, { create?: boolean; read?: 'none' | 'own' | 'all'; update?: 'none' | 'own' | 'all'; delete?: 'none' | 'own' | 'all' }>
}

export interface TemplatePayload {
  controls?: ControlNode[]
  screen?: ControlNode
  app?: AppDef
  roles?: TemplateRole[]
  /** dataModel: SAMPLE rows per slot ({ _id: local id, <column id>: value; lookups name a local id }) */
  sample?: Record<string, Record<string, string | number | boolean | null>[]>
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
  formatVersion: 1
  /** stable id, e.g. builtin.request-tracker */
  id: string
  /** semantic version */
  version: string
  kind: TemplateKind
  name: string
  description: string
  publisher?: string
  tags?: string[]
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
  columns: SlotColumnReport[]
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
}

export interface TemplateCreated {
  apps: { id: string; name: string }[]
  tables: { id: string; name: string; slot: string }[]
  roles: { id: string; name: string }[]
  flows: { id: string; name: string }[]
  events: { id: string; table: string; name: string }[]
  mapped: { slot: string; table: string; name: string }[]
  sampleRows: number
  /** UI components and screens: where they went */
  target?: { appId?: string; appName?: string; screenName?: string }
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
  /** app and data model installs can be uninstalled */
  canUninstall: boolean
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

export interface UninstallItem { kind: 'app' | 'table' | 'role' | 'flow' | 'solution'; id: string; name: string; action: 'removed' | 'kept'; note?: string; rows?: number; destructive?: boolean }
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
  localChanges: { key: string; kind: 'app' | 'table'; name: string; choice: 'keep' | 'replace' }[]
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

/** the slot tokens a package declares: token -> what it stands for */
export function declaredTokens(pkg: Pick<TemplatePackage, 'slots'>): Map<string, { slot: string; column?: string }> {
  const out = new Map<string, { slot: string; column?: string }>()
  for (const s of pkg.slots) {
    out.set(tableToken(s.id), { slot: s.id })
    for (const c of s.columns) out.set(columnToken(s.id, c.id), { slot: s.id, column: c.id })
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
  if (raw.formatVersion !== TEMPLATE_FORMAT_VERSION) p.push(`"formatVersion" ${String(raw.formatVersion)} is not supported (this Appbuilder reads version ${TEMPLATE_FORMAT_VERSION}).`)
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
      colIds.add(c.id.toLowerCase())
      if (!Array.isArray(c.types) || !c.types.length || c.types.some((t) => !COLUMN_TYPES.includes(t as ColumnType))) p.push(`${s.id}.${c.id}: "types" lists column types.`)
      if (typeof c.required !== 'boolean') p.push(`${s.id}.${c.id}: "required" must be true or false.`)
      if (Array.isArray(c.types) && c.types.includes('lookup') && typeof c.lookupSlot !== 'string') p.push(`${s.id}.${c.id}: a lookup column names its "lookupSlot".`)
    }
    if (isObj(s.create) && typeof s.create.primaryColumn === 'string' && !colIds.has(s.create.primaryColumn.toLowerCase())) p.push(`Slot ${s.id}: the display column "${s.create.primaryColumn}" is not one of its columns.`)
  }
  for (const s of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!isObj(s) || !Array.isArray(s.columns)) continue
    for (const c of s.columns) if (isObj(c) && typeof c.lookupSlot === 'string' && !slotIds.has(c.lookupSlot)) p.push(`${String(s.id)}.${String(c.id)}: the lookup slot "${c.lookupSlot}" is not declared.`)
  }
  // tokens must be unique (Slot_A_B_C could be slot A column B_C or slot A_B column C)
  if (Array.isArray(raw.slots) && raw.slots.every((s) => isObj(s) && Array.isArray(s.columns))) {
    const seen = new Set<string>()
    const all = (raw.slots as TemplateSlot[]).flatMap((s) => [tableToken(s.id), ...(Array.isArray(s.columns) ? s.columns : []).map((c) => columnToken(s.id, c.id))])
    for (const t of all) {
      if (seen.has(t.toLowerCase())) p.push(`The slot token ${t} is ambiguous: rename a slot or a column.`)
      seen.add(t.toLowerCase())
    }
  }
  const payload = raw.payload
  if (!isObj(payload)) p.push('"payload" must be an object.')
  else {
    if (kind === 'component' && (!Array.isArray(payload.controls) || !payload.controls.length)) p.push('A UI component template carries one or more UI components in its payload.')
    if (kind === 'screen' && (!isObj(payload.screen) || payload.screen.type !== 'Screen')) p.push('A screen template has payload.screen (a node of type Screen).')
    if (kind === 'app' && (!isObj(payload.app) || !Array.isArray(payload.app.screens) || !payload.app.screens.length)) p.push('An app template has payload.app (an app definition with screens).')
    if (kind === 'dataModel') {
      if (!Array.isArray(raw.slots) || !raw.slots.length || raw.slots.some((s) => !isObj(s) || !s.create)) p.push('Every table of a data model template is a slot that can be created.')
    }
    if (payload.sample !== undefined) {
      if (kind !== 'dataModel') p.push('Only data model templates carry sample rows.')
      else if (!isObj(payload.sample)) p.push('payload.sample maps slots to lists of rows.')
      else for (const k of Object.keys(payload.sample)) if (!slotIds.has(k)) p.push(`payload.sample: "${k}" is not a slot.`)
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
  if (pkg.kind === 'dataModel') {
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
  if (pkg.kind === 'dataModel') return ['Nothing: its tables are created (or mapped to tables you already have).']
  if (!pkg.slots.length) return ['No data: it works on its own.']
  return pkg.slots.map((s) => {
    const cols = s.columns.map((c) => `${c.label} (${c.types.join(' or ')}${c.required ? '' : ', optional'})`).join(', ')
    return `${s.label}${s.required ? '' : ' (optional)'}: a table with ${cols}${s.create ? '; can be created' : ''}`
  })
}
