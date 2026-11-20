/**
 * CONTRACTS. The single shared interface between the three packages:
 *   src/fx        formula engine (no React, no DOM)
 *   src/controls  control registry + shadcn-based renderers
 *   src/studio + src/runtime   editor shell, canvas, player
 * Do not change this file without telling the architect; code against it exactly.
 */
import type { ComponentType, ReactNode } from 'react'

/* ------------------------------------------------------------------ app definition */

/** A formula is source text that always starts with '='. Example: '="Hello " & TextInput1.Value' */
export type Formula = string

export interface ControlNode {
  /** stable unique id (nanoid-like), never shown to the maker */
  id: string
  /** unique across the whole app, maker-visible, used in formulas: Button1, Gallery1 */
  name: string
  /** key into the control registry: 'Screen' | 'Label' | 'Button' | ... */
  type: string
  /** property name -> formula. Missing property = registry default. */
  props: Record<string, Formula>
  /** children. For Gallery, the children are the row template. */
  children: ControlNode[]
}

export interface AppDef {
  formatVersion: 1 | 2
  name: string
  /**
   * design resolution of every screen, px. Landscape or portrait (200..16000 per side). Presets (src/runtime/sizes.ts):
   * desktop 1920x1080, 2560x1440; phone 360x800, 390x844, 412x915; tablet 800x1280, 1280x800.
   */
  width: number
  height: number
  /**
   * 'responsive' (default): at run time the screen fills the window at any landscape aspect ratio (a portrait
   *   design fills a portrait window and is scaled to fit a landscape one); controls follow their anchors /
   *   auto-layout; App.Width and App.Height are live.
   * 'fit': the design resolution is scaled uniformly and letterboxed.
   */
  scaleMode?: 'responsive' | 'fit'
  /** theme tokens for the running app */
  theme?: { mode?: 'light' | 'dark'; primary?: string; radius?: number; font?: string }
  /** table names (platform tables) this app uses as data sources */
  dataSources?: string[]
  /**
   * P2-A "Works offline (entry)": on phones, creates, updates and photo uploads made without a connection wait in an
   * encrypted outbox on the device and are sent when it returns; screens visited keep their last data (docs/dev/phone.md).
   * Absent or false: the app needs a connection (as before).
   * `tables` (additive, optional): data-source tables kept on the device for offline lookups, dropdowns and lists,
   * downloaded as the signed-in user when the app opens online (docs/dev/phone.md "Tables kept on the device").
   */
  offline?: { entry?: boolean; tables?: OfflineTableDef[] }
  /** App-level formulas: OnStart */
  appProps: Record<string, Formula>
  /** nodes with type 'Screen' */
  screens: ControlNode[]
}

/**
 * One table of `AppDef.offline.tables` (P2 phone, additive). `filter`: an optional formula condition over the table's
 * columns that the server can run (`Status <> "Closed"`); `maxRows`: the row cap (default 2,000, at most 10,000).
 */
export interface OfflineTableDef {
  table: string
  filter?: string
  maxRows?: number
}

/* ------------------------------------------------------------------ Fx values */

/** Blank is null. Tables are arrays of records. Colours are CSS colour strings. Dates are Date. */
export type FxValue = null | boolean | number | string | Date | FxRecord | FxValue[]
export interface FxRecord { [field: string]: FxValue }

export interface FxDiagnostic {
  message: string
  /** 0-based offsets into the formula source INCLUDING the leading '=' */
  start: number
  end: number
}

export type FxResult =
  | { ok: true; value: FxValue }
  | { ok: false; error: FxDiagnostic }

/**
 * Name resolution supplied by the host. Called for every bare identifier that is not a
 * row-scope field, a With/ForAll/As name, a built-in enum (Color, Align, ...) or a function.
 * Return undefined when the name is unknown (engine reports "Name isn't recognised: X").
 * Typical answers: a control (record of its evaluated props + outputs), a variable value,
 * a collection (array of records), ThisItem, Self, Parent.
 */
