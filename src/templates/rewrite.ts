/**
 * Slot tokens in formulas (format.ts): found and rewritten through the formula parser (src/fx), never by text
 * replacement. A token is rewritten where it is
 *   - a free identifier                 Filter(Slot_Items, Slot_Items_Status = "Open")
 *   - a member name                     ThisItem.Slot_Items_Title, Gallery1.Selected.Slot_Items_Title
 *   - a record field name               Patch(Slot_Items, Defaults(Slot_Items), { Slot_Items_Title: "x" })
 *   - the whole of a text value, or every piece of a comma list in one      DataSource ="Slot_Items", Fields ="Slot_Items_Title, Slot_Items_Status"
 * Text values that merely contain a token among other words are left alone (and then reported as unresolved).
 *
 * A token mapped to null (an optional column or slot left out) reads Blank(): the identifier or the whole member access
 * becomes Blank(), a comma-list piece is dropped; as a record field it cannot be dropped safely and is reported.
 */
import { parse } from '../fx/parser.ts'
import { childrenOf, freeIdentifiers, type Node } from '../fx/ast.ts'
import { SLOT_PREFIX, isToken } from './format.ts'

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const fxName = (n: string): string => (IDENT_RE.test(n) ? n : `'${n.replace(/'/g, "''")}'`)
const fxString = (s: string): string => `"${s.replace(/"/g, '""')}"`

/** pieces of a text value when it is a comma list of tokens (or one token); null when it is not */
function listPieces(value: string): string[] | null {
  const pieces = value.split(',').map((x) => x.trim())
  if (!pieces.some((x) => isToken(x))) return null
  return pieces
}

interface Edit { start: number; end: number; text: string; whole?: boolean }

export interface RewriteResult {
  /** the rewritten formula (the input when nothing matched or it does not parse) */
  out: string
  /** tokens met (declared or not) */
  tokens: string[]
  /** words: what could not be rewritten */
  problems: string[]
}

/** the formula with a leading '=' (event conditions and named formulas are stored without one) */
function withEq(src: string): { text: string; shift: number } {
  return src.trimStart().startsWith('=') ? { text: src, shift: 0 } : { text: `=${src}`, shift: 1 }
}

/**
 * Rewrites the slot tokens of one formula. `map`: token -> replacement name (null: left out). Tokens absent from the
 * map are reported. A formula that does not parse is returned unchanged with a problem when it contains a token.
 */
export function rewriteFormula(src: string, map: ReadonlyMap<string, string | null>, opts: { noEq?: boolean } = {}): RewriteResult {
  if (typeof src !== 'string' || !src.includes(SLOT_PREFIX)) return { out: src, tokens: [], problems: [] }
  const { text, shift } = opts.noEq ? withEq(src) : { text: src, shift: 0 }
  const p = parse(text)
  if (!p.ast) return { out: src, tokens: [], problems: [`a formula that uses slot tokens does not parse (${p.error?.message ?? 'unknown error'}): ${src.slice(0, 80)}`] }
  const tokens = new Set<string>()
  const problems: string[] = []
  const edits: Edit[] = []
  const free = new Set(freeIdentifiers(p.ast))
  const look = (name: string): { known: boolean; to: string | null } => {
    tokens.add(name)
    if (!map.has(name)) {
      problems.push(`the slot token ${name} is not declared by the template`)
      return { known: false, to: null }
    }
    return { known: true, to: map.get(name) ?? null }
  }
  const visit = (n: Node): void => {
    switch (n.t) {
      case 'id':
        if (free.has(n) && isToken(n.name)) {
          const r = look(n.name)
          if (r.known) edits.push({ start: n.start, end: n.end, text: r.to === null ? 'Blank()' : fxName(r.to), whole: r.to === null })
        }
        break
      case 'member':
        if (isToken(n.name)) {
          const r = look(n.name)
          if (r.known) {
            if (r.to === null) edits.push({ start: n.start, end: n.end, text: 'Blank()', whole: true })
            else edits.push({ start: n.nameStart, end: n.nameEnd, text: fxName(r.to) })
          }
        }
        break
      case 'rec':
        for (const f of n.fields) {
          if (!isToken(f.name)) continue
          const r = look(f.name)
          if (!r.known) continue
          if (r.to === null) problems.push(`the column ${f.name} is written by the template, so it must be mapped`)
          else edits.push({ start: f.nameStart, end: f.nameEnd, text: fxName(r.to) })
        }
        break
      case 'str': {
        const pieces = listPieces(n.value)
        if (!pieces) {
          if (n.value.includes(SLOT_PREFIX)) problems.push(`the text "${n.value.slice(0, 60)}" mixes slot tokens with other words and cannot be rewritten`)
          break
        }
        const next: string[] = []
        let ok = true
        for (const piece of pieces) {
          if (!isToken(piece)) { next.push(piece); continue }
          const r = look(piece)
          if (!r.known) { ok = false; continue }
          if (r.to !== null) next.push(r.to)
        }
        if (ok) edits.push({ start: n.start, end: n.end, text: fxString(next.filter((x) => x !== '').join(n.value.includes(', ') ? ', ' : ',')) })
        break
      }
      default:
        break
    }
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  // a member access that becomes Blank() swallows the edits inside it
  edits.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Edit[] = []
  for (const e of edits) {
    const last = kept[kept.length - 1]
    if (last && e.start >= last.start && e.end <= last.end && last.whole) continue
    kept.push(e)
  }
  let out = text
  for (const e of [...kept].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  if (shift) out = out.slice(shift)
  // the result must still parse and hold no token
  const again = parse(opts.noEq ? withEq(out).text : out)
  if (!again.ast) problems.push(`the rewritten formula does not parse: ${out.slice(0, 80)}`)
  else if (!problems.length) {
    const left = tokensIn(opts.noEq ? withEq(out).text : out)
    if (left.length) problems.push(`slot tokens are left after binding: ${left.join(', ')}`)
  }
  return { out, tokens: [...tokens], problems: [...new Set(problems)] }
}

/** every slot token a formula mentions (identifiers, members, record fields, text values) */
export function tokensIn(src: string, opts: { noEq?: boolean } = {}): string[] {
  if (typeof src !== 'string' || !src.includes(SLOT_PREFIX)) return []
  const p = parse(opts.noEq ? withEq(src).text : src)
  if (!p.ast) return []
  const out = new Set<string>()
  const visit = (n: Node): void => {
    if (n.t === 'id' && isToken(n.name)) out.add(n.name)
    if (n.t === 'member' && isToken(n.name)) out.add(n.name)
    if (n.t === 'rec') for (const f of n.fields) if (isToken(f.name)) out.add(f.name)
    if (n.t === 'str') for (const piece of n.value.split(',').map((x) => x.trim())) if (isToken(piece)) out.add(piece)
    for (const c of childrenOf(n)) visit(c)
  }
  visit(p.ast)
  return [...out]
}
