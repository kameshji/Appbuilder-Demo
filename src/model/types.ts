/**
 * Data model designer: shared types (browser and server). docs/dev/data-model.md.
 *
 * The designer edits a COPY of the environment's schema (a draft). Everything it changes is expressed as a list of
 * ModelOps (diff of the draft against the snapshot it started from); the server turns ops into a plan (with row counts
 * and conversion pre-checks) and applies them in one transaction. Patterns, imports and (later) data model templates
 * produce ops too, so one plan/apply path serves them all.
 *
 * Layering: like src/fx, this folder is shared with the server: relative imports with explicit `.ts` extensions, types
 * only from src/platform, no React, DOM or packages.
 */
import type { ColumnDef, ColumnType, TableDef } from '../platform/contracts.ts'

/* ------------------------------------------------------------------ relationships */

/**
 * What happens to child rows when a parent row is deleted (enforced by the server's DataService, data.ts):
 *  - restrict: the delete is refused while child rows point at the parent (409, with the count);
 *  - cascade: the child rows are deleted too, with the caller's permissions (all or nothing), events and outbox rows;
 *  - setBlank: the lookup of the child rows is cleared (a system write, with outbox rows).
 */
export type DeleteBehaviour = 'restrict' | 'cascade' | 'setBlank'
export const DELETE_BEHAVIOURS: DeleteBehaviour[] = ['restrict', 'cascade', 'setBlank']
export const DELETE_BEHAVIOUR_LABEL: Record<DeleteBehaviour, string> = {
  restrict: 'Restrict (refuse while children exist)',
  cascade: 'Cascade (delete the children too)',
  setBlank: 'Set blank (clear the lookup)',
}

/** oneToMany: a lookup on the child; oneToOne: a unique lookup; self: a lookup to the same table (hierarchy) */
export type RelationshipKind = 'oneToMany' | 'oneToOne' | 'self'

/**
 * One relationship, stored explicitly (ab_relationships). It always rests on a lookup column: `fromTable.fromColumn`
 * holds the id of a `toTable` row. A many-to-many relationship is a junction table with two relationships that share
 * `junction.group`.
 */
export interface RelationshipDef {
  id: string
  /** child table id (holds the lookup column) */
  fromTable: string
  fromColumn: string
  /** parent table id */
  toTable: string
  kind: RelationshipKind
  onDelete: DeleteBehaviour
  /** self relationships: refuse a parent chain that comes back to the row itself */
  preventCycles?: boolean
  /** one side of a many-to-many junction table */
  junction?: { group: string }
}

/* ------------------------------------------------------------------ reporting */

/** how a view column is computed from its source column (only these: the SQL is generated, never typed) */
export type ViewExpr = 'value' | 'dateKey' | 'year' | 'month' | 'quarter'

export interface ViewColumn {
  name: string
  displayName: string
  type: ColumnType
  /** the source column of the base table */
  source: string
  expr?: ViewExpr
  /** lookup to another reporting view (fact -> dimension) */
  lookupTable?: string
}

/**
 * A reporting view: a PostgreSQL view over exactly ONE base table (same connection), registered as a read-only table.
 * Lineage = base + column mapping. Security is the base table's: the view's rows are the base rows the reader may read
 * (semi-join on id), and a view column is hidden when its source column is hidden for the reader (security.ts).
 */
export interface ViewDef {
  kind: 'view'
  role: 'fact' | 'dimension'
  /** base table id */
  base: string
  /** the base table's physical name, filled by the server when the view is created (never trusted from a client) */
  baseSource?: string
  columns: ViewColumn[]
}

export type SummaryFn = 'sum' | 'count' | 'avg' | 'min' | 'max'
/** a real table refreshed by a scheduled job (model.summary.refresh) from a source table, as the system */
export interface SummaryDef {
  kind: 'summary'
  /** source table id */
  source: string
  groupBy: string[]
  measures: { name: string; fn: SummaryFn; column?: string }[]
  /** refresh schedule (5-field cron); default hourly */
  cron: string
}

/** a calendar table filled at apply time */
export interface DateDimDef {
  kind: 'date'
  /** yyyy-mm-dd, inclusive */
  from: string
  to: string
  /** 1-12; 4 = April (India: April to March) */
  fiscalYearStartMonth: number
}

export type ReportingDef = ViewDef | SummaryDef | DateDimDef

