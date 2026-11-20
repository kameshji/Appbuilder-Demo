import type { ControlRegistryApi, ControlType, FxValue, PropMeta } from '@/contracts'
import { CATEGORIES } from '@/studio/categories'
import { GENERATED_NOTICE, anchor, cell, code, page, table } from './markdown'

/* ------------------------------------------------------------------------------------------------
 * Hand-maintained parts of the controls reference. Properties, outputs, events, defaults, sizes and
 * categories come from the registry. Only the one-line description of each control and a few notes
 * (taken from docs/internal/notes) live here. A control without a description fails the test.
 * ---------------------------------------------------------------------------------------------- */

export const DESCRIPTIONS: Record<string, string> = {
  Screen: 'One page of the app. Every app has at least one; UI components are placed on a screen. A screen is not inserted from the Insert pane.',
  // Layout
  Container: 'A box that holds other UI components. Children are placed by hand or arranged in a row, column or grid.',
  Row: 'A container that lays its children out in a horizontal row.',
  Column: 'A container that lays its children out in a vertical column.',
  Grid: 'A container that lays its children out in a grid with a number of columns.',
  Card: 'A container with an optional title and description above its content, with a fill and a border.',
  ScrollArea: 'A container whose content scrolls when it is bigger than the box.',
  Divider: 'A thin line, with an optional label, that separates parts of a screen.',
  Spacer: 'Empty space between UI components in a row, column or grid.',
  Dialog: 'A pop-up window over the screen with a title, content and a close button. Shown only while Open is true.',
  Sheet: 'A panel that slides in from one side of the screen. Shown only while Open is true.',
  Accordion: 'A list of sections that expand and collapse.',
  // Input
  Button: 'A push button. Its OnSelect formula runs when it is clicked.',
  TextInput: 'A single-line text box.',
  Checkbox: 'A tick box with a text label. Its value is true or false.',
  Toggle: 'An on/off switch with a text label. Its value is true or false.',
  Dropdown: 'A closed list that opens to pick one item.',
  TextArea: 'A multi-line text box.',
  NumberInput: 'A box for entering a number, with a minimum, maximum and step.',
  PasswordInput: 'A text box that hides what is typed, with an optional show/hide toggle.',
  SearchBox: 'A text box for search terms. OnSearch runs when a search is submitted, and optionally while typing.',
  RadioGroup: 'A list of options that are all visible, with one choice.',
  ComboBox: 'A searchable list. Picks one item or several.',
  DatePicker: 'Picks one date from a calendar.',
  DateRangePicker: 'Picks a start date and an end date.',
  TimePicker: 'Picks a time of day.',
  Slider: 'Picks a number between a minimum and a maximum by dragging a handle.',
  RangeSlider: 'Picks a low and a high number between a minimum and a maximum with two handles.',
  Rating: 'A star rating.',
  ToggleGroup: 'A row of buttons from a list of items, where one or several can be switched on.',
  SegmentedControl: 'A row of joined buttons from a list of items, for picking one.',
  IconButton: 'A button that shows only an icon.',
  LinkButton: 'A button that looks like a text link.',
  PrintButton: 'Prints a record with a print template: the PDF is made on the server and opens in a new tab (downloaded on a phone).',
  SplitButton: 'A button with a main action and a menu of related actions.',
  MenuButton: 'A button that opens a menu of items.',
  FileUpload: 'Lets the user choose one or more files.',
  ColorPicker: 'Picks a colour.',
  Stepper: 'A number box with minus and plus buttons.',
  PinInput: 'A row of boxes for a short code such as a PIN, with an optional mask.',
  Timer: 'A timer that runs for a set time and raises events when it starts and ends.',
  BarcodeScanner: 'A button that opens the camera to scan a barcode or QR code; the code is in Value and OnScan runs.',
  ScanInput: 'A text field for codes: a hardware (keyboard) scanner fills it and runs OnScan; the camera button scans with the camera.',
  SignaturePad: 'A pad to sign on with a finger, a stylus or the mouse; the signature is a PNG in Image and FileToken, for an image column.',
  // Display
  Label: 'Shows a piece of text.',
  Image: 'Shows a picture.',
  Rectangle: 'A plain box with a fill, an optional border and rounded corners.',
  Heading: 'Shows a title text, with a heading level.',
  RichText: 'Shows formatted text written with simple markup: bold, italics, links and lists.',
  Badge: 'A small label, for a status or a count.',
  Avatar: 'A round picture or initials for a person. Set User to a user id or a Users record (ThisItem.owner, User()) to show that person.',
  AvatarGroup: 'A row of overlapping avatars for a list of people. Set Users to a table of user ids or Users records.',
  RecordTimeline: 'The timeline of one record (core data model): comments with @mentions, activities, files and the record\'s changes in one live feed, with a composer, follow and tags.',
  ApprovalsPanel: 'The approval requests about a record that the signed-in user may see (status, who is asked or decided), with the answer buttons when one waits for them and a "Request approval" button (P1, server mode).',
  ActivityList: 'The signed-in user\'s open tasks (activities of type Task assigned to them or their teams), with a checkbox to complete each.',
  PersonPicker: 'Choose a person from the Users of this environment, with search; Value is the user id, Selected the person.',
  TagInput: 'The tags of a record: add a tag (created when new) or remove one.',
  Icon: 'Shows an icon. It can also run a formula when selected.',
  Shape: 'A simple shape: rectangle, ellipse, line or triangle.',
  TagList: 'A row of small tags from a list of items.',
  StatCard: 'A card showing one key figure with its change since earlier.',
  Timeline: 'A vertical list of events in time order, each with a title, description and time.',
  // Data
  Gallery: 'Repeats a row template for every item in a table, as a vertical list, a horizontal strip or a grid.',
  Form: 'Edits or creates one row of a table, with the fields made from the table columns and Save and Cancel buttons.',
  DataTable: 'Shows a table of rows as a grid with optional search, sorting and paging.',
  List: 'Shows rows as a simple list with a title, subtitle, icon or image for each item.',
  Calendar: 'A month calendar that can show events.',
  // Navigation
  Tabs: 'A row of tabs from a list of items.',
  Breadcrumb: 'A trail of links showing where the user is.',
  Pagination: 'Page buttons for moving through a long list.',
  NavMenu: 'A side menu of items. It does not navigate by itself: write Navigate(...) in OnSelect.',
  TopBar: 'A bar across the top of a screen with a title, a subtitle and optional items. It can hold other UI components.',
  Steps: 'A progress trail through the steps of a process.',
  // Feedback
  Progress: 'A horizontal bar showing how far something has got.',
  CircularProgress: 'A round gauge showing how far something has got.',
  Spinner: 'A small spinning indicator for waiting.',
  Skeleton: 'A grey placeholder shape shown while content loads.',
  Alert: 'A message box in a coloured style, which can be dismissed.',
  EmptyState: 'A friendly message with an icon and an optional action, for when there is nothing to show.',
  // Media
  Video: 'Plays a video from a source address.',
  Audio: 'Plays sound from a source address.',
  AnimatedIcon: 'An animated icon that can play on hover, on click or in a loop.',
  // Charts
  Chart: 'A bar, line, area, pie or donut chart of a table.',
  Sparkline: 'A tiny chart without axes, to show a trend inside a row or a card.',
  Visual: 'Every chart kind of dashboards (bar, line, area, combo, pie, donut, scatter, heat map, gauge, bullet, KPI, funnel, Pareto, histogram, timeline) from a table, with tooltips, keyboard navigation, a legend that hides series and OnSelect with the clicked row.',
}

