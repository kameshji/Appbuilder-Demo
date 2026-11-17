import type { FxDiagnostic } from '@/contracts'
import type { BinOp, Node, RecField } from './ast'
import { lex, ParseError, type Token } from './lexer'

export interface ParseResult {
  /** null when the formula is just '=' */
  ast: Node | null
  error: FxDiagnostic | null
}

const BIN: Record<string, { op: BinOp; bp: number }> = {
  '||': { op: '||', bp: 1 },
  '&&': { op: '&&', bp: 2 },
  '=': { op: '=', bp: 3 }, '<>': { op: '<>', bp: 3 }, '<': { op: '<', bp: 3 }, '>': { op: '>', bp: 3 },
  '<=': { op: '<=', bp: 3 }, '>=': { op: '>=', bp: 3 },
  '&': { op: '&', bp: 4 },
  '+': { op: '+', bp: 5 }, '-': { op: '-', bp: 5 },
  '*': { op: '*', bp: 6 }, '/': { op: '/', bp: 6 },
  '^': { op: '^', bp: 7 },
}
const WORD_BIN: Record<string, { op: BinOp; bp: number }> = {
  or: { op: '||', bp: 1 },
  and: { op: '&&', bp: 2 },
  in: { op: 'in', bp: 3 },
  exactin: { op: 'exactin', bp: 3 },
}
const UNARY_BP = 8

class Parser {
  private i = 0
  constructor(private src: string, private toks: Token[]) {}

  private peek(o = 0): Token { return this.toks[Math.min(this.i + o, this.toks.length - 1)]! }
  private next(): Token { const t = this.peek(); if (this.i < this.toks.length - 1) this.i++; return t }
  private isOp(v: string, o = 0): boolean { const t = this.peek(o); return t.k === 'op' && t.v === v }

  private err(message: string, t: Token): never {
    if (t.k === 'eof') {
      const end = Math.max(t.start, 1)
      throw new ParseError(message, Math.max(0, end - 1), end)
    }
    throw new ParseError(message, t.start, t.end)
  }

  private describe(t: Token): string {
    if (t.k === 'eof') return 'the end of the formula'
    return this.src.slice(t.start, t.end)
  }

  private unexpected(t: Token): never {
    if (t.k === 'id' && !t.quoted) {
      const w = String(t.v).toLowerCase()
      if (w === 'as') this.err('"As" goes after a table inside a function, like Filter(Contacts As c, ...)', t)
    }
    if (t.k === 'op' && t.v === '=') this.err('Unexpected =. Use a single = to compare values', t)
    if (t.k === 'eof') this.err('The formula ends too early: a value is missing', t)
    this.err(`Unexpected ${this.describe(t)}`, t)
  }

  private expectOp(v: string): Token {
    const t = this.peek()
    if (t.k === 'op' && t.v === v) return this.next()
    if (t.k === 'eof') this.err(`Missing ${v}`, t)
    this.err(`Expected ${v} but found ${this.describe(t)}`, t)
  }

  parseTop(): Node | null {
    if (this.peek().k === 'eof') return null
    const n = this.parseChain()
    const t = this.peek()
    if (t.k !== 'eof') {
      if (t.k === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) this.err(`Unexpected ${t.v}: nothing is open to close`, t)
      if (t.k === 'id' && !t.quoted) this.err(`Unexpected ${this.describe(t)}. Put an operator or comma before it`, t)
      this.unexpected(t)
    }
    return n
  }

  private parseChain(): Node {
    const first = this.parseExpr(0)
    if (!this.isOp(';')) return first
    const items = [first]
    while (this.isOp(';')) {
      this.next()
      const t = this.peek()
      if (t.k === 'eof' || (t.k === 'op' && (t.v === ')' || t.v === ']' || t.v === '}' || t.v === ','))) break
      items.push(this.parseExpr(0))
    }
    return { t: 'chain', items, start: first.start, end: items[items.length - 1]!.end }
  }

  private binInfo(t: Token): { op: BinOp; bp: number } | undefined {
    if (t.k === 'op') return BIN[t.v as string]
    if (t.k === 'id' && !t.quoted) return WORD_BIN[(t.v as string).toLowerCase()]
    return undefined
  }

  private parseExpr(minBp: number): Node {
    let left = this.parsePrefix()
    for (;;) {
      const t = this.peek()
      const info = this.binInfo(t)
      if (!info || info.bp < minBp) break
      this.next()
      const right = this.parseExpr(info.bp + 1)
      left = { t: 'bin', op: info.op, left, right, start: left.start, end: right.end }
    }
    return left
  }

  private parsePrefix(): Node {
    const t = this.peek()
    if (t.k === 'op' && (t.v === '-' || t.v === '!')) {
      this.next()
      const arg = this.parseExpr(UNARY_BP)
      return { t: 'unary', op: t.v as '-' | '!', arg, start: t.start, end: arg.end }
    }
    if (t.k === 'op' && t.v === '+') {
      this.next()
      return this.parseExpr(UNARY_BP)
    }
    if (t.k === 'id' && !t.quoted && String(t.v).toLowerCase() === 'not' && !this.isOp('(', 1)) {
      this.next()
      const arg = this.parseExpr(UNARY_BP)
      return { t: 'unary', op: '!', arg, start: t.start, end: arg.end }
    }
    return this.parsePostfix()
  }

