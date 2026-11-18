/**
 * Text schema in a DBML-like form (pure): export for docs and reviews, import into a draft.
 *
 *   Table Customer [note: 'Customers'] {
 *     Name text [not null, display]
 *     Email email [unique]
 *     Region choice ['North', 'South']
 *   }
 *   Table Order {
 *     Customer lookup [ref: > Customer.id, not null]
 *   }
 *   Ref: Order.Customer > Customer.id [delete: cascade]
 *
 * Export writes our column types; import also understands common SQL/DBML types (varchar, int, decimal(10,2),
 * timestamp, bool, uuid ...) and `Ref:` lines with `>` (many-to-one), `<` (one-to-many) and `-` (one-to-one).
 */
import type { ColumnDef, ColumnType } from '../platform/contracts.ts'
import type { DeleteBehaviour, Model, RelationshipDef } from './types.ts'
import { addTable, clone, defaultDeleteBehaviour, newRelId, tableById, tableByName, userColumns } from './ops.ts'
import { IDENT, toIdentifier } from './names.ts'

const COLUMN_TYPES: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file']

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function toDbml(m: Model, o: { title?: string; includeSystem?: boolean } = {}): string {
  const lines: string[] = []
  if (o.title) lines.push(`// ${o.title}`)
  lines.push('// Appbuilder data model (DBML-like). Every table also has: id text [pk], createdOn, modifiedOn, createdBy, owner.', '')
  const tables = [...m.tables].sort((a, b) => a.name.localeCompare(b.name))
  for (const t of tables) {
    const settings: string[] = []
    if (t.displayName !== t.name) settings.push(`note: ${quote(t.displayName)}`)
    if (t.reporting?.kind === 'view') settings.push(`reporting: ${t.reporting.role}-view`)
    else if (t.reporting) settings.push(`reporting: ${t.reporting.kind}`)
    lines.push(`Table ${t.name}${settings.length ? ` [${settings.join(', ')}]` : ''} {`)
    const cols = o.includeSystem ? t.columns : userColumns(t)
    for (const c of cols) {
      const attrs: string[] = []
      if (c.name === 'id') attrs.push('pk')
      if (c.required) attrs.push('not null')
      if (c.unique) attrs.push('unique')
      if (c.indexed) attrs.push('indexed')
      if (c.name === t.primaryColumn) attrs.push('display')
      if (c.default !== undefined) attrs.push(`default: ${quote(c.default)}`)
      if (c.displayName !== c.name) attrs.push(`note: ${quote(c.displayName)}`)
      if (c.type === 'lookup' && c.lookupTable) attrs.push(`ref: > ${c.lookupTable}.id`)
      if (c.computed?.kind === 'formula') attrs.push(`formula: ${quote(c.computed.formula)}`)
      if (c.computed?.kind === 'rollup') attrs.push(`rollup: ${quote(`${c.computed.fn}(${c.computed.table}.${c.computed.column ?? '*'} via ${c.computed.via})`)}`)
      let type: string = c.type
      if (c.type === 'choice') type = `choice(${(c.choices ?? []).map(quote).join(', ')})`
      if (c.type === 'autonumber' && c.prefix) type = `autonumber(${quote(c.prefix)})`
      lines.push(`  ${c.name} ${type}${attrs.length ? ` [${attrs.join(', ')}]` : ''}`)
    }
    for (const set of t.uniqueTogether ?? []) lines.push(`  indexes { (${set.join(', ')}) [unique] }`)
    lines.push('}', '')
  }
  const key = (r: RelationshipDef) => `${tableById(m, r.fromTable)?.name ?? r.fromTable}.${r.fromColumn}`
  const rels = [...m.relationships].sort((a, b) => key(a).localeCompare(key(b)))
  for (const r of rels) {
    const from = tableById(m, r.fromTable)
    const to = tableById(m, r.toTable)
    if (!from || !to) continue
    const op = r.kind === 'oneToOne' ? '-' : '>'
    const s: string[] = [`delete: ${r.onDelete === 'setBlank' ? 'set null' : r.onDelete}`]
    if (r.preventCycles) s.push('no cycles')
    if (r.junction) s.push(`junction: ${r.junction.group}`)
    lines.push(`Ref: ${from.name}.${r.fromColumn} ${op} ${to.name}.id [${s.join(', ')}]`)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/* ------------------------------------------------------------------ parse */

export interface DbmlResult { model: Model; warnings: string[] }

function sqlType(raw: string): { type: ColumnType; choices?: string[]; prefix?: string } {
  const t = raw.trim()
  const lower = t.toLowerCase()
  const args = /\((.*)\)\s*$/.exec(t)?.[1]
  const base = lower.replace(/\(.*$/, '').trim()
  const strings = (s: string | undefined) => (s ? [...s.matchAll(/'((?:\\.|[^'\\])*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, '$1')) : [])
  if (base === 'choice' || base === 'enum') return { type: 'choice', choices: strings(args) }
  if (base === 'autonumber') return { type: 'autonumber', prefix: strings(args)[0] ?? '' }
  if ((COLUMN_TYPES as string[]).includes(base)) return { type: base as ColumnType }
  if (/^(int|integer|bigint|smallint|tinyint|serial|bigserial|int2|int4|int8)$/.test(base)) return { type: 'number' }
  if (/^(numeric|decimal)$/.test(base)) {
    const scale = Number(args?.split(',')[1] ?? 'NaN')
    return { type: scale === 0 ? 'number' : scale === 4 || scale === 2 ? 'currency' : 'decimal' }
  }
  if (/^(money)$/.test(base)) return { type: 'currency' }
  if (/^(float|double|real|double precision|float4|float8)$/.test(base)) return { type: 'decimal' }
  if (/^(bool|boolean|bit)$/.test(base)) return { type: 'boolean' }
  if (/^(date)$/.test(base)) return { type: 'date' }
  if (/^(timestamp|timestamptz|datetime|datetime2|timestamp with time zone|timestamp without time zone)$/.test(base)) return { type: 'datetime' }
  if (/^(text|longtext|mediumtext|json|jsonb|xml|clob)$/.test(base)) return { type: 'multiline' }
  return { type: 'text' }
}

function splitAttrs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      cur += ch
      if (ch === '\\') { cur += s[++i] ?? ''; continue }
      if (ch === q) q = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
/** puts `{` and `}` (outside quotes and brackets) on lines of their own, so one-line tables parse like multi-line ones */
function braceLines(text: string): string {
  let out = ''
  let q: string | null = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { out += ch; if (ch === '\\') out += text[++i] ?? ''; else if (ch === q) q = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; out += ch; continue }
    if (ch === '[' || ch === '(') depth++
    if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && ch === '{') { out += '{\n'; continue }
    if (depth === 0 && ch === '}') { out += '\n}\n'; continue }
    out += ch
  }
  return out
}
const unq = (s: string) => s.trim().replace(/^(['"`])([\s\S]*)\1$/, '$2').replace(/\\(.)/g, '$1')
const ident = (s: string) => unq(s).replace(/^.*\./, '')

function deleteOf(attrs: string[]): DeleteBehaviour | undefined {
  for (const a of attrs) {
    const m = /^delete\s*:\s*(.+)$/i.exec(a)
    if (!m) continue
    const v = m[1].trim().toLowerCase()
    if (v === 'cascade') return 'cascade'
    if (v === 'restrict' || v === 'no action') return 'restrict'
    if (v === 'set null' || v === 'setblank' || v === 'set blank') return 'setBlank'
  }
  return undefined
}

/**
 * Parses DBML-like text into NEW tables (ids new_*) and relationships, added to `into` (default: an empty model).
 * Names that already exist in `into` are reported and skipped.
 */
export function parseDbml(text: string, into: Model = { tables: [], relationships: [] }): DbmlResult {
  const warnings: string[] = []
  let model = clone(into)
  const existing = new Set(into.tables.map((t) => t.name.toLowerCase()))
  const src = braceLines(text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')).split('\n')
  interface PendingRef { from: string; col: string; to: string; op: string; attrs: string[] }
  const refs: PendingRef[] = []
  const created = new Map<string, string>()
  let cur: { name: string; display?: string; cols: Partial<ColumnDef>[]; display_col?: string; uniques: string[][] } | null = null
  let inIndexes = false
  for (const raw of src) {
    const line = raw.trim()
    if (!line) continue
    if (!cur) {
      const tm = /^Table\s+("?[\w.]+"?)(?:\s+as\s+\w+)?\s*(\[(.*)\])?\s*\{\s*$/i.exec(line)
      if (tm) {
        const name = ident(tm[1])
        const settings = tm[3] ? splitAttrs(tm[3]) : []
        const note = settings.map((s) => /^note\s*:\s*(.+)$/i.exec(s)?.[1]).find(Boolean)
        cur = { name, display: note ? unq(note) : undefined, cols: [], uniques: [] }
        continue
      }
      const rm = /^Ref\s*\w*\s*:\s*("?[\w.]+"?)\.("?\w+"?)\s*([<>-])\s*("?[\w.]+"?)\.("?\w+"?)\s*(\[(.*)\])?/i.exec(line)
      if (rm) {
        const attrs = rm[7] ? splitAttrs(rm[7]) : []
        if (rm[3] === '<') refs.push({ from: ident(rm[4]), col: unq(rm[5]), to: ident(rm[1]), op: '>', attrs })
        else refs.push({ from: ident(rm[1]), col: unq(rm[2]), to: ident(rm[4]), op: rm[3], attrs })
        continue
      }
      if (/^(Project|Enum|TableGroup|Note)\b/i.test(line)) continue
      if (line !== '}') warnings.push(`Ignored: ${line.slice(0, 80)}`)
      continue
    }
    if (inIndexes) {
      if (line.startsWith('}')) { inIndexes = false; continue }
      const im = /^\(([^)]*)\)\s*(\[(.*)\])?/.exec(line)
      if (im && /unique/i.test(im[3] ?? '')) cur.uniques.push(im[1].split(',').map((x) => unq(x)))
      continue
    }
    if (/^indexes\s*\{/i.test(line)) {
      const inline = /^indexes\s*\{\s*\(([^)]*)\)\s*\[([^\]]*)\]\s*\}/i.exec(line)
      if (inline) { if (/unique/i.test(inline[2])) cur.uniques.push(inline[1].split(',').map((x) => unq(x))); continue }
      inIndexes = true
      continue
    }
    if (line === '}') {
      if (existing.has(cur.name.toLowerCase())) warnings.push(`Table "${cur.name}" already exists: skipped.`)
      else if (!IDENT.test(cur.name)) warnings.push(`"${cur.name}" is not a valid table name: skipped.`)
      else {
        const res = addTable(model, { displayName: cur.display ?? cur.name, name: cur.name, columns: cur.cols, uniqueTogether: cur.uniques })
        model = res.model
        const t = tableById(model, res.table.id)!
        if (cur.display_col && t.columns.some((c) => c.name === cur!.display_col)) t.primaryColumn = cur.display_col
        created.set(cur.name.toLowerCase(), t.id)
      }
      cur = null
      continue
    }
    if (/^note\s*:/i.test(line)) continue
    const cm = /^("?\w+"?)\s+(.+?)\s*(\[(.*)\])?\s*$/.exec(line)
    if (!cm) { warnings.push(`Ignored in ${cur.name}: ${line.slice(0, 80)}`); continue }
    const name = unq(cm[1])
    if (['id', 'createdon', 'modifiedon', 'createdby', 'owner'].includes(name.toLowerCase())) continue
    const typed = sqlType(cm[2])
    const attrs = cm[4] ? splitAttrs(cm[4]) : []
    const col: Partial<ColumnDef> = { name: IDENT.test(name) ? name : toIdentifier(name, 'Column'), displayName: name, type: typed.type }
    if (typed.choices) col.choices = typed.choices
    if (typed.prefix !== undefined) col.prefix = typed.prefix
    for (const a of attrs) {
      const al = a.toLowerCase()
      if (al === 'not null') col.required = true
      else if (al === 'unique') col.unique = true
      else if (al === 'indexed' || al === 'index') col.indexed = true
      else if (al === 'pk' || al === 'primary key') col.unique = true
      else if (al === 'display') cur.display_col = col.name
      else if (/^note\s*:/i.test(a)) col.displayName = unq(a.replace(/^note\s*:/i, ''))
      else if (/^default\s*:/i.test(a)) col.default = unq(a.replace(/^default\s*:/i, ''))
      else if (/^formula\s*:/i.test(a)) col.computed = { kind: 'formula', formula: unq(a.replace(/^formula\s*:/i, '')) }
      else if (/^ref\s*:/i.test(a)) {
        const r = /^ref\s*:\s*([<>-])\s*("?[\w.]+"?)\.("?\w+"?)/i.exec(a)
        if (r) refs.push({ from: cur.name, col: col.name!, to: ident(r[2]), op: r[1] === '<' ? '>' : r[1], attrs })
      }
    }
    cur.cols.push(col)
  }
  if (cur) warnings.push(`Table "${cur.name}" is not closed with "}".`)
  // relationships: the child column becomes a lookup to the parent
  for (const r of refs) {
    const byName = (n: string) => { const id = created.get(n.toLowerCase()); return id ? tableById(model, id) : tableByName(model, n) }
    const child = byName(r.from)
    const parent = byName(r.to)
    if (!child || !parent) { warnings.push(`Ref ${r.from}.${r.col} -> ${r.to}: table not found.`); continue }
    if (!created.has(child.name.toLowerCase())) { warnings.push(`Ref ${r.from}.${r.col}: only new tables get new lookups.`); continue }
    const col = child.columns.find((c) => c.name.toLowerCase() === r.col.toLowerCase())
    if (!col) { warnings.push(`Ref ${r.from}.${r.col}: column not found.`); continue }
    col.type = 'lookup'
    col.lookupTable = parent.name
    delete col.choices
    if (r.op === '-') col.unique = true
    const have = model.relationships.find((x) => x.fromTable === child.id && x.fromColumn === col.name)
    if (have) {
      const d = deleteOf(r.attrs)
      if (d && !(d === 'setBlank' && col.required)) have.onDelete = d
      if (r.attrs.some((a) => /no cycles/i.test(a))) have.preventCycles = true
      continue
    }
    const rel: RelationshipDef = {
      id: newRelId(), fromTable: child.id, fromColumn: col.name, toTable: parent.id,
      kind: parent.id === child.id ? 'self' : r.op === '-' ? 'oneToOne' : 'oneToMany',
      onDelete: deleteOf(r.attrs) ?? defaultDeleteBehaviour(col),
    }
    if (rel.onDelete === 'setBlank' && col.required) rel.onDelete = 'restrict'
    if (r.attrs.some((a) => /no cycles/i.test(a))) rel.preventCycles = true
    const j = r.attrs.map((a) => /^junction\s*:\s*(\S+)/i.exec(a)?.[1]).find(Boolean)
    if (j) rel.junction = { group: j }
    model.relationships.push(rel)
  }
  return { model, warnings }
}
