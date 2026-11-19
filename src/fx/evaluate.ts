import type { FxHost, FxRecord, FxResult, FxScope, FxValue } from '../contracts.ts'
import type { BinaryNode, CallNode, IdNode, MemberNode, Node } from './ast.ts'
import { ENUM_RECORDS, ENUM_SET } from './enums.ts'
import { FxError, fail, type Span } from './errors.ts'
import { BUILTIN_TABLE, type FunctionTable } from './functions/index.ts'
import { addDays } from './functions/dates.ts'
import { NOT_PURE, type CallCtx, type Session } from './functions/types.ts'
import { parse } from './parser.ts'
import { compareValues, describe, hasOwn, isRecord, looseEq, setField, toBool, toNumber, toRows, toText } from './values.ts'

interface Frame {
  parent: Frame | null
  record: FxRecord
  as?: string
  /** record fields are visible but ThisRecord is not changed */
  noThis?: boolean
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth']

export function arityMessage(name: string, min: number, max: number, got: number): string | null {
  if (got < min) {
    return max === min ? `${name} needs ${min} argument${min === 1 ? '' : 's'}` : `${name} needs at least ${min} argument${min === 1 ? '' : 's'}`
  }
  if (got > max) {
    return max === 0 ? `${name} doesn't take any arguments` : `${name} takes at most ${max} argument${max === 1 ? '' : 's'}`
  }
  return null
}

export function unknownFunctionMessage(name: string, fns: FunctionTable = BUILTIN_TABLE): string {
  const s = fns.suggest(name)
  return s ? `Did you mean ${s.name}?` : `Function isn't recognised: ${name}`
}

/**
 * P1-E security: a time budget for one evaluation, set by the server (flows, table events, reports run in the one
 * server process: a formula that loops over millions of rows must not stall it for everyone). 0: no budget (the
 * browser). Checked every 65,536 evaluation steps, so it costs nothing measurable.
 */
let evaluationBudgetMs = 0
export function setEvaluationBudget(ms: number): void { evaluationBudgetMs = Math.max(0, ms) }
/** rows (x16) plus characters built by one evaluation on the server: about 50 MB of text or 3 million rows */
export const EVALUATION_MAX_CELLS = 50_000_000

class Evaluator {
  session: Session
  host: FxHost | undefined
  fns: FunctionTable
  private deadline: number
  private ops = 0
  private cells = 0

  constructor(scope: FxScope, host: FxHost | undefined, fns: FunctionTable) {
    this.deadline = evaluationBudgetMs ? Date.now() + evaluationBudgetMs : 0
    this.host = host
    this.fns = fns
    this.session = { scope, host, vars: new Map(), colls: new Map(), depth: 0 }
  }

  run(n: Node): FxValue {
    return this.eval(n, null)
  }

  eval(n: Node, env: Frame | null): FxValue {
    if (this.deadline && (++this.ops & 0xffff) === 0 && Date.now() > this.deadline) throw new RangeError('budget: the formula ran longer than its time budget and was stopped')
    switch (n.t) {
      case 'num': return n.value
      case 'str': return n.value
      case 'bool': return n.value
      case 'id': return this.lookup(n, env)
      case 'member': return this.member(n, env)
      case 'call': return this.call(n, env)
      case 'unary': {
        const v = this.eval(n.arg, env)
        if (n.op === '!') return !toBool(v, n.arg)
        return 0 - toNumber(v, n.arg)
      }
      case 'pct': return toNumber(this.eval(n.arg, env), n.arg) / 100
      case 'bin': return this.binary(n, env)
      case 'chain': {
        if (!this.host) fail(n, 'Chaining with ; only works in behaviour properties such as OnSelect', true)
        let last: FxValue = null
        for (const it of n.items) last = this.eval(it, env)
        return last
      }
      case 'rec': {
        const out: FxRecord = {}
        for (const f of n.fields) setField(out, f.name, this.eval(f.value, env))
        return out
      }
      case 'tab': {
        const out: FxValue[] = []
        for (const it of n.items) {
          const v = this.eval(it, env)
          out.push(isRecord(v) ? v : { Value: v })
        }
        return out
      }
      case 'interp': {
        let s = ''
        for (const p of n.parts) s += typeof p === 'string' ? p : toText(this.eval(p, env), p)
        return s
      }
      case 'as':
        return fail(n, 'As goes after a table inside a function, like Filter(Contacts As c, ...)', true)
    }
  }