/** Extra notes per control type. Statements come from docs/internal/notes and the registry flags. */
export const NOTES: Record<string, string[]> = {
  Form: [
    'The `DataSource` table is added to the app\'s data sources automatically.',
    'In New mode it inserts a row; in Edit mode it updates the row in `Item` (an `Item` that is blank means insert). `Updates` holds the values of the fields shown.',
    '`NewForm`, `EditForm` and `ViewForm` change the form\'s `Mode` output, which takes over from the `Mode` property once it has been set. `ResetForm` puts the fields back to their starting values.',
    '`SubmitForm` checks `Valid` first. When it is false, the inline messages appear, `Error` is set and `OnFailure` runs; nothing is written.',
    '`SignatureFields` lists image (or file) columns that are signed instead of uploaded, for example `"Signature"`: the field is a signature pad and the PNG is uploaded after the row is saved, like a photo.',
    'In a running app (server mode) an unsaved New or Edit form is kept as a draft on the device (encrypted, for the signed-in user) and restored after an accidental reload, with a "Draft restored" note and a Discard button. Saving, Discard, signing out and a device wipe delete it.',
  ],
  DataTable: [
    '`Columns` entries are a field name or `field:Header`. With `Columns` blank the table hides fields that start with `__` and the `id` field but still shows system columns such as `createdOn` and `owner`. Set `Columns` in generated apps.',
  ],
  NavMenu: ['`SelectedScreen` carries the screen text of the selected row. Write `Navigate(...)` in `OnSelect` to go there.'],
  Gallery: ['`Layout` is text: `"Vertical"`, `"Horizontal"` or `"Grid"` (it is not the `Layout` enum). Vertical rows are as wide as the gallery and `TemplateHeight` tall; horizontal rows are `TemplateWidth` x `TemplateHeight`; a grid uses `Columns`.'],
  BarcodeScanner: ['QR codes and Data Matrix need a browser with a built-in barcode reader (Chrome on Android). Elsewhere the scanner reads EAN-13/8, Code 128, Code 39 and ITF itself. `Continuous` keeps the camera open for stock counts: OnScan runs for each code (the same code again after 2 seconds). The camera needs HTTPS (see the administrator guide on phones on a LAN).'],
  ScanInput: ['A burst of keys ending with Enter, faster than a person types, counts as a scan: Value becomes the code and OnScan runs. Typing by hand runs OnChange (and OnScan when you press Enter).'],
  SignaturePad: ['Save it into an image (or file) column with `Patch(Visits, ThisItem, {Signature: SignaturePad1.FileToken})`: the row is written first, then the PNG is uploaded into the column (without a connection, in an app that works offline, both wait on the device and are sent in that order). Show it with an Image UI component (`Image = SignaturePad1.Image`) and print it with an image block of source "attachment" on that column. `HasSignature` is true once there is enough ink (a stray tap does not count); `OnSign` runs after each stroke; `Reset(SignaturePad1)` clears it. In a Form, list the image column in the Form\'s `SignatureFields` instead. The pad is 3:1 (a signature line) inside the UI component; the PNG is at most 1200 x 400 px on white.'],
  Timer: ['The timer never runs while you design; it runs in preview and in the running app. `Start` is edge-triggered (it acts when it becomes true); `AutoStart` starts it when the screen appears.'],
  Dialog: ['Close button, a click on the backdrop (when `CloseOnBackdrop` is true) and the Escape key run `OnClose`. Your `OnClose` formula should set the variable that `Open` reads to false.'],
  Sheet: ['Close button, a click on the backdrop (when `CloseOnBackdrop` is true) and the Escape key run `OnClose`. Your `OnClose` formula should set the variable that `Open` reads to false. `Side` chooses the edge: left and right sheets are `Width` wide and full height; top and bottom sheets are `Height` tall and full width.'],
  Screen: ['A screen has no X, Y, Width, Height or other common properties: it is not positioned like other UI components. `OnVisible` runs when the screen is shown while the app is running.'],
}