export interface FxScope {
  resolve(name: string): FxValue | undefined
  /**
   * Lookup columns (P0-N): the record a row id points at, so `ThisRecord.createdBy.FullName` reads the Users row. Row ids
   * are unique across tables. undefined: not an id this scope knows (the member access is an error as before); null: an
   * id whose record is not available (yet), read as blank.
   */
  recordById?(id: string): FxRecord | null | undefined
}

/**
 * Side effects. Only reachable from behaviour functions. When evaluate() is called without a
 * host, any behaviour function is an error ("Behaviour function in a non-behaviour property").
 * Collections and variables live in the host, not the engine.
 */
export interface FxHost {
  setVar(name: string, value: FxValue): void
  /** UpdateContext({a: 1, b: 2}) */
  updateContext(values: FxRecord): void
  /** Collect / ClearCollect / Clear. items already flattened to records. */
  collect(collection: string, items: FxRecord[], clearFirst: boolean): void
  clear(collection: string): void
  /** Remove(Coll, record) -> match by the hidden '__id' field; RemoveIf handled by engine via remove() */
  remove(collection: string, records: FxRecord[]): void
  /** Patch(Coll, base, changes). base without '__id' (Defaults(Coll)) = create. Returns the stored record. */
  patch(collection: string, base: FxRecord, changes: FxRecord): FxRecord
  navigate(screenName: string): void
  back(): void
  notify(message: string, kind: 'info' | 'success' | 'warning' | 'error'): void
  /** Reset(TextInput1) -> control returns to its Default */
  reset(controlName: string): void
  /** SubmitForm / ResetForm / NewForm / EditForm / ViewForm (Form1) */
  form(action: 'submit' | 'reset' | 'new' | 'edit' | 'view', formName: string): void
  /** Select(Button1): run the control's OnSelect */
  select(controlName: string): void
  setFocus(controlName: string): void
  /** Launch(url) */
  launch(url: string): void
  /** Copy(text) to clipboard */
  copy(text: string): void
  /** Trace(message [, data]) -> debug console of the Studio / debug window */
  trace(message: string, data?: FxValue): void
  /** Exit(): close the running app (debug window: stop; preview: back to edit) */
  exit(): void
  /** Refresh(Table): reload a table from storage */
  refresh(source: string): void
  /** Share(record, userOrTeam, access): share one row (asynchronous; failures are notified) */
  share?(rowId: string, principal: string, access: 'read' | 'update'): void
  /** Unshare(record, userOrTeam) */
  unshare?(rowId: string, principal: string): void
  /** SendNotification(user, title, body, link): an in-app notification to a person in this environment (asynchronous) */
  sendNotification?(to: string, title: string, body: string, link: string): void
  /**
   * Core data model (P0-N): AddComment, AddActivity, Follow, Unfollow, Tag, Untag (asynchronous writes; failures are
   * notified) and NextNumber (demo mode only: the server assigns numbers in column defaults and before-events).
   * `args.record` is the row id; the result is what the function returns (NextNumber: the number text).
   */
  collab?(action: 'addComment' | 'addActivity' | 'follow' | 'unfollow' | 'tag' | 'untag' | 'nextNumber', args: Record<string, FxValue>): FxValue
  /**
   * RunFlow(flow, inputs [, {Wait, Timeout, Result}]) (P1 flows, server mode): starts a run of a flow with a manual
   * trigger and returns its run id at once. With Wait the response of the flow's Respond step is put in the global
   * variable named by Result (default FlowResult) when it arrives (at most Timeout seconds, at most 30).
   */
  runFlow?(flow: string, inputs: FxRecord, options: { wait: boolean; timeoutSeconds: number; result: string }): string
  /**
   * RequestApproval(policyOrApprovers, record, title [, details [, fields]]) (P1-C, server mode): asks for an approval and
   * returns its id at once (chosen here, so a retry does not ask twice); the request is made asynchronously.
   */
  requestApproval?(input: { id: string; policy?: string; approvers?: string[]; record: string; title: string; details: string; fields: FxRecord }): string
  /**
   * P2-B print templates (server mode): Print(template [, record]) opens the PDF of the published template in a new tab
   * (phones: share or download); GeneratePdf / GenerateDocx return a file token at once (chosen here) that attachment
   * columns accept in Patch; the file is generated on the server in the background. Failures are notified.
   */
  print?(template: string, recordId: string | null): void
  generateFile?(kind: 'pdf' | 'docx', template: string, recordId: string | null): string
  /** Restore(row or batch) (recycle bin, docs/dev/recycle-bin.md): asynchronous; failures are notified */
  restore?(what: { rowId?: string; table?: string; batch?: string }): void
}