  private lookup(n: IdNode, env: Frame | null): FxValue {
    const name = n.name
    for (let f = env; f; f = f.parent) if (hasOwn(f.record, name)) return f.record[name]!
    if (name === 'ThisRecord') {
      for (let f = env; f; f = f.parent) if (!f.noThis) return f.record
    }
    for (let f = env; f; f = f.parent) if (f.as === name) return f.record
    if (hasOwn(ENUM_RECORDS, name)) return ENUM_RECORDS[name]!
    const sv = this.session.vars.get(name)
    if (sv !== undefined) return sv
    const sc = this.session.colls.get(name)
    if (sc !== undefined) return sc
    let v: FxValue | undefined
    try {
      v = this.session.scope.resolve(name)
    } catch (e) {
      if (e instanceof FxError) throw e
      fail(n, e instanceof Error && e.message ? e.message : `Couldn't read ${name}`, true)
    }
    if (v !== undefined) return v
    if (this.fns.lookup(name)) fail(n, `${name} is a function: add brackets after it, like ${name}(...)`, true)
    const local = this.localNames(env)
    const guess = local.find((x) => x.toLowerCase() === name.toLowerCase())
    fail(n, guess ? `Name isn't recognised: ${name}. Did you mean ${guess}?` : `Name isn't recognised: ${name}`, true)
  }

  private localNames(env: Frame | null): string[] {
    const out: string[] = []
    for (let f = env; f; f = f.parent) {
      out.push(...Object.keys(f.record).filter((k) => k !== '__id'))
      if (f.as) out.push(f.as)
    }
    out.push(...Object.keys(ENUM_RECORDS))
    return out
  }

  private member(n: MemberNode, env: Frame | null): FxValue {
    const o = this.eval(n.obj, env)
    if (o === null) return null
    if (Array.isArray(o)) {
      // Table.Column -> single-column table
      const rows = toRows(o)
      if (rows.length > 0 && !rows.some((r) => hasOwn(r, n.name))) {
        fail({ start: n.nameStart, end: n.nameEnd }, `Can't read .${n.name} from a table: it has no column called ${n.name}`)
      }
      return rows.map((r) => ({ [n.name]: hasOwn(r, n.name) ? r[n.name]! : null }))
    }
    if (isRecord(o)) {
      if (hasOwn(o, n.name)) return o[n.name]!
      if (ENUM_SET.has(o)) {
        const base = n.obj.t === 'id' ? n.obj.name : 'This list'
        fail({ start: n.nameStart, end: n.nameEnd }, `${base} doesn't have a member called ${n.name}`)
      }
      return null
    }
    // a lookup column holds the id of the row it points at: .Field reads that row (core data model, P0-N)
    if (typeof o === 'string' && this.session.scope.recordById) {
      const r = this.session.scope.recordById(o)
      if (r === null) return null
      if (r) return hasOwn(r, n.name) ? r[n.name]! : null
    }
    return fail({ start: n.nameStart, end: n.nameEnd }, `Can't read .${n.name} from ${describe(o)}: only records have fields`)
  }

  private binary(n: BinaryNode, env: Frame | null): FxValue {
    const { op } = n
    if (op === '&&') return toBool(this.eval(n.left, env), n.left) ? toBool(this.eval(n.right, env), n.right) : false
    if (op === '||') return toBool(this.eval(n.left, env), n.left) ? true : toBool(this.eval(n.right, env), n.right)
    const l = this.eval(n.left, env)
    const r = this.eval(n.right, env)
    switch (op) {
      case '=': return looseEq(l, r)
      case '<>': return !looseEq(l, r)
      case '<': return compareValues(l, r, n) < 0
      case '>': return compareValues(l, r, n) > 0
      case '<=': return compareValues(l, r, n) <= 0
      case '>=': return compareValues(l, r, n) >= 0
      case 'in':
      case 'exactin': return this.contains(l, r, op === 'exactin', n)
      case '&': return toText(l, n.left) + toText(r, n.right)
      case '+':
        if (l instanceof Date && !(r instanceof Date)) return addDays(l, toNumber(r, n.right))
        if (r instanceof Date && !(l instanceof Date)) return addDays(r, toNumber(l, n.left))
        if (l instanceof Date) return fail(n, "Can't add two dates")
        return this.num(toNumber(l, n.left) + toNumber(r, n.right), n)
      case '-':
        if (l instanceof Date && r instanceof Date) return (l.getTime() - r.getTime()) / 86400000
        if (l instanceof Date) return addDays(l, -toNumber(r, n.right))
        return this.num(toNumber(l, n.left) - toNumber(r, n.right), n)
      case '*': return this.num(toNumber(l, n.left) * toNumber(r, n.right), n)
      case '/': {
        const d = toNumber(r, n.right)
        if (d === 0) fail(n.right, "Can't divide by zero")
        return this.num(toNumber(l, n.left) / d, n)
      }
      case '^': return this.num(Math.pow(toNumber(l, n.left), toNumber(r, n.right)), n)
    }
  }

  private num(x: number, at: Span): number {
    if (!Number.isFinite(x)) fail(at, "That result isn't a valid number")
    return x
  }