/* ------------------------------------------------------------------------------------------------ helpers */

const COMMON_NAMES = ['X', 'Y', 'Width', 'Height', 'Visible', 'AnchorH', 'AnchorV', 'Grow', 'AlignSelf', 'Tooltip']
const DISPLAY_MODE = 'DisplayMode'

const isSimple = (p: PropMeta): boolean => p.simple !== false
const level = (p: PropMeta): string => (isSimple(p) ? 'Simple' : 'Advanced')

/** Enum member lists, set by buildControlsPage so that a full enum can be shown as a link instead of every member. */
let ENUMS: Record<string, string[]> = {}

function optionsText(p: PropMeta): string {
  const opts = p.options
  if (!opts?.length) return ''
  const m = /^([A-Za-z]+)\./.exec(opts[0]!)
  if (m && ENUMS[m[1]!]) {
    const name = m[1]!
    const full = ENUMS[name]!.map((x) => `${name}.${x}`)
    if (opts.length === full.length && opts.every((o, i) => o === full[i])) return `any [${name}](formulas.md#${name.toLowerCase()}) member`
  }
  return opts.map((o) => code(o)).join(', ')
}

function sameMeta(a: PropMeta, b: PropMeta, ignoreDefault: boolean): boolean {
  return (
    a.kind === b.kind &&
    a.group === b.group &&
    a.label === b.label &&
    isSimple(a) === isSimple(b) &&
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null) &&
    (ignoreDefault || a.default === b.default)
  )
}

function valueText(v: FxValue): string {
  if (v === null) return 'blank'
  return code(JSON.stringify(v))
}

const PROP_HEADER = ['Property', 'Shown as', 'Kind', 'Group', 'Default', 'Level', 'Values']

