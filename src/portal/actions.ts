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
 * "Start with data": blank app of the chosen design size, then add the table as data source and generate screens:
 * - desktop / landscape: a DataTable and a Form side by side on the first screen (laid out for 1920x1080 and scaled);
 * - portrait (tablet): the DataTable above the Form on one screen;
 * - phone (narrower than 700 px): a single-column list screen (Gallery, New button) and a separate form screen
 *   (Back button, Form that returns to the list after saving).
 */
export async function createAppWithData(table: TableDef, size: { w: number; h: number } = { w: 1920, h: 1080 }): Promise<AppMeta> {
  const meta = await platform.apps.create({ name: `${table.displayName} app`, width: size.w, height: size.h, template: 'blank' })
  const def = await platform.apps.load(meta.id)
  if (!def) return meta
  const next = addDataScreenContent(def, table)
  await platform.apps.save(meta.id, next)
  return meta
}

export const PHONE_MAX_WIDTH = 700

/** `base` when free, else base2, base3, ... */
function freeName(base: string, taken: Set<string>): string {
  let n = base
  for (let i = 2; taken.has(n); i++) n = `${base}${i}`
  taken.add(n)
  return n
}

const node = (name: string, type: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode => ({ id: uid(), name, type, props, children })
const box = (x: number, y: number, w: number, h: number) => ({ X: `=${Math.round(x)}`, Y: `=${Math.round(y)}`, Width: `=${Math.round(w)}`, Height: `=${Math.round(h)}` })
const q = (text: string) => `"${text.replace(/"/g, '""')}"`

export function addDataScreenContent(def: AppDef, table: TableDef): AppDef {
  const sources = def.dataSources ?? []
  const withSource = sources.includes(table.name) ? sources : [...sources, table.name]
  if (def.width < PHONE_MAX_WIDTH) return { ...phoneScreens(def, table), dataSources: withSource }
  const taken = allNames(def.screens)
  const tableName = uniqueName('DataTable', taken)
  const formName = uniqueName('Form', taken)
  let dataTable: ControlNode
  let form: ControlNode
  if (def.height > def.width) {
    // portrait: list above, form below
    const pad = 24
    const w = def.width - pad * 2
    const listH = Math.round((def.height - pad * 3) * 0.45)
    dataTable = node(tableName, 'DataTable', { Items: `=${table.name}`, ...box(pad, pad, w, listH), AnchorH: '=Anchor.Stretch' })
    form = node(formName, 'Form', { DataSource: `="${table.name}"`, Item: `=${tableName}.Selected`, Columns: '=2', ...box(pad, pad * 2 + listH, w, def.height - listH - pad * 3), AnchorH: '=Anchor.Stretch', AnchorV: '=Anchor.Stretch' })
  } else {
    const sx = def.width / 1920
    const sy = def.height / 1080
    dataTable = node(tableName, 'DataTable', { Items: `=${table.name}`, ...box(40 * sx, 40 * sy, 1120 * sx, 1000 * sy) })
    form = node(formName, 'Form', { DataSource: `="${table.name}"`, Item: `=${tableName}.Selected`, ...box(1200 * sx, 40 * sy, 680 * sx, 760 * sy) })
  }
  const screens = def.screens.map((s, i) => (i === 0 ? { ...s, children: [...s.children, dataTable, form] } : s))
  return { ...def, dataSources: withSource, screens }
}

/** phone: list screen + form screen, one column each */
function phoneScreens(def: AppDef, table: TableDef): AppDef {
  const W = def.width
  const H = def.height
  const pad = 16
  const header = 56
  const taken = allNames(def.screens)
  taken.delete(def.screens[0].name) // the first screen is renamed
  const listScreenName = freeName(`${table.name}List`, taken)
  const formScreenName = freeName(`${table.name}Edit`, taken)
  const galleryName = uniqueName('Gallery', taken)
  const formName = uniqueName('Form', taken)
  const primary = table.primaryColumn || table.columns.find((c) => !c.system)?.name || 'Name'
  const second = table.columns.find((c) => !c.system && c.name !== primary && ['text', 'email', 'choice', 'number', 'phone', 'url'].includes(String(c.type)))
  const stretch = { AnchorH: '=Anchor.Stretch' }

  const headerBar = (name: string) => node(uniqueName(name, taken), 'Rectangle', { ...box(0, 0, W, header), ...stretch, Fill: '=RGBA(79, 70, 229, 1)', Radius: '=0', BorderWidth: '=0' })
  const listScreen: ControlNode = {
    ...def.screens[0],
    name: listScreenName,
    props: { ...def.screens[0].props, Fill: '=RGBA(248, 250, 252, 1)' },
    children: [
      ...def.screens[0].children,
      headerBar('ListHeader'),
      node(uniqueName('ListTitle', taken), 'Label', { ...box(pad, 12, W - 140, 32), Text: `=${q(table.displayName)}`, Size: '=20', FontWeight: '=FontWeight.Semibold', Color: '=Color.White' }),
      node(uniqueName('NewButton', taken), 'Button', {
        ...box(W - pad - 92, 10, 92, 36),
        AnchorH: '=Anchor.End',
        Text: '="+ New"',
        Style: '=ButtonStyle.Outline',
        OnSelect: `=NewForm(${formName}); Navigate(${formScreenName})`,
      }),
      node(galleryName, 'Gallery', {
        Items: `=${table.name}`,
        ...box(0, header, W, H - header),
        AnchorH: '=Anchor.Stretch',
        AnchorV: '=Anchor.Stretch',
        TemplateHeight: second ? '=64' : '=52',
        Gap: '=0',
        Fill: '=Color.Transparent',
        OnSelect: `=EditForm(${formName}); Navigate(${formScreenName})`,
      }, [
        node(uniqueName('ItemBackground', taken), 'Rectangle', { ...box(0, 0, W, second ? 64 : 52), ...stretch, Fill: '=Color.White', Radius: '=0', BorderWidth: '=0' }),
        node(uniqueName('ItemTitle', taken), 'Label', { ...box(pad, second ? 10 : 14, W - pad * 2 - 24, 24), ...stretch, Text: `=ThisItem.${primary}`, Size: '=15', FontWeight: '=FontWeight.Semibold' }),
        ...(second ? [node(uniqueName('ItemSubtitle', taken), 'Label', { ...box(pad, 34, W - pad * 2 - 24, 20), ...stretch, Text: `=ThisItem.${second.name}`, Size: '=12', Color: '=RGBA(100, 116, 139, 1)' })] : []),
        node(uniqueName('ItemDivider', taken), 'Rectangle', { ...box(pad, (second ? 64 : 52) - 1, W - pad, 1), ...stretch, Fill: '=RGBA(226, 232, 240, 1)', Radius: '=0', BorderWidth: '=0' }),
        node(uniqueName('ItemChevron', taken), 'Label', { ...box(W - pad - 16, second ? 20 : 14, 16, 24), AnchorH: '=Anchor.End', Text: '=">"', Size: '=15', Color: '=RGBA(148, 163, 184, 1)' }),
      ]),
    ],
  }
  const formScreen: ControlNode = {
    id: uid(),
    name: formScreenName,
    type: 'Screen',
    props: { Fill: '=Color.White' },
    children: [
      headerBar('EditHeader'),
      node(uniqueName('BackButton', taken), 'Button', { ...box(8, 10, 72, 36), Text: '="< Back"', Style: '=ButtonStyle.Ghost', Color: '=Color.White', OnSelect: '=Back()' }),
      node(uniqueName('EditTitle', taken), 'Label', {
        ...box(88, 12, W - 104, 32),
        ...stretch,
        Text: `=If(${formName}.Mode = FormMode.New, ${q('New ' + table.displayName.toLowerCase())}, Coalesce(${galleryName}.Selected.${primary}, ${q(table.displayName)}))`,
        Size: '=18',
        FontWeight: '=FontWeight.Semibold',
        Color: '=Color.White',
      }),
      node(formName, 'Form', {
        DataSource: `="${table.name}"`,
        Item: `=${galleryName}.Selected`,
        Columns: '=1',
        ...box(pad, header + pad, W - pad * 2, H - header - pad * 2),
        AnchorH: '=Anchor.Stretch',
        AnchorV: '=Anchor.Stretch',
        OnSuccess: '=Back()',
        OnCancel: '=Back()',
      }),
    ],
  }
  return { ...def, screens: [listScreen, formScreen, ...def.screens.slice(1)] }
}
