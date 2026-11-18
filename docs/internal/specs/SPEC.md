# Appbuilder Studio demo: build spec

Goal: a front-end-only Studio the owner can open and *feel*: drag controls onto a canvas, move/resize them, type Excel-style formulas into a formula bar, see the canvas react live, press Preview and use the app. No backend. Data = in-memory collections, saved to localStorage. If he likes the feel, the real platform gets built; if not, it stops here. Interaction quality matters more than feature count.

Stack (already installed, do not add dependencies without need): Vite, React 19, TypeScript (strict), Tailwind v4 (tokens in `src/index.css`), Radix primitives, lucide-react, zustand + immer, vitest. Alias `@/` = `src/`. `cn()` in `@/lib/utils`. shadcn CLI is NOT reachable (network allowlist); shadcn components are hand-written in `src/components/ui` to the standard shadcn API.

`src/contracts.ts` is binding. Read it first.

Ownership (do not write outside your area; do not run git):
| area | owner |
| --- | --- |
| `src/fx/**` | Fx agent |
| `src/components/ui/**`, `src/controls/**` | Controls agent |
| `src/runtime/**`, `src/studio/**`, `src/App.tsx`, `src/main.tsx` | Studio agent |

## 1. Fx engine (`src/fx`)
Pure TypeScript, zero dependencies, no React/DOM. `export const fx: FxApi` from `src/fx/index.ts` (also named exports of each method).

Syntax (Excel-style, own implementation; Power Fx is behavioural reference only):
- leading `=` required; rest is one expression. Empty expression (`=`) evaluates to blank.
- literals: numbers (`12`, `3.5`), strings in double quotes with `""` escape, `true`/`false`, records `{Name: "A", Age: 3}`, tables `[1, 2, 3]` (table of `{Value: n}` records) and `Table({..},{..})`.
- string interpolation `$"Hi {Name}!"`.
- operators by precedence low→high: `;` (chain, returns last; behaviour only), `||` `Or`, `&&` `And`, `=` `<>` `<` `>` `<=` `>=` `in` `exactin`, `&` (concat), `+ -`, `* /`, `^`, unary `-` `!` `Not`, postfix `%`, member `.`, call `()`.
- `=` is case-insensitive for text; `in` is case-insensitive substring / membership.
- identifiers: `[A-Za-z_][A-Za-z0-9_]*`, or `'quoted name'`. Function names case-insensitive on lookup? No: exact case, but report "Did you mean Filter?" when a case-insensitive match exists.
- comments `//` and `/* */`.
- member access on a table of records returns the column as a table? No. Keep simple: `.` on record → field (blank when missing); on blank → blank; on anything else → error.
- name resolution order: row scope fields (innermost first) → `ThisRecord` → names bound by `With`/`As` → built-in enums → `FxScope.resolve`. Unknown → error diagnostic at the identifier span.
- blank handling: arithmetic treats blank as 0, concat treats blank as "", comparisons with blank follow blank = blank true.
- errors: evaluation never throws out of `evaluate`; first error wins, with a source span.

Built-in enums (plain records): `Color` (Red, Green, Blue, Black, White, Gray, LightGray, Orange, Yellow, Purple, Transparent… CSS strings), `Align` (Left, Center, Right), `FontWeight` (Normal, Semibold, Bold), `DisplayMode` (Edit, View, Disabled), `SortOrder` (Ascending, Descending), `NotificationType` (Information, Success, Warning, Error), `ButtonStyle` (Primary, Secondary, Outline, Ghost, Destructive). Members evaluate to their own name as text except Color (CSS colour).