/** Property table. The "Shown as" and "Values" columns are left out when they would be empty. */
function propTable(props: PropMeta[], defaultOf: (p: PropMeta) => string = (p) => code(p.default)): string {
  const rows = props.map((p) => [code(p.name), p.label && p.label !== p.name ? cell(p.label) : '', p.kind, p.group, defaultOf(p), level(p), optionsText(p)])
  const keep = PROP_HEADER.map((_, i) => i !== 1 && i !== 6 ? true : rows.some((r) => r[i] !== ''))
  return table(
    PROP_HEADER.filter((_, i) => keep[i]),
    rows.map((r) => r.filter((_, i) => keep[i])),
  )
}

const INTRO = `# UI components reference

A UI component is one building block on a screen. Each UI component has **properties** (each holds a formula), **outputs** (values the UI component produces, such as what the user typed) and **events** (properties whose formula runs when something happens). Outputs are read in formulas like a field of the UI component: \`TextInput1.Value\`, \`Gallery1.Selected.Name\`.

This page is generated from the UI component registry. Do not edit it by hand; run \`npm run docs:gen\`. How formulas work is in the [Formula reference](formulas.md).

How to read the tables:
- **Kind** is the type of value the property expects: \`text\`, \`number\`, \`boolean\`, \`color\`, \`enum\`, \`table\`, \`record\`, \`any\`, \`tableName\` (the name of a data table as text), \`icon\` (an icon name as text, or \`anim:<id>\` for an animated icon) and \`action\` (an event).
- **Default** is the formula a new UI component starts with.
- **Level**: Simple properties are on the Simple tab of the property pane; Advanced ones are only on the Advanced tab.
- **Shown as** is the label on the Simple tab when it differs from the property name. **Values** lists the choices of an \`enum\` property.
- Outputs whose names start with two underscores are internal and not listed.
- UI components are listed in the order of the Insert pane's categories.

**Not supported yet.** The set of UI components is fixed: makers cannot add their own UI components or import component packs. Phone and tablet apps are separate apps with their own design size; one app does not switch between a desktop and a phone layout.`

export interface ControlsGenerated {
  text: string
  warnings: string[]
  missingDescriptions: string[]
  counts: { controls: number; withScreen: number; categories: number }
}

