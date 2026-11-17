export interface InterpHole { start: number; end: number }
export type InterpPart = string | InterpHole

export interface Token {
  k: 'num' | 'str' | 'interp' | 'id' | 'op' | 'eof'
  /** number for num; decoded text for str/id/op */
  v: string | number
  start: number
  end: number
  quoted?: boolean
  parts?: InterpPart[]
}

export class ParseError extends Error {
  start: number
  end: number
  constructor(message: string, start: number, end: number) {
    super(message)
    this.start = start
    this.end = end
  }
}

const TWO = new Set(['<>', '<=', '>=', '&&', '||'])
const ONE = new Set('+-*/^&=<>!%(){}[],;:.'.split(''))

function isIdStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || (ch > '\x7f' && /\p{L}/u.test(ch))
}
function isIdPart(ch: string): boolean {
  return isIdStart(ch) || (ch >= '0' && ch <= '9')
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/** Lex src[from, to). Offsets in tokens are absolute offsets into src. */
export function lex(src: string, from: number, to: number): Token[] {
  const toks: Token[] = []
  let i = from
  while (i < to) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ') { i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < to && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      if (close < 0 || close + 2 > to) throw new ParseError('Comment is missing its closing */', i, Math.min(to, i + 2))
      i = close + 2
      continue
    }
    const start = i
    if (isDigit(ch)) {
      i++
      while (i < to && isDigit(src[i]!)) i++
      if (src[i] === '.' && i + 1 < to && isDigit(src[i + 1]!)) {
        i++
        while (i < to && isDigit(src[i]!)) i++
      }
      if ((src[i] === 'e' || src[i] === 'E') && i < to) {
        let j = i + 1
        if (src[j] === '+' || src[j] === '-') j++
        if (j < to && isDigit(src[j]!)) {
          while (j < to && isDigit(src[j]!)) j++
          i = j
        }
      }
      toks.push({ k: 'num', v: Number(src.slice(start, i)), start, end: i })
      continue
    }
    if (ch === '"') {
      const r = readString(src, i, to)
      toks.push({ k: 'str', v: r.text, start, end: r.end })
      i = r.end
      continue
    }
    if (ch === '$' && src[i + 1] === '"') {
      const r = readInterp(src, i, to)
      toks.push({ k: 'interp', v: '', start, end: r.end, parts: r.parts })
      i = r.end
      continue
    }
    if (ch === "'") {
      let text = ''
      i++
      let closed = false
      while (i < to) {
        if (src[i] === "'") {
          if (src[i + 1] === "'" && i + 1 < to) { text += "'"; i += 2; continue }
          closed = true
          i++
          break
        }
        text += src[i]
        i++
      }
      if (!closed) throw new ParseError("Name is missing its closing '", start, to)
      if (text === '') throw new ParseError('Name between quotes is empty', start, i)
      toks.push({ k: 'id', v: text, start, end: i, quoted: true })
      continue
    }
    if (isIdStart(ch)) {
      i++
      while (i < to && isIdPart(src[i]!)) i++
      toks.push({ k: 'id', v: src.slice(start, i), start, end: i })
      continue
    }
    const two = src.slice(i, i + 2)
    if (i + 2 <= to && TWO.has(two)) {
      toks.push({ k: 'op', v: two, start, end: i + 2 })
      i += 2
      continue
    }
    if (ONE.has(ch)) {
      toks.push({ k: 'op', v: ch, start, end: i + 1 })
      i++
      continue
    }
    throw new ParseError(`Unexpected character: ${ch}`, i, i + 1)
  }
  toks.push({ k: 'eof', v: '', start: to, end: to })
  return toks
}

export function readString(src: string, open: number, to: number): { text: string; end: number } {
  let i = open + 1
  let text = ''
  while (i < to) {
    const c = src[i]!
    if (c === '"') {
      if (src[i + 1] === '"' && i + 1 < to) { text += '"'; i += 2; continue }
      return { text, end: i + 1 }
    }
    text += c
    i++
  }
  throw new ParseError('Text is missing its closing quote', open, to)
}

export function readInterp(src: string, open: number, to: number): { parts: InterpPart[]; end: number } {
  // open points at '$', src[open+1] is the opening quote
  let i = open + 2
  const parts: InterpPart[] = []
  let text = ''
  while (i < to) {
    const c = src[i]!
    if (c === '"') {
      if (src[i + 1] === '"' && i + 1 < to) { text += '"'; i += 2; continue }
      if (text) parts.push(text)
      return { parts, end: i + 1 }
    }
    if (c === '{') {
      if (src[i + 1] === '{') { text += '{'; i += 2; continue }
      const holeStart = i + 1
      let depth = 1
      let j = holeStart
      while (j < to && depth > 0) {
        const d = src[j]!
        if (d === '"') {
          j = readString(src, j, to).end
          continue
        }
        if (d === '{') depth++
        else if (d === '}') {
          depth--
          if (depth === 0) break
        }
        j++
      }
      if (depth > 0) throw new ParseError('Missing } in text', i, to)
      if (text) { parts.push(text); text = '' }
      parts.push({ start: holeStart, end: j })
      i = j + 1
      continue
    }
    if (c === '}' && src[i + 1] === '}') { text += '}'; i += 2; continue }
    text += c
    i++
  }
  throw new ParseError('Text is missing its closing quote', open, to)
}
