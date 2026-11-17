import { lookupFunction, suggestFunction } from './functions'

const WORD_OPS = new Set(['and', 'or', 'in', 'exactin', 'as'])

interface Frame {
  /** function name for `name(`, null for a grouping ( or a { / [ bracket */
  name: string | null
  call: boolean
  argIndex: number
}

/**
 * Which function call the caret is inside, and which argument. Works on unfinished formulas
 * (the formula bar calls it on every keystroke), so it scans text instead of using the parser.
 * `offset` is the caret position: characters before it count, characters after it do not.
 */
export function signatureAt(source: string, offset: number): { name: string; signature: string; summary: string; argIndex: number } | null {
  const end = Math.max(0, Math.min(offset, source.length))
  let i = 0
  while (i < source.length && /\s/.test(source[i]!)) i++
  if (source[i] !== '=' || i >= end) return null
  i++
  const stack: Frame[] = []
  /** identifier seen right before the current position (only whitespace between), if it could be a call */
  let ident: string | null = null
  /** previous significant char was a dot, so the next identifier is a member name */
  let afterDot = false
  /** the previous token ended a value, so and / or / in / As that follow are operators, not calls */
  let operand = false
  while (i < end) {
    const ch = source[i]!
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < end && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close < 0 || close + 2 > end) return null
      i = close + 2
      continue
    }
    if (ch === '"' || (ch === '$' && source[i + 1] === '"')) {
      // text; an interpolated hole may contain more text, so track braces for $"..."
      const interp = ch === '$'
      i += interp ? 2 : 1
      let holes = 0
      for (; i < end; i++) {
        const c = source[i]!
        if (holes === 0 && c === '"') {
          if (source[i + 1] === '"') { i++; continue }
          break
        }
        if (interp && c === '{' && source[i + 1] !== '{') holes++
        else if (interp && c === '}' && holes > 0) holes--
        else if (interp && holes > 0 && c === '"') {
          i++
          while (i < end && source[i] !== '"') i++
        }
      }
      if (i >= end) {
        // the caret is inside the text: still inside whatever call encloses it
        break
      }
      i++
      ident = null
      afterDot = false
      operand = true
      continue
    }
    if (ch === "'") {
      i++
      while (i < end) {
        if (source[i] === "'") { if (source[i + 1] === "'") { i += 2; continue } break }
        i++
      }
      i++
      ident = null
      afterDot = false
      operand = true
      continue
    }
    if (/[\p{L}_]/u.test(ch)) {
      let j = i + 1
      while (j < end && /[\p{L}\p{N}_]/u.test(source[j]!)) j++
      const word = source.slice(i, j)
      if (!afterDot && operand && WORD_OPS.has(word.toLowerCase())) {
        ident = null
        operand = false
      } else {
        ident = afterDot ? null : word
        operand = true
      }
      afterDot = false
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < end && /[0-9.]/.test(source[j]!)) j++
      i = j
      ident = null
      afterDot = false
      operand = true
      continue
    }
    if (ch === '(') {
      stack.push({ name: ident, call: ident !== null, argIndex: 0 })
    } else if (ch === '{' || ch === '[') {
      stack.push({ name: null, call: false, argIndex: 0 })
    } else if (ch === ')' || ch === ']' || ch === '}') {
      stack.pop()
    } else if (ch === ',') {
      const top = stack[stack.length - 1]
      if (top && top.call) top.argIndex++
    }
    afterDot = ch === '.'
    operand = ch === ')' || ch === ']' || ch === '}' || ch === '%'
    ident = null
    i++
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k]!
    if (!f.call || f.name === null) continue
    const def = lookupFunction(f.name) ?? suggestFunction(f.name)
    if (!def) return null
    return { name: def.name, signature: def.signature, summary: def.summary, argIndex: f.argIndex }
  }
  return null
}