  private contains(needle: FxValue, hay: FxValue, exact: boolean, at: Span): boolean {
    if (Array.isArray(hay)) {
      return hay.some((row) => {
        if (isRecord(needle)) return looseEq(needle, row, exact)
        if (isRecord(row)) {
          if (hasOwn(row, 'Value')) return looseEq(needle, row.Value!, exact)
          const keys = Object.keys(row).filter((k) => k !== '__id')
          return keys.length === 1 && looseEq(needle, row[keys[0]!]!, exact)
        }
        return looseEq(needle, row, exact)
      })
    }
    if (hay !== null && typeof hay === 'object' && !(hay instanceof Date)) return fail(at, "Can't search inside a record with in")
    const h = toText(hay, at)
    const nd = toText(needle, at)
    return exact ? h.includes(nd) : h.toLowerCase().includes(nd.toLowerCase())
  }

  private call(n: CallNode, env: Frame | null): FxValue {
    const nameSpan = { start: n.nameStart, end: n.nameEnd }
    const def = this.fns.lookup(n.name)
    if (!def) return fail(nameSpan, unknownFunctionMessage(n.name, this.fns), true)
    const msg = arityMessage(def.name, def.min, def.max, n.args.length)
    if (msg) fail(n, msg, true)
    const ctx = this.ctx(n, env)
    if (def.tryPure) {
      const r = def.tryPure(ctx)
      if (r !== NOT_PURE) return r
    }
    if (def.kind === 'behaviour' && !this.host) fail(nameSpan, 'Behaviour function in a non-behaviour property', true)
    const out = def.run(ctx)
    // P1-E: on the server, what one evaluation builds is bounded too (rows of tables and characters of texts made by
    // functions), so a formula cannot exhaust the memory of the one server process
    if (this.deadline) {
      if (Array.isArray(out)) this.cells += out.length * 16
      else if (typeof out === 'string') this.cells += out.length
      if (this.cells > EVALUATION_MAX_CELLS) throw new RangeError('budget: the formula builds too much data and was stopped')
    }
    return out
  }

  private ctx(n: CallNode, env: Frame | null): CallCtx {
    const ev = this
    const arg = (i: number): Node => n.args[i]!
    const failAt = (i: number | null, message: string, fatal = false): never => fail(i === null ? n : arg(i), message, fatal)
    const value = (i: number): FxValue => {
      const a = arg(i)
      return ev.eval(a.t === 'as' ? a.expr : a, env)
    }
    const c: CallCtx = {
      node: n,
      argc: n.args.length,
      host: this.host,
      session: this.session,
      argNode: arg,
      value,
      withAs(i) {
        const a = arg(i)
        if (a.t === 'as') return { value: ev.eval(a.expr, env), as: a.name }
        return { value: ev.eval(a, env) }
      },
      fields(i, record) {
        return ev.eval(arg(i), { parent: env, record, noThis: true })
      },
      scoped(node, record) {
        return ev.eval(node, { parent: null, record, noThis: true })
      },
      row(i, record, as) {
        return ev.eval(arg(i), { parent: env, record, as })
      },
      rowBool(i, record, as) {
        return toBool(ev.eval(arg(i), { parent: env, record, as }), arg(i))
      },
      text: (i) => toText(value(i), arg(i)),
      num: (i) => toNumber(value(i), arg(i)),
      bool: (i) => toBool(value(i), arg(i)),
      rows(i, fname) {
        const a = arg(i)
        const v = a.t === 'as' ? ev.eval(a.expr, env) : ev.eval(a, env)
        const as = a.t === 'as' ? a.name : undefined
        if (v === null) return { rows: [], as }
        if (Array.isArray(v)) return { rows: toRows(v), as }
        return failAt(i, `${fname} needs a table as its ${ORDINALS[i] ?? `#${i + 1}`} argument`)
      },
      nameOf(i) {
        const a = arg(i)
        if (a.t === 'id') return a.name
        const v = ev.eval(a, env)
        if (typeof v !== 'string' || v === '') return failAt(i, 'A name is needed here')
        return v
      },
      fail: failAt,
      currentRows(coll) {
        const o = ev.session.colls.get(coll)
        if (o) return o
        let v: FxValue | undefined
        try { v = ev.session.scope.resolve(coll) } catch { return undefined }
        if (Array.isArray(v)) return toRows(v)
        return undefined
      },
    }
    return c
  }
}

export function evaluateSource(source: string, scope: FxScope, host?: FxHost, fns: FunctionTable = BUILTIN_TABLE): FxResult {
  const p = parse(source)
  if (p.error) return { ok: false, error: p.error }
  if (!p.ast) return { ok: true, value: null }
  try {
    const v = new Evaluator(scope, host, fns).run(p.ast)
    return { ok: true, value: v === undefined ? null : v }
  } catch (e) {
    if (e instanceof FxError) return { ok: false, error: e.toDiagnostic() }
    if (e instanceof RangeError) return { ok: false, error: { message: e.message.startsWith('budget: ') ? `This formula ${e.message.slice(12)}: it does too much work (for example loops inside loops over many rows).` : 'This formula is too complex to calculate', start: 0, end: source.length } }
    return { ok: false, error: { message: e instanceof Error && e.message ? e.message : 'Something went wrong calculating this formula', start: 0, end: source.length } }
  }
}
