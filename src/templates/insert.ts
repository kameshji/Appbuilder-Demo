/**
 * Use actions of UI component and screen templates (pure; the Studio calls them on its app definition): the bound
 * controls get fresh ids and names that are free in the app, and every formula INSIDE the inserted part follows the
 * renames (through the formula engine's identifier rename, never text replacement). Nothing that was in the app before
 * is changed: its controls, screens and formulas stay as they were; only the new part and its data sources are added.
 */
import type { AppDef, ControlNode } from '../contracts.ts'
import { renameIdentifier } from '../fx/index.ts'

const walk = (nodes: ControlNode[], fn: (n: ControlNode) => void): void => {
  for (const n of nodes) {
    fn(n)
    walk(n.children ?? [], fn)
  }
}

/** every control and screen name of an app */
export function namesOf(app: AppDef): string[] {
  const out: string[] = []
  walk(app.screens, (n) => out.push(n.name))
  return out
}

/** Name -> Name2, Name7 -> Name8 ... until it is free (case-insensitive) */
export function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  const m = /^(.*?)(\d+)$/.exec(base)
  const stem = m ? m[1] : base
  let i = m ? Number(m[2]) + 1 : 2
  while (taken.has(`${stem}${i}`.toLowerCase())) i++
  return `${stem}${i}`
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * Copies of `nodes` whose names are free among `taken` (and each other), with fresh ids; formulas of the copies follow
 * the renames. Returns the copies and old name -> new name for what was renamed.
 */
export function prepareNodes(nodes: ControlNode[], taken: Iterable<string>, newId: () => string): { nodes: ControlNode[]; renamed: Record<string, string> } {
  const copy = clone(nodes)
  const used = new Set([...taken].map((x) => x.toLowerCase()))
  const inside: string[] = []
  walk(copy, (n) => inside.push(n.name))
  const renamed: Record<string, string> = {}
  // names inside the inserted part are reserved too, so a rename never lands on another inserted name
  const reserved = new Set([...used, ...inside.map((x) => x.toLowerCase())])
  for (const name of inside) {
    if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); continue }
    const next = freeName(name, reserved)
    reserved.add(next.toLowerCase())
    used.add(next.toLowerCase())
    renamed[name] = next
  }
  walk(copy, (n) => {
    n.id = newId()
    if (renamed[n.name]) n.name = renamed[n.name]
    for (const [k, f] of Object.entries(n.props ?? {})) {
      let out = f
      for (const [from, to] of Object.entries(renamed)) out = renameIdentifier(out, from, to)
      n.props[k] = out
    }
    if (!Array.isArray(n.children)) n.children = []
  })
  return { nodes: copy, renamed }
}

const withSources = (app: AppDef, sources: string[]): string[] => {
  const have = app.dataSources ?? []
  const lower = new Set(have.map((x) => x.toLowerCase()))
  return [...have, ...sources.filter((x) => !lower.has(x.toLowerCase()))]
}

/** a UI component template inserted into a screen (at the end of its children) */
export function insertIntoScreen(app: AppDef, screenId: string, nodes: ControlNode[], newId: () => string, dataSources: string[] = []): { app: AppDef; ids: string[]; renamed: Record<string, string> } {
  const screen = app.screens.find((s) => s.id === screenId)
  if (!screen) throw new Error('The screen to insert into was not found.')
  const prep = prepareNodes(nodes, namesOf(app), newId)
  const next: AppDef = { ...app, dataSources: withSources(app, dataSources), screens: app.screens.map((s) => (s.id === screenId ? { ...s, children: [...s.children, ...prep.nodes] } : s)) }
  return { app: next, ids: prep.nodes.map((n) => n.id), renamed: prep.renamed }
}

/** a screen template added as the last screen of the app */
export function appendScreen(app: AppDef, screen: ControlNode, newId: () => string, dataSources: string[] = []): { app: AppDef; screenId: string; renamed: Record<string, string> } {
  const prep = prepareNodes([screen], namesOf(app), newId)
  const s = prep.nodes[0]
  return { app: { ...app, dataSources: withSources(app, dataSources), screens: [...app.screens, s] }, screenId: s.id, renamed: prep.renamed }
}

/** fresh node ids for a whole app (an app template installed twice must not share ids between its copies) */
export function freshAppIds(app: AppDef, newId: () => string): AppDef {
  const out = clone(app)
  walk(out.screens, (n) => { n.id = newId() })
  return out
}