  private parsePostfix(): Node {
    let n = this.parsePrimary()
    for (;;) {
      if (this.isOp('.')) {
        this.next()
        const nt = this.peek()
        if (nt.k !== 'id') this.err('A field name is needed after the dot', nt)
        this.next()
        n = { t: 'member', obj: n, name: nt.v as string, nameStart: nt.start, nameEnd: nt.end, start: n.start, end: nt.end }
      } else if (this.isOp('%')) {
        const pt = this.next()
        n = { t: 'pct', arg: n, start: n.start, end: pt.end }
      } else break
    }
    return n
  }

  private parseArg(): Node {
    const e = this.parseChain()
    const t = this.peek()
    if (t.k === 'id' && !t.quoted && String(t.v).toLowerCase() === 'as') {
      const nt = this.peek(1)
      if (nt.k === 'id') {
        this.next()
        this.next()
        return { t: 'as', expr: e, name: nt.v as string, nameStart: nt.start, nameEnd: nt.end, start: e.start, end: nt.end }
      }
      this.err('A name is needed after As', nt)
    }
    return e
  }

  private parsePrimary(): Node {
    const t = this.peek()
    switch (t.k) {
      case 'num':
        this.next()
        return { t: 'num', value: t.v as number, start: t.start, end: t.end }
      case 'str':
        this.next()
        return { t: 'str', value: t.v as string, start: t.start, end: t.end }
      case 'interp': {
        this.next()
        const parts = (t.parts ?? []).map((p) => {
          if (typeof p === 'string') return p
          if (this.src.slice(p.start, p.end).trim() === '') throw new ParseError('Empty {} in text: put a formula between the braces', p.start - 1, p.end + 1)
          const sub = new Parser(this.src, lex(this.src, p.start, p.end))
          const n = sub.parseChain()
          const rest = sub.peek()
          if (rest.k !== 'eof') sub.unexpected(rest)
          return n
        })
        return { t: 'interp', parts, start: t.start, end: t.end }
      }
      case 'id': {
        if (!t.quoted) {
          const lower = (t.v as string).toLowerCase()
          if (lower === 'true' || lower === 'false') {
            this.next()
            return { t: 'bool', value: lower === 'true', start: t.start, end: t.end }
          }
          if (this.isOp('(', 1)) {
            this.next()
            this.next()
            const args: Node[] = []
            if (!this.isOp(')')) {
              for (;;) {
                args.push(this.parseArg())
                if (this.isOp(',')) { this.next(); continue }
                break
              }
            }
            const close = this.expectOp(')')
            return { t: 'call', name: t.v as string, nameStart: t.start, nameEnd: t.end, args, start: t.start, end: close.end }
          }
        }
        this.next()
        return { t: 'id', name: t.v as string, start: t.start, end: t.end }
      }
      case 'op': {
        if (t.v === '(') {
          this.next()
          const inner = this.parseChain()
          this.expectOp(')')
          return inner
        }
        if (t.v === '{') return this.parseRecord()
        if (t.v === '[') {
          this.next()
          const items: Node[] = []
          if (!this.isOp(']')) {
            for (;;) {
              items.push(this.parseChain())
              if (this.isOp(',')) { this.next(); if (this.isOp(']')) break; continue }
              break
            }
          }
          const close = this.expectOp(']')
          return { t: 'tab', items, start: t.start, end: close.end }
        }
        return this.unexpected(t)
      }
      default:
        return this.unexpected(t)
    }
  }

  private parseRecord(): Node {
    const open = this.next()
    const fields: RecField[] = []
    if (!this.isOp('}')) {
      for (;;) {
        const k = this.peek()
        if (k.k !== 'id' && k.k !== 'str') this.err('A field name is needed here, like {Name: "Asha"}', k)
        this.next()
        this.expectOp(':')
        const value = this.parseChain()
        fields.push({ name: k.v as string, nameStart: k.start, nameEnd: k.end, value })
        if (this.isOp(',')) { this.next(); if (this.isOp('}')) break; continue }
        break
      }
    }
    const close = this.expectOp('}')
    return { t: 'rec', fields, start: open.start, end: close.end }
  }
}

const CACHE = new Map<string, ParseResult>()
const CACHE_MAX = 4000

export function parse(source: string): ParseResult {
  const hit = CACHE.get(source)
  if (hit) return hit
  const res = parseUncached(source)
  if (CACHE.size >= CACHE_MAX) CACHE.clear()
  CACHE.set(source, res)
  return res
}

function parseUncached(source: string): ParseResult {
  try {
    let lead = 0
    while (lead < source.length && /\s/.test(source[lead]!)) lead++
    if (source[lead] !== '=') {
      return { ast: null, error: { message: 'A formula must start with =', start: 0, end: Math.max(1, Math.min(source.length, 1)) } }
    }
    const toks = lex(source, lead + 1, source.length)
    const ast = new Parser(source, toks).parseTop()
    return { ast, error: null }
  } catch (e) {
    if (e instanceof ParseError) return { ast: null, error: { message: e.message, start: e.start, end: e.end } }
    return { ast: null, error: { message: 'This formula could not be read', start: 0, end: source.length } }
  }
}
