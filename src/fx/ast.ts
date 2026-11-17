export interface Base { start: number; end: number }
export interface NumNode extends Base { t: 'num'; value: number }
export interface StrNode extends Base { t: 'str'; value: string }
export interface BoolNode extends Base { t: 'bool'; value: boolean }
export interface IdNode extends Base { t: 'id'; name: string }
export interface MemberNode extends Base { t: 'member'; obj: Node; name: string; nameStart: number; nameEnd: number }
export interface CallNode extends Base { t: 'call'; name: string; nameStart: number; nameEnd: number; args: Node[] }
export interface UnaryNode extends Base { t: 'unary'; op: '-' | '!'; arg: Node }
export interface PercentNode extends Base { t: 'pct'; arg: Node }
export type BinOp = '||' | '&&' | '=' | '<>' | '<' | '>' | '<=' | '>=' | 'in' | 'exactin' | '&' | '+' | '-' | '*' | '/' | '^'
export interface BinaryNode extends Base { t: 'bin'; op: BinOp; left: Node; right: Node }
export interface ChainNode extends Base { t: 'chain'; items: Node[] }
export interface RecField { name: string; nameStart: number; nameEnd: number; value: Node }
export interface RecordNode extends Base { t: 'rec'; fields: RecField[] }
export interface TableNode extends Base { t: 'tab'; items: Node[] }
export interface InterpNode extends Base { t: 'interp'; parts: (string | Node)[] }
export interface AsNode extends Base { t: 'as'; expr: Node; name: string; nameStart: number; nameEnd: number }

export type Node =
  | NumNode | StrNode | BoolNode | IdNode | MemberNode | CallNode | UnaryNode | PercentNode
  | BinaryNode | ChainNode | RecordNode | TableNode | InterpNode | AsNode

/** Direct child nodes, in source order. */
export function childrenOf(n: Node): Node[] {
  switch (n.t) {
    case 'member': return [n.obj]
    case 'call': return n.args
    case 'unary': case 'pct': return [n.arg]
    case 'bin': return [n.left, n.right]
    case 'chain': return n.items
    case 'rec': return n.fields.map((f) => f.value)
    case 'tab': return n.items
    case 'interp': return n.parts.filter((p): p is Node => typeof p !== 'string')
    case 'as': return [n.expr]
    default: return []
  }
}

/**
 * Identifier nodes that refer to a name from outside the formula (host names, row fields...).
 * Names bound by `Table As Name` are excluded within the call that binds them.
 */
export function freeIdentifiers(root: Node): IdNode[] {
  const out: IdNode[] = []
  const visit = (n: Node, bound: ReadonlySet<string>): void => {
    if (n.t === 'id') {
      if (!bound.has(n.name)) out.push(n)
      return
    }
    if (n.t === 'call') {
      let b = bound
      for (const a of n.args) {
        if (a.t === 'as') {
          if (b === bound) b = new Set(bound)
          ;(b as Set<string>).add(a.name)
        }
      }
      for (const a of n.args) visit(a, b)
      return
    }
    for (const c of childrenOf(n)) visit(c, bound)
  }
  visit(root, new Set())
  return out
}