Functions (pure): If, Switch, And, Or, Not, IsBlank, IsEmpty, Blank, Coalesce, IfError, With · Text (number/date formats: `"0.00"`, `"#,##0"`, `"dd/mm/yyyy"`, `"yyyy-mm-dd"`, `"hh:mm"`), Value, Len, Left, Mid, Right, Lower, Upper, Proper, Trim, Concatenate, Concat(table, expr, sep), Substitute, Replace, Find, StartsWith, EndsWith, Split · Round, RoundUp, RoundDown, Int, Abs, Mod, Sqrt, Power, Min, Max, Sum, Average, Rand, RandBetween · Now, Today, DateAdd(date, n, "Days|Months|Years|Hours|Minutes"), DateDiff, Date(y,m,d), Year, Month, Day, Hour, Minute, Weekday · Filter, Search(table, text, "col1", ...), LookUp(table, cond [, result]), Sort(table, expr [, SortOrder]), SortByColumns(table, "col" [, SortOrder]), First, Last, FirstN, LastN, Index, Distinct(table, expr), AddColumns(table, "name", expr, ...), DropColumns, ShowColumns, CountRows, CountIf, ForAll(table, expr), Sequence(n [, start]), Table, Defaults(collection) (returns `{}`) · RGBA(r,g,b,a) → `rgba(...)` string, ColorValue(text), ColorFade(color, pct).
Sum/Average/Min/Max accept `(table, expr)` or scalars. Row-scope functions evaluate their expression arguments lazily per row with the row's fields in scope, plus `ThisRecord`; support `Table As Name`.

Functions (behaviour; error without host): Set(name, value), UpdateContext(record), Collect(coll, item|table, ...), ClearCollect, Clear(coll), Remove(coll, record), RemoveIf(coll, cond), Patch(coll, base, changes) → record, UpdateIf(coll, cond, changes), Navigate(Screen), Back(), Notify(text [, NotificationType]), Reset(Control), Refresh(coll) (no-op). First argument of Set/Collect/ClearCollect/Clear/Remove/RemoveIf/Patch/UpdateIf/Reset/Navigate/Defaults is taken as an identifier NAME (not evaluated) when it is a bare identifier. For Remove/RemoveIf/UpdateIf the engine reads current rows via `scope.resolve(collName)`. Every stored record carries a hidden `__id` string; the engine must preserve unknown fields including `__id` through Filter/Sort/AddColumns etc., and `ShowColumns` keeps `__id`.

Tests: vitest, `src/fx/*.test.ts`, at least 120 assertions covering every function, operators, precedence, row scope, nested scopes, errors with spans, behaviour via a fake host, `referencedNames`, `renameIdentifier`. `npm test` must pass.

## 2. UI primitives + controls (`src/components/ui`, `src/controls`)
`src/components/ui`: hand-written shadcn components, standard shadcn file names/exports/props (Tailwind v4, tokens from index.css, `data-slot` optional): button (variants default/secondary/outline/ghost/destructive/link; sizes default/sm/xs/icon/icon-sm), input, textarea, label, checkbox, switch, select, tabs, tooltip, dropdown-menu, dialog, popover, scroll-area, separator, badge, toggle-group (hand-rolled if no radix pkg). Studio density is compact: `sm` = h-8, `xs` = h-7 text-xs.

`src/controls/index.ts`: `export const controls: ControlRegistryApi`. One file per control. Runtime controls must look like a clean modern product (shadcn look), and take colours/sizes from their evaluated props so formulas visibly change them.

Common props added by the registry to every non-Screen control (group Layout): X `=40`, Y `=40`, Width, Height (from defaultSize), Visible `=true`. `DisplayMode` (`=DisplayMode.Edit`) on input controls + Button.