export function buildControlsPage(registry: ControlRegistryApi, enums: Record<string, string[]>): ControlsGenerated {
  ENUMS = enums
  const warnings: string[] = []
  const list = registry.list()
  const screen = registry.get('Screen')
  const all: ControlType[] = [screen, ...list]

  const missingDescriptions = all.map((c) => c.type).filter((t) => !DESCRIPTIONS[t])
  const types = new Set(all.map((c) => c.type))
  const extra = Object.keys(DESCRIPTIONS).filter((t) => !types.has(t))
  if (extra.length) warnings.push(`DESCRIPTIONS has entries for UI components that do not exist: ${extra.join(', ')}`)
  const extraNotes = Object.keys(NOTES).filter((t) => !types.has(t))
  if (extraNotes.length) warnings.push(`NOTES has entries for UI components that do not exist: ${extraNotes.join(', ')}`)

  // common properties, taken from a plain control and checked against every other one
  const base = registry.propsOf('Label')
  const common = COMMON_NAMES.map((n) => base.find((p) => p.name === n)).filter((p): p is PropMeta => !!p)
  if (common.length !== COMMON_NAMES.length) warnings.push('Label does not have every common property; the common table is incomplete')
  const displayMode = registry.propsOf('Button').find((p) => p.name === DISPLAY_MODE)

  const isCommon = (c: ControlType, p: PropMeta): boolean => {
    const ref = common.find((q) => q.name === p.name)
    if (!ref) return false
    if (p.name === 'Width') return sameMeta(p, ref, true) && p.default === `=${c.defaultSize.width}`
    if (p.name === 'Height') return sameMeta(p, ref, true) && p.default === `=${c.defaultSize.height}`
    return sameMeta(p, ref, false)
  }
  const isDisplayMode = (p: PropMeta): boolean => !!displayMode && p.name === DISPLAY_MODE && sameMeta(p, displayMode, false)

  // group by category in Insert-pane order; keep registry order inside a category
  const catOrder = CATEGORIES.slice()
  for (const c of all) if (!catOrder.includes(c.category)) {
    catOrder.push(c.category)
    warnings.push(`Category ${c.category} is not in src/studio/categories.ts; listed last`)
  }
  const groups = new Map(catOrder.map((cat) => [cat, [] as ControlType[]]))
  for (const c of all) groups.get(c.category)!.push(c)

  const blocks: string[] = [GENERATED_NOTICE, INTRO]

  // common properties
  const commonBlock = [
    '## Common properties',
    `Every UI component except a screen has these ${common.length} properties. They are not repeated in the tables below.`,
    propTable(common, (p) => (p.name === 'Width' || p.name === 'Height' ? "the UI component's default size (listed under each UI component)" : code(p.default))),
  ]
  if (displayMode) {
    commonBlock.push(
      `**\`DisplayMode\`** is shared by the UI components that can be switched off: ${code(displayMode.default)} by default, one of ${displayMode.options!.map((o) => code(o)).join(', ')}. A UI component that has it says "also has \`DisplayMode\`" under its name; it is not repeated in the tables.`,
    )
  }
  blocks.push(commonBlock.join('\n\n'))

  const shown = catOrder.filter((cat) => groups.get(cat)!.length > 0)
  blocks.push(
    ['## UI components by category', shown.map((cat) => `- [${cat}](#${anchor(cat)}): ${groups.get(cat)!.map((c) => `[${c.label}](#${anchor(c.label)})`).join(', ')}`).join('\n')].join('\n\n'),
  )

  for (const cat of shown) {
    blocks.push(`## ${cat}`)
    for (const c of groups.get(cat)!) {
      const props = registry.propsOf(c.type)
      const own: PropMeta[] = []
      let hasDisplayMode = false
      for (const p of props) {
        if (c.type !== 'Screen' && isCommon(c, p)) continue
        if (isDisplayMode(p)) {
          hasDisplayMode = true
          continue
        }
        if (COMMON_NAMES.includes(p.name) && c.type !== 'Screen') warnings.push(`${c.type}.${p.name} differs from the common property and is listed in full`)
        own.push(p)
      }

      const lines: string[] = [`### ${c.label}`]
      const facts = [`Type: ${code(c.type)}`]
      if (c.type !== 'Screen') facts.push(`default size ${c.defaultSize.width} x ${c.defaultSize.height}`)
      facts.push(`main property: ${code(c.primaryProp)}`)
      if (hasDisplayMode) facts.push('also has `DisplayMode`')
      lines.push(DESCRIPTIONS[c.type] ?? '(no description)')
      lines.push(facts.join(' · '))

      const kinds: string[] = []
      if (c.isContainer) kinds.push('container')
      if (c.isTemplate) kinds.push('template')
      if (c.isOverlay) kinds.push('overlay')

      const notes: string[] = []
      if (c.isOverlay) {
        notes.push('**Overlay.** Shown above everything else on the screen, and only while `Open` is true. The Studio canvas shows it in place so that its children can be edited.')
      }
      if (c.isTemplate) {
        notes.push('**Template.** The UI components inside it are a template that is repeated for every item in `Items`. Inside the template, `ThisItem` is the current item. The Studio shows one blank template row when `Items` is empty.')
      } else if (c.isContainer) {
        notes.push(
          c.type === 'Screen'
            ? '**Container.** Holds the UI components of the screen. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode.'
            : '**Container.** Holds other UI components. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.',
        )
      }
      if (c.outputs.some((o) => o.name === 'SelectedItems')) {
        notes.push('**Selection.** `Selected` is the first selected item; `SelectedItems` holds all of them.')
      }
      for (const n of NOTES[c.type] ?? []) notes.push(n)

      if (own.length > 0) lines.push(propTable(own))
      else lines.push('No properties of its own beyond the common ones.')

      const outputs = c.outputs.filter((o) => !o.name.startsWith('__'))
      if (outputs.length > 0) {
        lines.push('**Outputs**')
        lines.push(table(['Output', 'Initial value'], outputs.map((o) => [code(o.name), valueText(o.initial)])))
      }
      const events = props.filter((p) => p.kind === 'action').map((p) => code(p.name))
      lines.push(`**Events:** ${events.length ? events.join(', ') : 'none'}.`)
      if (notes.length) lines.push(notes.map((n) => `- ${n}`).join('\n'))
      blocks.push(lines.join('\n\n'))
    }
  }

  return {
    text: page(blocks),
    warnings,
    missingDescriptions,
    counts: { controls: list.length, withScreen: all.length, categories: shown.length },
  }
}
