import type { FxRecord, FxValue } from '../../contracts.ts'
import { fmtDateDefault, isRecord, parseNumberText, setField, toRows, toText, describe } from '../values.ts'
import { parseDateText } from './dates.ts'
import { formatDate, formatNumber, looksLikeDateFormat } from './format.ts'
import { def, MANY, type CallCtx, type FnDef } from './types.ts'

function proper(s: string): string {
  return s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
}

/* ---------------------------------------------------------------- regular expressions */

type Anchor = 'complete' | 'contains' | 'begins' | 'ends'

function readOptions(c: CallCtx, i: number, fallback: Anchor): { anchor: Anchor; ignoreCase: boolean; multiline: boolean } {
  const o = c.argc > i ? c.text(i).toLowerCase() : ''
  const begins = o.includes('beginswith')
  const ends = o.includes('endswith')
  let anchor: Anchor = fallback
  if (o.includes('contains')) anchor = 'contains'
  if (begins) anchor = 'begins'
  if (ends) anchor = 'ends'
  if (o.includes('complete') || (begins && ends)) anchor = 'complete'
  return { anchor, ignoreCase: o.includes('ignorecase'), multiline: o.includes('multiline') }
}

/** Which numbered capture groups of the pattern are named, in order. */
function groupNamed(pattern: string): boolean[] {
  const out: boolean[] = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') { i++; continue }
    if (inClass) { if (ch === ']') inClass = false; continue }
    if (ch === '[') { inClass = true; continue }
    if (ch !== '(') continue
    if (pattern[i + 1] !== '?') out.push(false)
    else if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') out.push(true)
  }
  return out
}

function buildRegex(c: CallCtx, patIdx: number, optIdx: number, fallback: Anchor, global: boolean): { re: RegExp; named: boolean[] } {
  const pat = c.text(patIdx)
  const o = readOptions(c, optIdx, fallback)
  const src = o.anchor === 'complete' ? `^(?:${pat})$` : o.anchor === 'begins' ? `^(?:${pat})` : o.anchor === 'ends' ? `(?:${pat})$` : pat
  const flags = (global ? 'g' : '') + (o.ignoreCase ? 'i' : '') + (o.multiline ? 'm' : '')
  let re: RegExp
  try {
    re = new RegExp(src, flags + 'u')
  } catch {
    try {
      re = new RegExp(src, flags)
    } catch (e) {
      return c.fail(patIdx, `Invalid pattern: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : pat}`)
    }
  }
  return { re, named: groupNamed(pat) }
}

function matchRecord(m: RegExpMatchArray, named: boolean[]): FxRecord {
  const rec: FxRecord = { FullMatch: m[0] ?? '', StartMatch: (m.index ?? 0) + 1 }
  const subs: FxRecord[] = []
  for (let g = 1; g < m.length; g++) if (!named[g - 1]) subs.push({ Value: m[g] ?? null })
  rec.SubMatches = subs
  if (m.groups) for (const k of Object.keys(m.groups)) setField(rec, k, m.groups[k] ?? null)
  return rec
}

/* ---------------------------------------------------------------- JSON */

function toPlain(v: FxValue): unknown {
  if (v === null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (Array.isArray(v)) return v.map(toPlain)
  if (isRecord(v)) {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) if (k !== '__id') o[k] = toPlain(v[k]!)
    return o
  }
  return v
}

function fromPlain(x: unknown): FxValue {
  if (x === null || x === undefined) return null
  if (typeof x === 'boolean' || typeof x === 'number' || typeof x === 'string') return x
  if (Array.isArray(x)) return x.map((e) => {
    const v = fromPlain(e)
    return isRecord(v) ? v : { Value: v }
  })
  const rec: FxRecord = {}
  for (const k of Object.keys(x as object)) setField(rec, k, fromPlain((x as Record<string, unknown>)[k]))
  return rec
}

