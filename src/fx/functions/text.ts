import type { FxValue } from '@/contracts'
import { fmtDateDefault, parseNumberText, toRows, toText, describe } from '../values'
import { parseDateText } from './dates'
import { formatDate, formatNumber, looksLikeDateFormat } from './format'
import { def, MANY, type FnDef } from './types'

function proper(s: string): string {
  return s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
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
]
