import { platform, type AppMeta, type TableDef } from '@/platform'
import type { AppDef, ControlNode } from '@/contracts'

const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

function allNames(nodes: ControlNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    out.add(n.name)
    allNames(n.children, out)
  }
  return out
}

function uniqueName(base: string, taken: Set<string>): string {
  let i = 1
  while (taken.has(`${base}${i}`)) i++
  const n = `${base}${i}`
  taken.add(n)
  return n
}

/**
 * "Start with data": blank app, then add the table as data source and put a DataTable + Form on the first screen.
 * Layout is for the 1920x1080 design canvas and scaled when the app is another size.
 */
export async function createAppWithData(table: TableDef): Promise<AppMeta> {
  const meta = await platform.apps.create({ name: `${table.displayName} app`, width: 1920, height: 1080, template: 'blank' })
  const def = await platform.apps.load(meta.id)
  if (!def) return meta
  const next = addDataScreenContent(def, table)
  await platform.apps.save(meta.id, next)
  return meta
}

export function addDataScreenContent(def: AppDef, table: TableDef): AppDef {
  const sx = def.width / 1920
  const sy = def.height / 1080
  const r = (v: number, k: number) => Math.round(v * k)
  const taken = allNames(def.screens)
  const tableName = uniqueName('DataTable', taken)
  const formName = uniqueName('Form', taken)
  const dataTable: ControlNode = {
    id: uid(),
    name: tableName,
    type: 'DataTable',
    props: {
      Items: `=${table.name}`,
      X: `=${r(40, sx)}`,
      Y: `=${r(40, sy)}`,
      Width: `=${r(1120, sx)}`,
      Height: `=${r(1000, sy)}`,
    },
    children: [],
  }
  const form: ControlNode = {
    id: uid(),
    name: formName,
    type: 'Form',
    props: {
      DataSource: `="${table.name}"`,
      Item: `=${tableName}.Selected`,
      X: `=${r(1200, sx)}`,
      Y: `=${r(40, sy)}`,
      Width: `=${r(680, sx)}`,
      Height: `=${r(760, sy)}`,
    },
    children: [],
  }
  const screens = def.screens.map((s, i) => (i === 0 ? { ...s, children: [...s.children, dataTable, form] } : s))
  const sources = def.dataSources ?? []
  return { ...def, dataSources: sources.includes(table.name) ? sources : [...sources, table.name], screens }
}

export const RESOLUTIONS = [
  { id: 'fhd', label: 'Full HD', w: 1920, h: 1080 },
  { id: '2k', label: '2K', w: 2560, h: 1440 },
] as const