export const textFns: FnDef[] = [
  def('Text', 'Text(value [, format])', 'Turns a number, date or value into text. Formats: "0.00", "#,##0", "dd/mm/yyyy", "yyyy-mm-dd", "hh:mm".', 1, 2, (c) => {
    const v = c.value(0)
    if (v === null) return ''
    if (c.argc === 1) return toText(v, c.argNode(0))
    const fmt = c.text(1)
    if (v instanceof Date) return fmt === '' ? fmtDateDefault(v) : formatDate(v, fmt)
    if (typeof v === 'number') return formatNumber(v, fmt)
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'string') {
      const n = parseNumberText(v)
      if (looksLikeDateFormat(fmt) && n === undefined) {
        const d = parseDateText(v)
        if (d) return formatDate(d, fmt)
      }
      return n !== undefined ? formatNumber(n, fmt) : v
    }
    return c.fail(0, `Text can't format ${describe(v)}`)
  }),
  def('Value', 'Value(text)', 'Turns text such as "12.5" into a number.', 1, 1, (c) => {
    const v = c.value(0)
    if (v === null) return null
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'string') {
      if (v.trim() === '') return null
      const n = parseNumberText(v)
      if (n === undefined) return c.fail(0, `Can't turn ${describe(v)} into a number`)
      return n
    }
    if (v instanceof Date) return v.getTime()
    return c.fail(0, `Can't turn ${describe(v)} into a number`)
  }),
  def('Len', 'Len(text)', 'Number of characters in the text.', 1, 1, (c) => c.text(0).length),
  def('Left', 'Left(text, count)', 'The first characters of the text.', 2, 2, (c) => c.text(0).slice(0, Math.max(0, Math.trunc(c.num(1))))),
  def('Right', 'Right(text, count)', 'The last characters of the text.', 2, 2, (c) => {
    const s = c.text(0)
    const n = Math.max(0, Math.trunc(c.num(1)))
    return n === 0 ? '' : s.slice(-n)
  }),
  def('Mid', 'Mid(text, start [, count])', 'Characters from the middle of the text. The first character is number 1.', 2, 3, (c) => {
    const s = c.text(0)
    const start = Math.max(1, Math.trunc(c.num(1)))
    if (c.argc === 2) return s.slice(start - 1)
    return s.substr(start - 1, Math.max(0, Math.trunc(c.num(2))))
  }),
  def('Lower', 'Lower(text)', 'Converts to lower case.', 1, 1, (c) => c.text(0).toLowerCase()),
  def('Upper', 'Upper(text)', 'Converts to upper case.', 1, 1, (c) => c.text(0).toUpperCase()),
  def('Proper', 'Proper(text)', 'Capitalises the first letter of every word.', 1, 1, (c) => proper(c.text(0))),
  def('Trim', 'Trim(text)', 'Removes leading, trailing and repeated spaces.', 1, 1, (c) => c.text(0).trim().replace(/\s+/g, ' ')),
  def('Concatenate', 'Concatenate(text1, text2, ...)', 'Joins texts together.', 1, MANY, (c) => {
    let s = ''
    for (let i = 0; i < c.argc; i++) s += c.text(i)
    return s
  }),
  def('Concat', 'Concat(table, formula [, separator])', 'Evaluates a formula for each row and joins the results.', 2, 3, (c) => {
    const { rows, as } = c.rows(0, 'Concat')
    const sep = c.argc > 2 ? c.text(2) : ''
    const parts = rows.map((r) => {
      const v = c.row(1, r, as)
      return toText(v, c.argNode(1))
    })
    return parts.join(sep)
  }),
  def('Substitute', 'Substitute(text, old, new [, instance])', 'Replaces text. With an instance number only that occurrence changes.', 3, 4, (c) => {
    const s = c.text(0)
    const from = c.text(1)
    const to = c.text(2)
    if (from === '') return s
    if (c.argc === 3) return s.split(from).join(to)
    const n = Math.trunc(c.num(3))
    let idx = -1
    let count = 0
    let pos = 0
    while ((pos = s.indexOf(from, pos)) >= 0) {
      count++
      if (count === n) { idx = pos; break }
      pos += from.length
    }
    return idx < 0 ? s : s.slice(0, idx) + to + s.slice(idx + from.length)
  }),
  def('Replace', 'Replace(text, start, count, new)', 'Replaces part of the text by position. The first character is number 1.', 4, 4, (c) => {
    const s = c.text(0)
    const start = Math.max(1, Math.trunc(c.num(1))) - 1
    const count = Math.max(0, Math.trunc(c.num(2)))
    return s.slice(0, start) + c.text(3) + s.slice(start + count)
  }),
  def('Find', 'Find(search, text [, start])', 'Position of the search text inside the text (first is 1). Blank when not found.', 2, 3, (c) => {
    const needle = c.text(0)
    const hay = c.text(1)
    const from = c.argc > 2 ? Math.max(1, Math.trunc(c.num(2))) - 1 : 0
    const i = hay.indexOf(needle, from)
    return i < 0 ? null : i + 1
  }),
  def('StartsWith', 'StartsWith(text, start)', 'True when the text begins with the other text (ignores case).', 2, 2, (c) => c.text(0).toLowerCase().startsWith(c.text(1).toLowerCase())),
  def('EndsWith', 'EndsWith(text, end)', 'True when the text ends with the other text (ignores case).', 2, 2, (c) => c.text(0).toLowerCase().endsWith(c.text(1).toLowerCase())),
  def('Split', 'Split(text, separator)', 'Splits text into a table with one row per piece.', 2, 2, (c) => {
    const s = c.text(0)
    const sep = c.text(1)
    const parts: FxValue[] = sep === '' ? Array.from(s) : s.split(sep)
    return toRows(parts)
  }),
  def('TrimEnds', 'TrimEnds(text)', 'Removes spaces from the start and end only.', 1, 1, (c) => c.text(0).trim()),
  def('Char', 'Char(code)', 'The character for a code from 1 to 255.', 1, 1, (c) => {
    const n = Math.trunc(c.num(0))
    if (n < 1 || n > 255) return c.fail(0, 'Char needs a number from 1 to 255')
    return String.fromCharCode(n)
  }),
  def('UniChar', 'UniChar(code)', 'The Unicode character for a code point.', 1, 1, (c) => {
    const n = Math.trunc(c.num(0))
    if (n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return c.fail(0, "That isn't a valid Unicode character code")
    return String.fromCodePoint(n)
  }),
  def('EncodeUrl', 'EncodeUrl(text)', 'Makes text safe to put in a web address.', 1, 1, (c) => encodeURIComponent(c.text(0))),
  def('PlainText', 'PlainText(html)', 'Removes HTML tags and turns entities such as &amp; into characters.', 1, 1, (c) =>
    c.text(0)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&')),
  def('IsMatch', 'IsMatch(text, pattern [, options])', 'True when the whole text matches the pattern (a regular expression). Options: MatchOptions.Contains, BeginsWith, EndsWith, IgnoreCase, Multiline.', 2, 3, (c) => {
    const text = c.text(0)
    const { re } = buildRegex(c, 1, 2, 'complete', false)
    return re.test(text)
  }),
  def('Match', 'Match(text, pattern [, options])', 'The first match as a record with FullMatch, StartMatch, SubMatches and named groups. Blank when nothing matches.', 2, 3, (c) => {
    const text = c.text(0)
    const { re, named } = buildRegex(c, 1, 2, 'contains', false)
    const m = re.exec(text)
    return m ? matchRecord(m, named) : null
  }),
  def('MatchAll', 'MatchAll(text, pattern [, options])', 'Every match as a table of records (FullMatch, StartMatch, SubMatches, named groups).', 2, 3, (c) => {
    const text = c.text(0)
    const { re, named } = buildRegex(c, 1, 2, 'contains', true)
    const out: FxRecord[] = []
    for (const m of text.matchAll(re)) {
      out.push(matchRecord(m, named))
      if (out.length >= 10000) break
    }
    return out
  }),
  def('JSON', 'JSON(value [, indent])', 'Turns a value, record or table into JSON text. Indent is a number of spaces.', 1, 2, (c) => {
    const v = c.value(0)
    let indent: number | string | undefined
    if (c.argc > 1) {
      const iv = c.value(1)
      indent = typeof iv === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(iv) ? iv.slice(0, 10) : Math.min(10, Math.max(0, Math.trunc(c.num(1))))
    }
    const out = JSON.stringify(toPlain(v), null, indent)
    return out === undefined ? 'null' : out
  }),
  def('ParseJSON', 'ParseJSON(text)', 'Reads JSON text into a record, a table or a single value.', 1, 1, (c) => {
    const t = c.text(0)
    if (t.trim() === '') return null
    try {
      return fromPlain(JSON.parse(t))
    } catch (e) {
      return c.fail(0, `That isn't valid JSON: ${e instanceof Error ? e.message : 'unreadable'}`)
    }
  }),
]