/* ------------------------------------------------------------------ the model */

/** a TableDef plus the model-only fields (TableDef.reporting and uniqueTogether are part of the platform contract) */
export type ModelTable = TableDef & {
  /** import from an external database: register (link) this existing source instead of creating a table */
  link?: { connectionId: string; source: string }
}

export interface Model {
  tables: ModelTable[]
  relationships: RelationshipDef[]
}

/** ids of tables created in a draft start with this (they get real ids when applied) */
export const NEW_ID_PREFIX = 'new_'
export const isNewId = (id: string): boolean => id.startsWith(NEW_ID_PREFIX)

/* ------------------------------------------------------------------ operations */

export type ModelOp =
  | { op: 'createTable'; table: ModelTable }
  | { op: 'updateTable'; id: string; patch: { displayName?: string; description?: string; primaryColumn?: string; uniqueTogether?: string[][] } }
  | { op: 'dropTable'; id: string; name: string }
  | { op: 'addColumn'; table: string; column: ColumnDef }
  | { op: 'updateColumn'; table: string; name: string; before: ColumnDef; after: ColumnDef }
  | { op: 'dropColumn'; table: string; name: string }
  | { op: 'putRelationship'; rel: RelationshipDef; before?: RelationshipDef }
  | { op: 'dropRelationship'; id: string }

/* ------------------------------------------------------------------ layout */

export interface ModelArea {
  id: string
  name: string
  /** one of AREA_COLORS */
  color: string
  tables: string[]
}
export const AREA_COLORS = ['blue', 'green', 'amber', 'rose', 'violet', 'teal', 'slate'] as const

export interface ModelLayout {
  positions: Record<string, { x: number; y: number }>
  areas: ModelArea[]
}

/* ------------------------------------------------------------------ drafts and plans */

export interface ModelDraft {
  /** the live model when the draft started (the plan is base -> model, checked against the live schema) */
  base: Model
  model: Model
  /** layout of tables that exist only in the draft (and moved ones), merged into the saved layout on apply */
  layout?: ModelLayout
  /** undo / redo stacks of models (the browser trims them) */
  past?: Model[]
  future?: Model[]
  modifiedOn?: string
}

export type ModelPlanKind = 'table' | 'column' | 'relationship' | 'view' | 'index' | 'data'
export interface ModelPlanItem {
  kind: ModelPlanKind
  change: 'new' | 'changed' | 'removed'
  /** table display name (and column display name for columns) */
  table: string
  name: string
  destructive?: boolean
  /** rows affected (dropped table: all rows; dropped column: rows with a value; conversion: rows checked) */
  rows?: number
  /** a type change: values that will not convert (the apply is refused while there are any) */
  conversion?: { failing: number; examples: string[]; checked: number }
  note?: string
}

export interface ModelPlan {
  items: ModelPlanItem[]
  destructive: boolean
  /** blocking: the apply is refused while there are any */
  problems: string[]
  warnings: string[]
  backup: { available: boolean; message: string }
  /** pass back to apply exactly this plan */
  token: string
  opCount: number
}

export interface ModelApplyResult {
  /** draft table ids -> real ids */
  ids: Record<string, string>
  plan: ModelPlan
  backup: { taken: boolean; message: string }
}

/** GET /api/v1/model */
export interface ModelResponse {
  model: Model
  layout: ModelLayout
  /** the signed-in user's own layout, when they saved one */
  myLayout?: ModelLayout
  draft: ModelDraft | null
  /** the environment is locked (production): read-only */
  locked: boolean
  /** a stable fingerprint of the live schema */
  version: string
}

/* ------------------------------------------------------------------ system tables */

/**
 * Environment system tables (core data model, package N: User, Team, Activity, ...): shown read-only on the diagram
 * and hidden on request. Recognised by the markers package N sets on their TableDef.
 */
export function isSystemTable(t: TableDef): boolean {
  const x = t as TableDef & { system?: boolean; systemTable?: boolean; builtIn?: boolean; core?: boolean }
  return x.system === true || x.systemTable === true || x.builtIn === true || x.core === true
}

/** read-only on the canvas: system tables, reporting views, linked read-only tables */
export function isReadOnlyTable(t: TableDef): boolean {
  return isSystemTable(t) || t.reporting?.kind === 'view' || t.readOnly === true
}
