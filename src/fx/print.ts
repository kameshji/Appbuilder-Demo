import type { Node } from './ast.ts'

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/
const WORDS = new Set(['and', 'or', 'not', 'in', 'exactin', 'as', 'true', 'false'])

/** A name as formula text: bare when it is a plain identifier, otherwise 'quoted'. */
export function printName(name: string): string {
  return PLAIN.test(name) && !WORDS.has(name.toLowerCase()) ? name : `'${name.replace(/'/g, "''")}'`
}

function printNumber(n: number): string {
  return Object.is(n, -0) ? '0' : String(n)
}

/**
 * Formula text for an AST node (without the leading '='). Binary operators are fully parenthesised, so the result
 * parses back to the same tree whatever the precedence; used for residual formulas and constant folding.
 */
export function printNode(n: Node): string {
  switch (n.t) {
    case 'num': return printNumber(n.value)
    case 'str': return `"${n.value.replace(/"/g, '""')}"`
    case 'bool': return n.value ? 'true' : 'false'
    case 'id': return printName(n.name)
    case 'member': return `${printNode(n.obj)}.${printName(n.name)}`
    case 'call': return `${n.name}(${n.args.map(printNode).join(', ')})`
    case 'unary': return n.op === '!' ? `!(${printNode(n.arg)})` : `-(${printNode(n.arg)})`
    case 'pct': return `(${printNode(n.arg)})%`
    case 'bin': return `(${printNode(n.left)} ${n.op} ${printNode(n.right)})`
    case 'chain': return n.items.map(printNode).join('; ')
    case 'rec': return `{${n.fields.map((f) => `${printName(f.name)}: ${printNode(f.value)}`).join(', ')}}`
    case 'tab': return `[${n.items.map(printNode).join(', ')}]`
    case 'interp':
      return `$"${n.parts.map((p) => (typeof p === 'string' ? p.replace(/"/g, '""').replace(/\{/g, '{{') : `{${printNode(p)}}`)).join('')}"`
    case 'as': return `${printNode(n.expr)} As ${printName(n.name)}`
  }
}
