/**
 * Auto apps (P2 package D): names and formula text. Shared-code style: no React, no DOM, relative imports with `.ts`.
 *
 * - `ident(name)`: a name as formula text, quoted ('...') when it is a word of the formula language (`In`, `And`, `true`)
 *   or not a plain identifier.
 * - `str(text)`: a text literal ("...", with doubled quotes).
 * - `Names`: readable, unique names for screens, UI components and variables, never equal (ignoring case) to a table,
 *   a built-in enum or a reserved word, so a formula can never pick the wrong thing up.
 */
import { ENUM_RECORDS } from '../fx/enums.ts'

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** words the parser reads as operators or literals when they are not quoted */
const KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not', 'in', 'exactin', 'as'])
/** names the formula engine resolves before UI components, tables and variables */
const RESERVED = ['ThisItem', 'ThisRecord', 'Self', 'Parent', 'App', 'Host', 'Screen', 'User']

export function needsQuotes(name: string): boolean {
  return !PLAIN.test(name) || KEYWORDS.has(name.toLowerCase())
}

/** a name (table, column, UI component) as it must be written in a formula */
export function ident(name: string): string {
  return needsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name
}

/** a text literal */
export function str(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

/** a column of a record: `rec.Col` / `rec.'In'` */
export const member = (rec: string, col: string) => `${rec}.${ident(col)}`

/** is this a built-in enum name (Color, Icon, Align ...)? A table with such a name can't be read by formulas. */
export function isEnumName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENUM_RECORDS, name)
}

/** "Sales orders (2024)" / "sales_orders" -> "SalesOrders2024" / "Sales_orders", at most `max` characters, never empty */
export function stemOf(tableName: string, max = 24): string {
  let s = tableName.replace(/[^A-Za-z0-9_]/g, '')
  if (!s) s = 'Table'
  if (/^[0-9]/.test(s)) s = 'T' + s
  s = s.charAt(0).toUpperCase() + s.slice(1)
  if (s.length > max) s = s.slice(0, max).replace(/_+$/, '')
  return s
}

/** a header or label safe inside a "Field:Header, ..." list (no commas or colons) */
export const listHeader = (text: string) => text.replace(/[,:]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Unique names, case-insensitively, across everything an app defines. */
export class Names {
  private taken = new Set<string>()
  constructor(reserved: Iterable<string> = []) {
    for (const r of [...RESERVED, ...Object.keys(ENUM_RECORDS), ...KEYWORDS]) this.taken.add(r.toLowerCase())
    for (const r of reserved) this.taken.add(r.toLowerCase())
  }
  /** `base` when free, else base2, base3 ... */
  take(base: string): string {
    let b = PLAIN.test(base) ? base : base.replace(/[^A-Za-z0-9_]/g, '') || 'Item'
    if (/^[0-9]/.test(b)) b = 'N' + b
    let n = b
    for (let i = 2; this.taken.has(n.toLowerCase()) || KEYWORDS.has(n.toLowerCase()); i++) n = `${b}${i}`
    this.taken.add(n.toLowerCase())
    return n
  }
  has(name: string): boolean {
    return this.taken.has(name.toLowerCase())
  }
}
