import type { AppDef, ControlNode, FxRecord, FxValue } from '@/contracts'

export const uid = () => 'n' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3)

export function isRecord(v: unknown): v is FxRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false
    return true
  }
  return false
}

/* ------------------------------------------------------------------ tree helpers */

export function walk(
  nodes: ControlNode[],
  fn: (n: ControlNode, parent: ControlNode | null, screen: ControlNode) => void,
  parent: ControlNode | null = null,
  screen?: ControlNode,
) {
  for (const n of nodes) {
    const scr = screen ?? n
    fn(n, parent, scr)
    if (n.children.length) walk(n.children, fn, n, scr)
  }
}

export function findNode(app: AppDef, id: string): ControlNode | null {
  let found: ControlNode | null = null
  walk(app.screens, (n) => {
    if (!found && n.id === id) found = n
  })
  return found
}

export function findParent(app: AppDef, id: string): ControlNode | null {
  let found: ControlNode | null = null
  walk(app.screens, (n, p) => {
    if (n.id === id) found = p
  })
  return found
}

export function screenOf(app: AppDef, id: string): ControlNode | null {
  let found: ControlNode | null = null
  walk(app.screens, (n, _p, s) => {
    if (n.id === id) found = s
  })
  return found
}

export function pathTo(app: AppDef, id: string): ControlNode[] {
  const out: ControlNode[] = []
  const rec = (nodes: ControlNode[], trail: ControlNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === id) {
        out.push(...trail, n)
        return true
      }
      if (rec(n.children, [...trail, n])) return true
    }
    return false
  }
  rec(app.screens, [])
  return out
}

export function isDescendant(root: ControlNode, id: string): boolean {
  for (const c of root.children) if (c.id === id || isDescendant(c, id)) return true
  return false
}

export function allNames(app: AppDef): Set<string> {
  const s = new Set<string>()
  walk(app.screens, (n) => s.add(n.name))
  return s
}

export function uniqueName(app: AppDef, base: string, extra?: Set<string>): string {
  const used = allNames(app)
  extra?.forEach((n) => used.add(n))
  let i = 1
  while (used.has(`${base}${i}`)) i++
  return `${base}${i}`
}

export function cloneWithNewIds(node: ControlNode, renames: Map<string, string>, app: AppDef, used: Set<string>): ControlNode {
  const name = uniqueName(app, node.name.replace(/\d+$/, '') || node.type, used)
  used.add(name)
  renames.set(node.name, name)
  return {
    id: uid(),
    name,
    type: node.type,
    props: { ...node.props },
    children: node.children.map((c) => cloneWithNewIds(c, renames, app, used)),
  }
}

export function mapNodes(node: ControlNode, fn: (n: ControlNode) => void) {
  fn(node)
  node.children.forEach((c) => mapNodes(c, fn))
}

/* ------------------------------------------------------------------ formula literal helpers */

export const quote = (s: string) => `="${s.replace(/"/g, '""')}"`

export function parseTextLiteral(f: string | undefined): string | null {
  if (f == null) return null
  const m = /^=\s*"((?:[^"]|"")*)"\s*$/.exec(f)
  return m ? m[1].replace(/""/g, '"') : null
}

export function parseNumberLiteral(f: string | undefined): number | null {
  if (f == null) return null
  const m = /^=\s*(-?\d+(?:\.\d+)?)\s*$/.exec(f)
  return m ? Number(m[1]) : null
}

export function parseBoolLiteral(f: string | undefined): boolean | null {
  if (f == null) return null
  const m = /^=\s*(true|false)\s*$/i.exec(f)
  return m ? m[1].toLowerCase() === 'true' : null
}

export const normFormula = (f: string) => f.replace(/\s+/g, '').toLowerCase()

export function typeName(v: FxValue | undefined): string {
  if (v === null || v === undefined) return 'Blank'
  if (typeof v === 'boolean') return 'Boolean'
  if (typeof v === 'number') return 'Number'
  if (typeof v === 'string') return 'Text'
  if (v instanceof Date) return 'Date'
  if (Array.isArray(v)) return `Table(${v.length})`
  return 'Record'
}

export function summarize(v: FxValue | undefined, max = 120): string {
  let s: string
  if (v === null || v === undefined) s = 'Blank'
  else if (typeof v === 'string') s = JSON.stringify(v)
  else if (v instanceof Date) s = v.toISOString()
  else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v, (k, val) => (k === '__id' ? undefined : val))
    } catch {
      s = '[object]'
    }
  } else s = String(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export const round2 = (n: number) => Math.round(n * 100) / 100