export interface FxFunctionDoc {
  name: string
  /** 'Filter(source, condition, ...)' */
  signature: string
  summary: string
  kind: 'pure' | 'behaviour'
}

/** Public API exported from src/fx/index.ts */
export interface FxApi {
  /** Syntax check only. Empty array = parses. */
  check(source: Formula): FxDiagnostic[]
  /** Evaluate. Never throws. `host` omitted = data (non-behaviour) property. */
  evaluate(source: Formula, scope: FxScope, host?: FxHost): FxResult
  /** Bare identifiers referenced by the formula (for rename + dependency display). */
  referencedNames(source: Formula): string[]
  /** Rename an identifier everywhere it is used as a name (not inside strings). */
  renameIdentifier(source: Formula, from: string, to: string): Formula
  /** All registered functions, for the formula bar's autocomplete. */
  functions(): FxFunctionDoc[]
  /** Built-in enum names and members, for autocomplete: { Color: ['Red', ...], ... } */
  enums(): Record<string, string[]>
  /**
   * Named formulas (App.Formulas): "Name = expr; Other = expr;" -> one entry per definition.
   * `formula` is ready for evaluate() (leading '='). Also accepts user-defined functions
   * "Area(w: Number, h: Number): Number = w * h;" (params filled, formula = body).
   */
  parseNamedFormulas(source: string): { items: FxNamedFormula[]; errors: FxDiagnostic[] }
  /**
   * Register user-defined functions on the DEFAULT engine (the one behind this `fx` object), replacing its previous set.
   * Code that can run for several apps or requests at once uses its own engine from createEngine() instead.
   */
  setUserFunctions(defs: FxNamedFormula[]): void
  /** Call-site help for the formula bar: which function and which argument the caret is in. */
  signatureAt(source: Formula, offset: number): { name: string; signature: string; summary: string; argIndex: number } | null
  /** A new, independent engine instance with its own user-defined functions and named formulas. */
  createEngine(options?: FxEngineOptions): FxEngine
}

export interface FxEngineOptions {
  /** App.Formulas source ("Name = expr; F(x: Number): Number = x * 2;"): split into named formulas and user functions */
  formulas?: string
  userFunctions?: FxNamedFormula[]
  namedFormulas?: FxNamedFormula[]
}

/**
 * One formula engine instance (src/fx/engine.ts). User-defined functions and named formulas belong to the instance:
 * two instances never see each other's definitions. Built-in functions and enums are shared and immutable.
 * Named formulas are resolved after the scope: a name the scope answers (control, variable, table) wins.
 */
export interface FxEngine {
  check(source: Formula): FxDiagnostic[]
  evaluate(source: Formula, scope: FxScope, host?: FxHost): FxResult
  /** built-in functions plus this engine's user-defined functions */
  functions(): FxFunctionDoc[]
  signatureAt(source: Formula, offset: number): { name: string; signature: string; summary: string; argIndex: number } | null
  /** replace this engine's user-defined functions (entries without params are ignored) */
  setUserFunctions(defs: FxNamedFormula[]): void
  /** replace this engine's named formulas (entries with params are ignored) */
  setNamedFormulas(defs: FxNamedFormula[]): void
  /** parse App.Formulas and replace both sets; returns the parse errors */
  setFormulas(source: string): FxDiagnostic[]
  userFunctions(): FxNamedFormula[]
  namedFormulas(): FxNamedFormula[]
}

