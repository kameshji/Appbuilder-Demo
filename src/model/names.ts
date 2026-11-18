/**
 * Identifier helpers for the model library (the same rules as the server's src/platform/values.ts toIdentifier, kept here
 * because this folder may not import platform code at run time).
 */
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const MAX_IDENT = 56
export const SYSTEM_COLUMN_NAMES = ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner']

/** "Order lines" -> "OrderLines"; never empty; never starts with a digit */
export function toIdentifier(display: string, fallback = 'Item'): string {
  const parts = display
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let s = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  if (!s) s = fallback
  if (/^[0-9]/.test(s)) s = `${fallback}${s}`
  return s.slice(0, MAX_IDENT)
}

export function uniqueIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const c = `${base.slice(0, MAX_IDENT - String(i).length)}${i}`
    if (!used.has(c.toLowerCase())) return c
  }
}

/** short random hex (ids of draft tables, relationships, areas) */
export function shortHex(n = 8): string {
  let out = ''
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto
  if (c?.getRandomValues) {
    const a = new Uint8Array(Math.ceil(n / 2))
    c.getRandomValues(a)
    for (const b of a) out += b.toString(16).padStart(2, '0')
  } else {
    for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16)
  }
  return out.slice(0, n)
}

/** "Order line" -> "Order lines" (rough English plural, for display names only) */
export function plural(s: string): string {
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + 'es'
  return s + 's'
}