| type | props (default) | outputs | notes |
| --- | --- | --- | --- |
| Screen | Fill `=Color.White`, OnVisible (action) | | container, not insertable |
| Label | Text `="Label"`, Size `=14`, Color `=RGBA(24,24,27,1)`, FontWeight, Align, Fill `=Color.Transparent`, Italic? no | | primary Text |
| Button | Text `="Button"`, OnSelect `=false` (action), Style `=ButtonStyle.Primary`, Fill (blank = style default), Color, Size `=14`, Radius `=8`, DisplayMode | Pressed | primary OnSelect |
| TextInput | Default `=""`, Placeholder `="Type here"`, OnChange (action), Size, DisplayMode | Value | Reset → Default; when Default's evaluated value changes, Value follows |
| Checkbox | Text `="Option"`, Default `=false`, OnChange | Value | |
| Toggle | Default `=false`, OnChange, Text | Value | |
| Dropdown | Items `=["One","Two","Three"]`, Default `=""`, OnChange, Placeholder | Selected (record), SelectedText | Items may be table of `{Value}` or records (show first text field) |
| Image | Image `=""` (URL), Fit enum, Radius | | placeholder icon when empty |
| Rectangle | Fill `=RGBA(228,228,231,1)`, Radius `=8`, BorderColor, BorderWidth `=0` | | |
| Container | Fill `=Color.White`, Radius `=12`, BorderColor, BorderWidth `=1`, Shadow `=true` | | isContainer; children absolutely positioned inside |
| Gallery | Items `=[]` (table), TemplateHeight `=64`, Gap `=8`, OnSelect, Fill, ShowDividers? no | Selected (record), SelectedIndex | isContainer; children = row template; vertical scrolling list; clicking a row sets Selected then fires OnSelect; uses `renderTemplate(item, i)` |

In `mode: 'design'` renderers must set `pointer-events: none` on interactive internals (the canvas owns the pointer) and never autofocus. In `run` they are fully interactive. Outputs are written only through `setOutput`.

## 3. Runtime (`src/runtime`) and Studio (`src/studio`)
### Runtime
One zustand store (immer). State: `app: AppDef`, `selection: string[]` (node ids), `currentScreenId`, `mode: 'design' | 'preview'`, runtime `{ vars, context, collections: Record<string, FxRecord[]>, outputs: Record<nodeId, Record<string, FxValue>>, navStack, toasts }`, `history` (undo/redo of `app` only, max 100, coalesce drags and typing bursts into one step), `clipboard`.
- Evaluation: a `RenderNode` component evaluates each property of its node on render with `fx.evaluate(formula, scope)`, where scope resolves: `ThisItem` (when inside a gallery row), `Self`, `Parent`, control names (record = evaluated props ∪ outputs; evaluate lazily and guard against cycles: a cycle → error "Circular reference"), variables, context vars, collections, screen names (text). Components subscribe to the store so any runtime change re-renders. Simplicity over cleverness: re-evaluate on render, memoise per (formula, runtime version). This is a demo; correctness and feel first.
- Failed formula → use the registry default for rendering, record the error in `errors[nodeId][prop]` for the Studio to show.
- Events: `fire(nodeId, event, rowItem?)` evaluates the action formula with an `FxHost` bound to the store. All host writes inside one fire are applied in one store update.
- Collections get `__id` on insert. Seed data lives in `app`? No: seed in `src/runtime/sample.ts`; collections persist in localStorage with the app.
- `App.OnStart` runs when preview starts and once on load (design), so the sample data exists while designing.
- Persistence: autosave `app` + collections to localStorage (debounced); Export / Import JSON file; "Reset to sample".

### Studio shell (own visual identity; generic editor layout, no Microsoft assets, names or purple)
```
┌ command bar 44px: logo "Appbuilder" · app name (editable) │ Undo Redo │ Insert ▾ │ New screen │ … right: theme toggle · Export · Preview ▶ (primary)
├ formula bar 40px: [property select 180px] fx [ formula editor grows; expands to multi-line on focus ] error text below when invalid
├──────────┬──────────────────────────────────────────┬──────────────┤
│ rail 44  │ canvas (bg --canvas, dotted grid 16px)   │ properties   │
│ + pane   │ screen frame centred, shadow, zoomable   │ 300px        │
│ 264px    │                                          │ Simple│Adv.  │
├──────────┴──────────────────────────────────────────┴──────────────┤
│ status 28px: breadcrumb Screen1 › Container1 › Button1 · errors count · zoom − 100% + fit
```
Left rail icons → panes: Tree (screens + nested controls, click select, double-click rename, drag to reorder not required, context menu: Rename, Duplicate, Delete, Bring to front, Send to back), Insert (search + controls grouped by category; click inserts at centre of current container/screen; drag from pane onto canvas inserts at drop point, into the container under the pointer), Data (collections with row counts, table preview of first 20 rows), Variables (globals + context with current values).