export interface FxNamedFormula {
  name: string
  formula: Formula
  /** present for user-defined functions */
  params?: { name: string; type: string }[]
  returnType?: string
}

/* ------------------------------------------------------------------ control registry */

/** 'tableName' = text formula naming a platform table (editor: select of tables). 'icon' = icon name text: a lucide name ("Plus") or an animated icon "anim:<id>" (editor: icon picker). 'record' = a record formula. */
export type PropKind = 'text' | 'number' | 'boolean' | 'color' | 'enum' | 'action' | 'table' | 'any' | 'tableName' | 'icon' | 'record'
export type PropGroup = 'Content' | 'Data' | 'Layout' | 'Style' | 'Behaviour'

export interface PropMeta {
  name: string
  /** label on the Simple tab; defaults to name */
  label?: string
  kind: PropKind
  group: PropGroup
  /** default formula, e.g. '="Button"', '=true', '=RGBA(79, 70, 229, 1)' */
  default: Formula
  /** kind === 'enum': member formulas shown in the select, e.g. ['Align.Left','Align.Center'] */
  options?: string[]
  /** false = Advanced tab only. Default true. */
  simple?: boolean
}

export interface ControlRenderProps {
  node: ControlNode
  /** every property of the control, evaluated. Failed formulas arrive as the default's value. */
  props: Record<string, FxValue>
  /** 'design' = on the Studio canvas (must not capture clicks/focus); 'run' = preview/player */
  mode: 'design' | 'run'
  /** current values of the control's outputs (Value, Selected, ...) */
  outputs: Record<string, FxValue>
  /** write an output; other formulas that read it recalculate */
  setOutput(name: string, value: FxValue): void
  /** run an action property (OnSelect, OnChange). Optional extra row scope for galleries. */
  fire(event: string): void
  /** already-rendered child controls, for containers */
  children?: ReactNode
  /** Gallery only: render the row template for one item (sets ThisItem for that subtree) */
  renderTemplate?(item: FxRecord, index: number): ReactNode
  /** run mode only: imperative focus request counter (SetFocus); focus your main element when it changes */
  focusToken?: number
}

export interface ControlType {
  type: string
  /** name in the Insert pane */
  label: string
  /** lucide-react icon component */
  icon: ComponentType<{ className?: string }>
  category: 'Layout' | 'Display' | 'Input' | 'Data' | 'Navigation' | 'Feedback' | 'Media' | 'Charts'
  /** control-specific properties. X, Y, Width, Height, Visible are added by the registry for every non-Screen control. */
  props: PropMeta[]
  outputs: { name: string; initial: FxValue }[]
  defaultSize: { width: number; height: number }
  /** may hold children (Screen, Container, Card, Dialog, Gallery...) */
  isContainer?: boolean
  /** children are a per-item template (Gallery) rather than direct children */
  isTemplate?: boolean
  /** rendered above everything else when shown (Dialog, Sheet); the canvas shows it in place */
  isOverlay?: boolean
  /** property the formula bar selects first, e.g. 'Text', 'Items', 'OnSelect' */
  primaryProp: string
  /** fills 100% of its wrapper; the canvas/player positions and sizes the wrapper */
  render: ComponentType<ControlRenderProps>
}

/** Public API exported from src/controls/index.ts */
export interface ControlRegistryApi {
  get(type: string): ControlType
  /** insertable controls in Insert-pane order (excludes Screen) */
  list(): ControlType[]
  /** full property list for a type, including the common X/Y/Width/Height/Visible */
  propsOf(type: string): PropMeta[]
}
