import type { FxDiagnostic, FxNamedFormula } from '@/contracts'
import { ENUM_RECORDS } from './enums'
import { isBuiltinFunction } from './functions'
import { ParseError, readInterp, readString } from './lexer'
import { parse } from './parser'
import { hasOwn } from './values'

const IDENT_CHAR = /[\p{L}\p{N}_]/u

function isIdStart(ch: string): boolean { return /[\p{L}_]/u.test(ch) }

/** Skips whitespace, // comments and block comments. */
function skipTrivia(src: string, from: number): number {
  let i = from
  while (i < src.length) {
    const ch = src[i]!
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }
    break
  }
  return i
}

/** A name: identifier or 'quoted name'. */
function readName(src: string, from: number): { name: string; end: number } | null {
  const ch = src[from]
  if (ch === undefined) return null
  if (ch === "'") {
    let i = from + 1
    let text = ''
    while (i < src.length) {
      if (src[i] === "'") {
        if (src[i + 1] === "'") { text += "'"; i += 2; continue }
        return text === '' ? null : { name: text, end: i + 1 }
      }
      text += src[i]
      i++
    }
    return null
  }
  if (!isIdStart(ch)) return null
  let i = from + 1
  while (i < src.length && IDENT_CHAR.test(src[i]!)) i++
  return { name: src.slice(from, i), end: i }
}

/** Index of the `;` that ends the definition starting at `from`, or src.length. */
function findEnd(src: string, from: number): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '"') {
      try { i = readString(src, i, src.length).end } catch (e) { if (e instanceof ParseError) return src.length; throw e }
      continue
    }
    if (ch === '$' && src[i + 1] === '"') {
      try { i = readInterp(src, i, src.length).end } catch (e) { if (e instanceof ParseError) return src.length; throw e }
      continue
    }
    if (ch === "'") {
      i++
      while (i < src.length) {
        if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue } break }
        i++
      }
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) return i
    i++
  }
  return src.length
}

function readType(src: string, from: number): { type: string; end: number } | null {
  let i = from
  while (i < src.length && /[\p{L}\p{N}_.]/u.test(src[i]!)) i++
  return i === from ? null : { type: src.slice(from, i), end: i }
}

/**
 * "Name = expr; Other = expr;" and "Area(w: Number, h: Number): Number = w * h;".
 * Error offsets are positions in `source`.
 */
export function parseNamedFormulas(source: string): { items: FxNamedFormula[]; errors: FxDiagnostic[] } {
  const items: FxNamedFormula[] = []
  const errors: FxDiagnostic[] = []
  const seen = new Set<string>()
  const bad = (message: string, start: number, end: number): void => {
    errors.push({ message, start, end: Math.max(end, start + 1) })
  }
  let pos = 0
  for (;;) {
    pos = skipTrivia(source, pos)
    while (source[pos] === ';') pos = skipTrivia(source, pos + 1)
    if (pos >= source.length) break
    const defStart = pos
    const recover = (): void => {
      const e = findEnd(source, defStart)
      pos = e + 1
    }
    const nm = readName(source, pos)
    if (!nm) { bad('A name is needed here, like Total = Sum(Orders, Amount);', pos, pos + 1); recover(); continue }
    let p = skipTrivia(source, nm.end)
    let params: { name: string; type: string }[] | undefined
    let returnType: string | undefined
    let headOk = true
    if (source[p] === '(') {
      params = []
      p = skipTrivia(source, p + 1)
      if (source[p] === ')') {
        p++
      } else {
        for (;;) {
          const pn = readName(source, p)
          if (!pn) { bad('A parameter name is needed here, like (w: Number)', p, p + 1); headOk = false; break }
          if (params.some((x) => x.name === pn.name)) { bad(`Parameter ${pn.name} is used twice`, p, pn.end); headOk = false; break }
          p = skipTrivia(source, pn.end)
          if (source[p] !== ':') { bad(`${pn.name} needs a type, like ${pn.name}: Number`, p, p + 1); headOk = false; break }
          p = skipTrivia(source, p + 1)
          const ty = readType(source, p)
          if (!ty) { bad(`${pn.name} needs a type, like ${pn.name}: Number`, p, p + 1); headOk = false; break }
          params.push({ name: pn.name, type: ty.type })
          p = skipTrivia(source, ty.end)
          if (source[p] === ',') { p = skipTrivia(source, p + 1); continue }
          if (source[p] === ')') { p++; break }
          bad('Expected , or ) after the parameter type', p, p + 1)
          headOk = false
          break
        }
      }
      if (headOk) {
        p = skipTrivia(source, p)
        if (source[p] === ':') {
          p = skipTrivia(source, p + 1)
          const ty = readType(source, p)
          if (!ty) { bad('A return type is needed after the colon, like : Number', p, p + 1); headOk = false } else { returnType = ty.type; p = skipTrivia(source, ty.end) }
        }
      }
    }
    if (headOk && source[p] !== '=') {
      bad(`Expected = after ${nm.name}`, p, p + 1)
      headOk = false
    }
    if (!headOk) { recover(); continue }
    const bodyFrom = p + 1
    const end = findEnd(source, bodyFrom)
    pos = end + 1
    const raw = source.slice(bodyFrom, end)
    const lead = raw.length - raw.trimStart().length
    const body = raw.trim()
    const nameEnd = nm.end
    if (body === '') { bad(`${nm.name} needs a formula after =`, defStart, nameEnd); continue }
    if (seen.has(nm.name)) { bad(`${nm.name} is already defined`, defStart, nameEnd); continue }
    // built-ins only: the user functions currently registered may belong to another app (several apps can be mounted)
    if (params && isBuiltinFunction(nm.name)) { bad(`${nm.name} is already a built-in function`, defStart, nameEnd); continue }
    if (!params && hasOwn(ENUM_RECORDS, nm.name)) { bad(`${nm.name} is already a built-in list of values`, defStart, nameEnd); continue }
    const formula = '=' + body
    const parsed = parse(formula)
    if (parsed.error) {
      const base = bodyFrom + lead
      const s = Math.max(base, base + parsed.error.start - 1)
      bad(parsed.error.message, s, Math.max(s + 1, base + parsed.error.end - 1))
      continue
    }
    seen.add(nm.name)
    const item: FxNamedFormula = { name: nm.name, formula }
    if (params) item.params = params
    if (returnType) item.returnType = returnType
    items.push(item)
  }
  return { items, errors }
}