Canvas interactions (the heart of the demo; make them feel solid):
- click selects; shift-click multi-select; click empty screen selects the Screen; Escape selects parent.
- selected control: 1.5px primary outline, 8 square handles, name tag above top-left.
- drag to move (4px threshold), resize by handles, both snap to an 8px grid (hold Alt = free), smart alignment guides against siblings (edges + centres) with snap at 5px.
- arrow keys nudge 1px, shift+arrow 8px; Delete/Backspace deletes; Ctrl/Cmd+C/V/D copy/paste/duplicate; Ctrl/Cmd+Z / Shift+Z undo/redo. Shortcuts must not fire while typing in an input/textarea.
- moving/resizing writes numeric formulas (`=120`) to X/Y/Width/Height. If the existing formula is not a plain number, still overwrite (demo rule).
- dragging a control over a Container/Gallery reparents it on drop (coordinates converted); highlight the drop target.
- Gallery in design: rows render live from Items; the FIRST row is the editable template (its children are selectable/movable); other rows are non-interactive previews, slightly dimmed.
- zoom 25–200% (Ctrl+wheel and status-bar buttons), fit on load; pan with wheel/trackpad, space+drag.
- hold Alt and click a control on the canvas = run its event without entering preview (nice-to-have).
- formula errors: small red badge on the control's corner; tooltip = message.

Formula bar:
- property select lists all props of the selected control (grouped), remembers last prop per control type; default = `primaryProp`.
- editor: monospace textarea (auto-grow up to 6 lines) showing the formula WITHOUT forcing the maker to type `=` (show a fixed `=` prefix; store with `=`). Live: every keystroke that parses updates the app (canvas reacts immediately); invalid text keeps the last good value in the app until blur and shows the error.
- autocomplete popup: functions (with signature + summary), control names, after `Control.` its props+outputs, enum members after `Color.` etc., collection names, variables, `ThisItem.` fields when inside a gallery (fields from first row of evaluated Items). Tab/Enter accepts, Esc closes.
- result preview chip under the bar for data properties: evaluated value (truncated) and type (Text, Number, Boolean, Table(n), Record, Blank).

Properties panel (generated from registry metadata, no per-control code):
- header: control icon, editable name (unique; renaming rewrites every formula via `fx.renameIdentifier`), type.
- Simple tab: grouped sections; editor by kind: text → input, number → number input with drag-scrub optional, boolean → switch, color → swatch + popover (preset palette + hex), enum → select, table/action/any → read-only formula snippet with "Edit in formula bar" (focuses bar on that prop). If a property's formula is not a simple literal, the Simple editor shows an `fx` pill with the formula text and clicking it focuses the formula bar.
- Advanced tab: every property as label + single-line monospace formula input, search box on top, error text per row.

Preview: full-window overlay, app scaled to fit, top strip with Back to edit (Esc), restart. Toasts for Notify. Navigate switches screens.

Sample app loaded on first run (must show off formulas immediately):
- `App.OnStart`: `ClearCollect(Contacts, Table({Name:"Asha Rao", Company:"Northwind", City:"Pune", Active:true}, … 8 rows))`.
- Screen "Home": title Label; TextInput `SearchBox`; Label with `="Showing " & CountRows(ContactList.Items)…` or equivalent; Gallery `ContactList` with `Items = Filter(Contacts, SearchBox.Value in Name || SearchBox.Value in Company)` and a template of two Labels (`ThisItem.Name`, `ThisItem.Company & " · " & ThisItem.City`) and a small delete Button `Remove(Contacts, ThisItem)`; a detail Container on the right bound to `ContactList.Selected`; an "Add contact" Button → `Navigate(AddScreen)`.
- Screen "AddScreen": three TextInputs, Toggle, Save button `Patch(Contacts, Defaults(Contacts), {Name: NameInput.Value, …}); Reset(NameInput); Notify("Saved", NotificationType.Success); Back()`, Cancel `Back()`.

Quality bar: `npm run typecheck`, `npm test`, `npm run build` all clean. No console errors. Light and dark themes both legible. Works at 1280×720 and up.
