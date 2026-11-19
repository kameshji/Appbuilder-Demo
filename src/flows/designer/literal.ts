/**
 * Every field of a step is a formula, but most values a maker types are plain: a text with some dynamic content in it,
 * a number, yes/no, a date, a choice, a row of a lookup. These helpers turn such a value into the formula the runtime
 * reads and back: text is a string literal, or an interpolated string `$"Hello {Trigger.Record.Title}"` when it holds
 * dynamic content. A formula of any other shape is shown as a formula. Pure.
 */
import { parse } from '@/fx/parser'

export type LiteralKind = 'text' | 'number' | 'boolean' | 'date' | 'choice' | 'lookup'

const body = (fx: string): string => fx.trim().replace(/^=/, '').trim()

/** the text a maker sees for a text value ({token} marks dynamic content), or null when it is a formula */
export function textOf(fx: string | undefined): string | null {
  const t = body(fx ?? '')
  if (!t) return ''
  const src = `=${t}`
  const p = parse(src)
  if (!p.ast || p.ast.end !== src.length) return null
  if (p.ast.t === 'str') return p.ast.value
  if (p.ast.t === 'interp' && src.startsWith('=$"')) {
    // the source between $" and the closing quote: "" back to " outside the {holes} (code inside holes is kept)
    return mapOutsideHoles(src.slice(3, -1), (x) => x.replace(/""/g, '"'))
  }
  return null
}

/** the formula for a text with {token} dynamic content */
export function textFx(text: string): string {
  if (!text) return ''
  const hasToken = /(^|[^{])\{[^{}]+\}/.test(text)
  return hasToken ? `$"${mapOutsideHoles(text, (x) => x.replace(/"/g, '""'))}"` : `"${text.replace(/"/g, '""')}"`
}

/** applies fn to the text outside {holes} ({{ and }} are literal braces) */
function mapOutsideHoles(t: string, fn: (s: string) => string): string {
  let out = ''
  let buf = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if ((c === '{' || c === '}') && t[i + 1] === c) { buf += c + c; i++; continue }
    if (c === '{') {
      out += fn(buf)
      buf = ''
      // a hole: up to the matching }, strings inside kept as they are
      let depth = 1
      let j = i + 1
      let inStr = false
      for (; j < t.length && depth; j++) {
        if (t[j] === '"') inStr = !inStr
        else if (!inStr && t[j] === '{') depth++
        else if (!inStr && t[j] === '}') depth--
      }
      out += t.slice(i, j)
      i = j - 1
      continue
    }
    buf += c
  }
  return out + fn(buf)
}

export function numberOf(fx: string | undefined): string | null {
  const t = body(fx ?? '')
  if (!t) return ''
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null
}

export function booleanOf(fx: string | undefined): boolean | null {
  const t = body(fx ?? '').toLowerCase()
  return t === 'true' ? true : t === 'false' ? false : null
}

/** Date(2026, 3, 1) <-> "2026-03-01" */
export function dateOf(fx: string | undefined): string | null {
  const t = body(fx ?? '')
  if (!t) return ''
  const m = /^Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/.exec(t)
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null
}
export function dateFx(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `Date(${m[1]}, ${Number(m[2])}, ${Number(m[3])})` : ''
}

/** the literal form of a value for a field kind, or null (show the formula) */
export function literalOf(kind: LiteralKind, fx: string | undefined): string | boolean | null {
  switch (kind) {
    case 'number': return numberOf(fx)
    case 'boolean': return body(fx ?? '') === '' ? '' : booleanOf(fx)
    case 'date': return dateOf(fx)
    case 'choice': case 'lookup': {
      const t = textOf(fx)
      return t !== null && !t.includes('{') ? t : null
    }
    default: return textOf(fx)
  }
}

export function literalFx(kind: LiteralKind, v: string | boolean): string {
  switch (kind) {
    case 'number': return String(v).trim()
    case 'boolean': return v === '' ? '' : v ? 'true' : 'false'
    case 'date': return dateFx(String(v))
    case 'choice': case 'lookup': return v === '' ? '' : `"${String(v).replace(/"/g, '""')}"`
    default: return textFx(String(v))
  }
}
