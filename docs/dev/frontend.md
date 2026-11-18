# Frontend guide

How to extend the browser side: add a control, add an Fx function, use the Studio state store, talk to the platform facade, and style
things. Layout of the code is in `architecture.md`. The shared contract all of it builds on is
`/home/claude/appbuilder-demo/src/contracts.ts` (its header says: do not change it without telling the architect).

Rules that apply to everything below:

- React 19 + TypeScript, strict. Client imports use the `@/` alias for `src/` (`tsconfig.app.json`, `vite.config.ts`).
- Only the control registry and `src/components/ui` import third-party UI libraries (Radix, recharts, react-day-picker, cmdk,
  react-useanimations). Portal and Studio code imports `@/components/ui/*`, never the libraries directly (decision D5).
- Lint is `npm run lint` (oxlint): `react/rules-of-hooks` is an error, `only-export-components` a warning.

## Adding a control

A control is one object of type `ControlType` (see `src/contracts.ts`) plus a React component. Example to copy:
`/home/claude/appbuilder-demo/src/controls/Button.tsx` (actions and an output) and `.../TextInput.tsx` (a value output with a
`Default`).

### 1. Write the component and the descriptor

```tsx
import { Star } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { displayModeProp, toDisplayMode, toNum, toText } from './util'

function StarRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  /* ... */
}

export const Star5: ControlType = {
  type: 'Star5',                 // unique; this string is stored in app definitions: never rename it later
  label: 'Star rating',          // name in the Insert pane
  icon: Star,                    // a lucide-react component
  category: 'Input',             // Layout | Display | Input | Data | Navigation | Feedback | Media | Charts
  props: [ /* PropMeta[] */ ],
  outputs: [{ name: 'Value', initial: 0 }],
  defaultSize: { width: 160, height: 32 },
  primaryProp: 'OnChange',       // the property the formula bar selects first
  render: StarRender,
}
```

Optional flags on `ControlType`: `isContainer` (may hold children), `isTemplate` (children are a per-item template, as in Gallery),
`isOverlay` (rendered above everything when shown, as Dialog and Sheet; the canvas shows it in place).

### 2. Register it (the registry)

The registry is `/home/claude/appbuilder-demo/src/controls/index.ts`. `controls.get(type)` throws for an unknown type;
`controls.list()` returns the insertable controls in Insert-pane order; `controls.propsOf(type)` returns the control's own `props`
followed by the **common properties** added for every control except Screen (`commonProps` in `src/controls/util.ts`): `X`, `Y`,
`Width`, `Height`, `Visible`, `AnchorH`, `AnchorV`, `Grow`, `AlignSelf`, `Tooltip`. Do not declare these yourself.

- Controls grouped in sets are added to the arrays in `src/controls/sets/inputs.ts` or `src/controls/sets/display.ts`; the array
  order is the Insert-pane order. The first group of controls (Label, Button, TextInput, ...) is listed directly in `index.ts`.
- Put new component files under `src/controls/inputs/` or `src/controls/display/`.

### 3. PropMeta

Every property is `{ name, label?, kind, group, default, options?, simple? }`.

| Field | Meaning |
| --- | --- |
| `name` | Property name; a formula in another control reads it as `Control.Name` through outputs or props as the control exposes |
| `kind` | `text`, `number`, `boolean`, `color`, `enum`, `action`, `table`, `any`, `tableName`, `icon`, `record` |
| `group` | `Content`, `Data`, `Layout`, `Style`, `Behaviour` (Properties panel sections) |
| `default` | A **formula string** starting with `=`, e.g. `'="Button"'`, `'=true'`, `'=ButtonStyle.Primary'`, `'=Blank()'` |
| `options` | For `enum`: the member formulas shown in the select, e.g. `['Align.Left', 'Align.Center']` |
| `simple` | `false` puts the property on the Advanced tab only (default true) |
| `label` | Name on the Simple tab if different from `name` |

Kinds drive the editor in the Properties panel (`/home/claude/appbuilder-demo/src/studio/PropertiesPanel.tsx`):

- `text`, `number`, `boolean`, `color`: literal or formula; `color` offers a picker.
- `enum`: a select over `options`. **Every enum named in `options` must exist as a built-in enum in the formula language**
  (`ENUM_RECORDS` in `/home/claude/appbuilder-demo/src/fx/enums.ts`, e.g. `ButtonStyle`, `DisplayMode`, `Align`). Add the enum
  there first, otherwise the default formula fails to evaluate.
- `action`: a behaviour formula run on an event (`OnSelect`, `OnChange`); edited with `;` chaining; default `'=false'` means "nothing".
- `table`: a table-valued formula (`Items`); `tableName`: text naming a platform table (editor: select of tables);
  `record`: a record formula; `any`: anything.
- `icon`: an icon name as text. A lucide name (`"Plus"`, `"arrow-right"`, `"arrow_right"` are all accepted) or an animated icon
  `"anim:<id>"`; the editor is the icon picker (`src/studio/IconPicker.tsx`). Default formulas use the enums: `=Icon.Plus`,
  `=AnimatedIcon.Heart`.

Some shared descriptors exist: `displayModeProp` (Edit/View/Disabled) and `alignProp` in `src/controls/util.ts`.

### 4. Design mode versus run mode

`ControlRenderProps.mode` is `'design'` on the Studio canvas and `'run'` in Preview, the player and the debug window. Rules:

- **In design mode the control must not capture pointer or keyboard input** (the canvas needs the clicks to select and drag): set
  `pointerEvents: 'none'` on interactive elements, `tabIndex={-1}`, `readOnly` or `disabled` where applicable, never call
  `setOutput` or `fire`, and do not autofocus or start timers or network requests.
- In run mode respect `DisplayMode`: `Disabled` renders disabled; `View` renders read-only; only `Edit` fires events.
- The component fills 100% of its wrapper (`size-full`); the canvas and player position and size the wrapper from `X/Y/Width/Height`
  and the anchors. Do not position yourself.
- Evaluated props arrive in `props` as Fx values: strings, numbers, booleans, `Date`, records, tables (arrays of records), `null`
  for blank. **Never trust them**: coerce with the helpers in `src/controls/util.ts` (`toText`, `toNum`, `toBool`, `toColor`,
  `toRecords`, `recordText`, `toDisplayMode`, `fontWeightOf`, `alignOf`). A property whose formula failed arrives as the default's
  value; the error is shown in the Studio, not thrown to you.
- Hooks must be unconditional (lint enforces `rules-of-hooks`).

### 5. Outputs and events

- **Outputs** are values the control publishes for other formulas, e.g. `TextInput1.Value`, `Toggle1.Value`, `Button1.Pressed`. Declare
  them in `outputs: [{ name, initial }]` and write them with `setOutput(name, value)`. Other formulas that read an output are
  invalidated and recalculated automatically (`o:<key>` dependency, see `architecture.md`).
- Keep an output in step with a primitive `Default` property using `useDefaultSync(def, outputs.Value, blankValue, write)` from
  `src/controls/util.ts` (initialises on mount, follows when `Default` changes, re-initialises after a Reset).
- **Events** are `action` properties. Call `fire('OnSelect')` to run the property's formula through the Fx host. Fire only in run
  mode and only when `DisplayMode` is `Edit`.
- Containers receive `children` (already rendered); a template control (Gallery) receives `renderTemplate(item, index)` and renders
  its row template once per item (it sets `ThisItem` for that subtree).
- `focusToken` increases when a formula calls `SetFocus`; focus your main element when it changes.

### 6. Icons, including animated `anim:` icons

- `ControlType.icon` is a lucide-react component for the Insert pane and the tree.
- Inside a control render icons with `AppIcon` (`/home/claude/appbuilder-demo/src/controls/icon/AppIcon.tsx`): `<AppIcon name={...}
  size color />` renders a lucide icon for names like `"Plus"` and an animated icon for `"anim:heart"`. `lucideByName(name)` resolves
  a lucide component from PascalCase, kebab-case or snake_case. Pass `fallback` for blank or unknown names. Controls in
  `src/controls/display/helpers.tsx` and `src/controls/inputs/shared.tsx` wrap it for icon props.
- Animated icons come from the `react-useanimations` package (300 icons). Each icon's Lottie data is a separate lazy module,
  loaded on first use by `src/controls/icon/loader.ts` through `import.meta.glob`. The single-file build inlines them into the HTML
  but evaluates them lazily. The icon box is reserved while data loads so layout does not shift.
- Catalog metadata (title, category, keywords, own interaction) is in `src/controls/icon/catalog.ts` (`parseAnimatedName`).
  `AnimatedIconControl` (`src/controls/icon/AnimatedIconControl.tsx`) is the ready-made control, with an `Interaction` enum
  (`Default`, `Loop`, `Hover`, `HoverLoop`, `HoverReplay`, `ClickReplay`, `ClickToggle`) and an `Active` output.
- In formulas the icons are `AnimatedIcon.<Member>` (`=AnimatedIcon.Heart` evaluates to `"anim:heart"`) and lucide ones `Icon.<Member>`.
  The member list is `ANIMATED_ICON_IDS` in `src/fx/animatedIcons.ts`, a **generated** file. After upgrading `react-useanimations`
  run `node scripts/gen-animated-icons.mjs`; the test `src/fx/animatedIcons.test.ts` fails when the file drifts from
  `react-useanimations/catalog.json`.

### 7. Test and check

- Add a unit test for any logic you extract (coercion, selection math) next to it; component rendering is not unit tested in this
  repository (no DOM test environment: the vitest `environment` is `node`).
- Open the Studio, insert the control, change every property, resize it, switch to Preview and exercise the events and
  `DisplayMode` values. Check both light and dark theme.
- **Docs.** `docs/reference/controls.md` is generated from the registry. Add a one-line description for the new control to
  `DESCRIPTIONS` in `/home/claude/appbuilder-demo/scripts/docs/controls.ts` (the test "every control has a description" fails
  without it), add a note to `NOTES` there if needed, then run `npm run docs:gen` and commit the regenerated page.
- Run `npm run typecheck`, `npm run lint` and `npm test` (see `testing.md`).

## Adding an Fx function

Functions live in `/home/claude/appbuilder-demo/src/fx/functions/` as arrays of `FnDef` (`logicFns`, `textFns`, `mathFns`,
`dateFns`, `tableFns`, `colorFns`, `behaviourFns`) combined in `functions/index.ts` (`ALL`). Create entries with `def`:

```ts
def('Clamp', 'Clamp(value, min, max)', 'Limits a number to a range.', 3, 3, (c) => {
  const v = c.num(0), lo = c.num(1), hi = c.num(2)
  return Math.min(Math.max(v, lo), hi)
})
```

`def(name, signature, summary, min, max, run, kind = 'pure')`:

- `signature` and `summary` are shown in the formula bar's autocomplete and signature help (`fx.functions()`), and will feed the
  generated function reference. Write them for makers, in plain English.
- `min`/`max` are argument counts (`MANY` for variadic); the engine produces the "needs N arguments" error for you.
- `run(c)` gets a `CallCtx` (`functions/types.ts`): `c.argc`, `c.value(i)` (evaluate argument i), `c.text/num/bool(i)` (evaluated and
  coerced, with maker-friendly errors), `c.rows(i, name)` (a table argument), `c.row(i, record, as)` (evaluate lazily per row, with
  `ThisRecord` and `As` names in scope), `c.nameOf(i)` (a bare identifier as a name), `c.fail(i, message)` (raise a maker-facing
  error pointing at an argument), `c.host` (behaviour only), `c.session`.
- Arguments are evaluated **lazily**: only evaluate what you need (`If` does not evaluate the branch it does not take).
- **Pure** functions run in any property and must have no side effects. **Behaviour** functions (`kind: 'behaviour'`, in
  `behaviour.ts`) change state through `c.host` (`setVar`, `navigate`, `patch`, `notify`, ...; see `FxHost` in `src/contracts.ts`) and
  are only allowed in action properties: in a data property the engine reports "Behaviour function in a non-behaviour property".
  `;` chaining is only valid with a host. A function with both forms (`Patch(record, record)` is pure) provides `tryPure` returning
  `NOT_PURE` for the behaviour form.
- Errors are `FxError` (`src/fx/errors.ts`); `fatal` errors (unknown names) are not swallowed by `IfError`.
- User-defined functions (named formulas with parameters, `App.Formulas`) are in `functions/user.ts`; the call depth limit is 64
  (`MAX_UDF_DEPTH`). A built-in name cannot be redefined by a user function.

Docs: `docs/reference/formulas.md` is generated from `fx.functions()`. Add the new function to `CATEGORY_OF` in
`/home/claude/appbuilder-demo/scripts/docs/formulas.ts` (an unmapped function is listed under "Other" with a warning), run
`npm run docs:gen` and commit the page.

Tests: add cases to the matching file in `src/fx/` (`functions.test.ts`, `functions2.test.ts`, `behaviour.test.ts`, `tables.test.ts`,
`udf.test.ts`, ...) using the helpers in `/home/claude/appbuilder-demo/src/fx/testutil.ts`: `val(formula)` returns the value, `err(formula)`
the first error, `run`/`fakeHost` for behaviour functions, `contacts` as sample table data. Test the blank case, the error case and
laziness. Keep results deterministic (no `Now()` without injection).

The formula language itself (lexer, parser, evaluator) is in `src/fx/{lexer,parser,ast,evaluate,values,errors}.ts`; named formulas in
`named.ts`; `signature.ts` supports the signature help.

## The application shell

Routing (`/home/claude/appbuilder-demo/src/router.ts`, hash routes) decides the top level in `/home/claude/appbuilder-demo/src/App.tsx`:

| Route | Rendered by | Notes |
| --- | --- | --- |
| `#run-<appId>` | `RunApp` (standalone) | the player in its own window; debug bar when the Studio of the app is open |
| `#chat` | `src/chat/ChatWindow.tsx` | chat popped out into its own window |
| `#settings`, `#settings-<section>` | `SettingsPage` (`src/portal/Settings.tsx`) inside `Portal` | full window in front of the shell, in the current mode |
| `#admin`, `#admin-<section>` | `AdminConsole` (`src/portal/Admin.tsx`) as a Dev mode page | administrators only |
| everything else | `Portal` (`/home/claude/appbuilder-demo/src/portal/Portal.tsx`) | the shell: Dev mode, User mode, the Studio, the chat dock |

`Portal` renders a `Frame`: the shell (`Shell.tsx`) plus, for `#studio-<appId>`, the Studio in front of it, and the chat dock
(`ChatDock`) on the right of both. The shell is **not unmounted** while the Studio is open (it is hidden), so app tabs keep
their state while you build.

- **Modes.** `modeOfRoute` maps the route to a mode: `#u` and `#u-<appId>` are User mode; the maker pages (`home`, `apps`,
  `tables`, `table-*`, `datafiles`, `roles`, `solutions`, `solution-*`, `connections`, `studio-*`, `admin`) are Dev mode;
  `#settings` and `#soon-<key>` (when the module is listed there) stay in the current mode. Makers and admins (`useCaps()`) get the mode switch; everyone else is
  redirected to `#u` from Dev routes. The last mode is stored per user (`appbuilder-mode:<userId>`) and used when the address has
  no hash, unless Settings > Appearance > Mode at start says Dev or User. The switch returns to the last route of the other mode.
- **User mode state** is in `/home/claude/appbuilder-demo/src/portal/workspace.ts` (`useWorkspace`): open tab ids in order and recently opened apps, per user
  in `localStorage` (`appbuilder-tabs:<userId>`, `appbuilder-recent-apps:<userId>`), every access in try/catch. Helpers:
  `openAppTab(id)` (adds the tab and routes to `#u-<id>`), `openAppWindow(id)` (the `#run-<id>` pop-up, false when blocked),
  `closeAppTab`, `canRun(id)` (role app access through `platform.security.canRunApp`).
- **Tabs** (`/home/claude/appbuilder-demo/src/portal/UserMode.tsx`): `TabStrip` (launcher tab first, middle-click closes), `AppTabPanes` (one
  `<RunApp embedded>` per open tab, inactive ones `display: none`, never unmounted), `MyApps` (launcher), `RunChoice` (the Dev mode
  Run menu). `useTabSync` opens the routed app's tab and drops tabs of deleted apps.
- **Planned modules** come from ONE registry, `/home/claude/appbuilder-demo/src/portal/modules.ts` (`MODULES`): key, label, icon, modes, phase (from
  `docs/plan/master-plan.md`), tagline and 2-3 detail lines, optional `need` (maker/admin) and `action: 'chat'`. The shell's
  navigation renders the entries with a `SoonBadge`; `#soon-<key>` renders `ComingSoon` (`ComingSoon.tsx`) for the entry. To ship
  a module, set `status: 'live'` and `route`: the menu entry then goes to the route, loses the badge and moves up with the
  other pages (out of "Coming soon"). `inMenu: false` marks a planned part of a live module that has no menu entry of its own
  (Admin console > Backups, Server logs, Usage). `modules.test.ts` checks the registry.
- **Chat dock** (`/home/claude/appbuilder-demo/src/chat/`): `ChatDock side` is `usePrefs().chatSide` (Frame renders it left or
  right of the shell and the Studio); with `chatRestore` off, Frame closes the dock once at start. `dock.ts` holds the dock state (`useChatDock`: open, width, popped out; open and width in
  `localStorage` `appbuilder-chat-dock`), `link.ts` the coordination with the pop-out window (BroadcastChannel `appbuilder-chat`,
  falling back to `storage` events, plus a heartbeat key the pop-out refreshes every 3 s so a main window can tell whether it is
  still open), `ChatDock.tsx` the panel and `ChatButton`, `ChatWindow.tsx` the `#chat` page. **`ChatPanel.tsx` is the only
  component the chat module replaces**; today it renders the "coming soon" state. `startChatDockSync()` runs once in `Portal`.
- **Design sizes**: presets and the size rule are in `/home/claude/appbuilder-demo/src/runtime/sizes.ts` (`SIZE_PRESETS`, `sizeError`, `deviceOf`),
  the picker is `/home/claude/appbuilder-demo/src/portal/SizePicker.tsx` (New app, Start with data, App settings). `surfaceSize` in
  `src/runtime/layout.ts` keeps a portrait design at its size (scaled to fit, centred) in a landscape area and fills a portrait
  one. The Start with data generator (`addDataScreenContent` in `src/portal/actions.ts`) has a desktop, a portrait and a phone
  (list screen + form screen) layout.
- **Top bar** (`Shell.tsx`), right end, in this order (as in Power Platform): theme toggle and, in Dev mode, the storage badge;
  then `ChatButton`, `EnvironmentPicker` (`src/portal/EnvironmentPicker.tsx`) and `ProfileAvatar` (`src/portal/Profile.tsx`) last.
  The Studio command bar ends with the same `ProfileAvatar`.
  - `EnvironmentPicker` shows `platform.environments.current()` as "Default · Production" (`TypeBadge`); the menu lists
    `usePlatform((s) => s.environments)`, gets a search box from 7 entries (`SEARCH_FROM`) and, for administrators,
    **Manage environments** (`#admin-environments`). Selecting calls `platform.environments.select(id)`.
  - `ProfileAvatar`: `UserAvatar` (initials; colour from `avatarColorOf(userId, choice)`: the user's own choice for their
    avatar, otherwise derived from the id), a tooltip with name and email, and a menu: header, Profile settings, Settings,
    Change password (server), the demo switch-user list (`platform.security.setCurrentUser`, demo only, plus Manage users for
    admins) and Sign out (server). `useMe()` returns the signed-in (server) or run-as (demo) user. The old `UserMenu` is gone.
- **Environments API** (`platform.environments`, both backends; contract in `src/platform/contracts.ts`): `list()`,
  `current()`, `select(id)`, state `environments` / `environmentId`. Today both backends return one built-in environment
  `{ id: 'default', name: 'Default', type: 'production', builtIn: true }`: the server from `server/core/environments.ts`
  (`GET /api/v1/environments`, also in `GET /workspace`; administrators get `details: { database, schemaVersion }`), the demo
  core in `core.ts`. The selected id is remembered per user (`appbuilder-environment:<userId>`, `src/platform/environments.ts`).
  Creating environments arrives with P0; the UI needs no change when the list grows.
- **Settings** (`src/portal/Settings.tsx`): opened from `SettingsEntry` at the bottom of the sidebar (both modes) or the avatar
  menu, through `openSettings(section?)` (`Profile.tsx`), which remembers the route to return to; `settingsReturnRoute()` is what
  Back, the x and Esc go to. `Frame` renders it in front of the shell like the Studio (the shell stays mounted and hidden, so app
  tabs keep their state). Sections: profile, appearance, region, notifications, chat, studio (makers), data, admin (admins),
  about; `settingsSections(caps)` decides which a user sees. **Rule:** a control is real only when its backing exists; otherwise
  render it with `Row soon="..."` (disabled, `SoonBadge`, one line naming what arrives and the phase). Never a working-looking
  control that does nothing.
- **Preferences store** (`src/platform/preferences.ts`, `usePrefs`): the ONE place for per-user client preferences (theme,
  reduce motion, start mode, avatar colour, chat dock side and restore, Studio default size, snap and grid). JSON in
  `localStorage` under `appbuilder-prefs:<userId>` with a version, every access in try/catch, validated field by field by
  `parsePrefs` (so it can move to a server endpoint later without changing callers). `Frame` calls `usePrefs.getState().load(user)`.
  The theme is also written to `appbuilder-theme` because the sign-in screens are drawn before a user is known.
  `startPreferenceEffects()` (`src/portal/theme.ts`, called once in `App.tsx`) applies theme and motion and follows the
  operating system (`prefers-color-scheme`, `prefers-reduced-motion`). Reduced motion sets `html.reduce-motion` (CSS in
  `index.css` turns transitions and animations off, spinners excepted) and `useReducedMotion()` stops animated icons
  (`AppIcon`). `exportPreferences()` and `clearLocalData()` (every `appbuilder*` key) back Settings > Data and privacy.
  Add a new preference there: a field in `Preferences`, a default, a line in `parsePrefs`, then use `usePrefs((s) => s.x)`.
- **Admin console** (`src/portal/Admin.tsx`, module `admin` in `modules.ts` is `status: 'live'`, route `#admin`): its own
  sub-navigation (`ADMIN_SECTIONS`): Environments (table + details, disabled New environment), Users (`UsersPanel` in
  `src/portal/Users.tsx`, the primary place for user management; Security roles links to it and back), Licences (current
  state and the planned passes, counts derived from roles and labelled preview; nothing enforced), Audit log (server mode:
  `fetchAuditPage` in `serverApi.ts` over `GET /api/v1/audit`, 50 per page, filters action, user, dates), and Backups, Server
  logs, Usage rendered by `ComingSoon` with `embedded` from registry entries that have `inMenu: false`.
- The theme of the shell, the Studio and the chat window is one value, `useUi().theme`; the user's choice (light, dark,
  system) is `usePrefs().theme`, and `useTheme().toggle` (`src/portal/theme.ts`) sets an explicit light or dark.
- Build-time constants (`vite.config.ts` `define`, declared in `src/build-info.d.ts`): `__APP_VERSION__` (package.json) and
  `__THIRD_PARTY__` (the summary table of `THIRD-PARTY-NOTICES.md`), shown in Settings > About.

## The Studio state store

App state lives in zustand stores with immer, created by `createAppStore()` in `/home/claude/appbuilder-demo/src/runtime/store.ts`. Each store holds
both the **definition** and the **runtime state** of one app.

- **The shared store**, `appStore` with its hook `useStore`, is used by the Studio, its Preview and the standalone player
  (`#run-<id>`). Studio code keeps using `useStore` / `useStore.getState()`.
- **Every app tab has its own store**: `RunApp embedded` calls `createAppStore({ run: true })`, links it to the platform with
  `linkStore(store, { scoped: true })` (data key, current user, its tables; refused writes are reported only for its own data
  sources) and provides it through `AppStoreContext` (`/home/claude/appbuilder-demo/src/runtime/context.ts`). So two open apps never share variables,
  collections, outputs, navigation, toasts or the debug log.
- Runtime components (`ScreenView`, `RenderNode`, `RunSurface`, `Toasts`) read **the surrounding store** with `useAppStore(selector)`
  and `useAppStoreApi()`; outside a provider that is the shared store. New runtime components must do the same: never import
  `useStore` in code that can run inside an app tab.
- Each store has its own evaluator cache (`evSlot`, an `EvaluatorSlot`), its own log and exit listeners (`subscribeLog`,
  `subscribeExit`; `onLog`/`onExit` are the shared store's) and a `runSurface` flag (events fire although `mode` is `design`).
- User-defined functions: the formula engine holds one active set. Every `Evaluator` re-registers its app's set right before it
  evaluates (`useUdfs()`, a reference comparison when nothing changed), so apps with different (or same-named) functions can be
  mounted together. `parseNamedFormulas` checks names against built-ins only.
- `src/runtime/instances.test.ts` proves the isolation (two stores: variables, collections, navigation, UDFs, log listeners).

- Definition and editor state (`StudioState`): `app` (the `AppDef`), `appId`, `loadState`, `saveState` (`saved|saving|unsaved|error`),
  `selection`, `currentScreenId`, `mode` (`design|preview`), `env` (actual size of the rendering surface), `history`
  (`past`/`future` snapshots with coalescing by key), `epoch` (bumps when the whole app is replaced).
- Editing actions, all undoable: `setProp(id, prop, formula, coalesceKey?)`, `setAppProp`, `setAppSettings`, `setGeometry`, `nudge`,
  `align`, `insert(type, opts)`, `remove`, `rename` (also rewrites references in formulas via `fx.renameIdentifier`), `copy`/`paste`
  /`duplicate`, `reorder`, `reparent`, `moveNode`, `addScreen`/`deleteScreen`, `undo`/`redo`, `addDataSource`/`removeDataSource`.
  Never mutate `app` outside these actions; they keep names unique, ids stable and history consistent.
- Runtime (`RuntimeState`): `vars`, per-screen `context`, `collections`, `outputs` (keyed per control instance, including gallery row
  keys), `resetKeys`, `focusKeys`, `formModes`, `navStack`, `toasts`, `dataKey`, `userId`, `exited`.
- Runtime actions: `fire(nodeId, event, ctx?)` runs an action property through the Fx host (`src/runtime/host.ts`), `runOnStart`,
  `restartRuntime`, `startPreview`/`exitPreview`, `navigateTo`, `setOutput`, `notify`, logging (`log`, `onLog`).
- `loadApp(id, def, opts)` replaces everything; `replaceDefinition(def)` is a hot reload that keeps runtime state (used when another
  window saved). Autosave lives in `src/runtime/session.ts` (debounced `platform.apps.save`, broadcast over `src/runtime/channel.ts`).
- UI-only state (panes, zoom, pan, theme) is a separate store, `useUi` in `src/runtime/ui.ts`. Per-app UI prefs and the control
  clipboard use `localStorage` (`src/runtime/persist.ts`).
- Read from components with a selector: `useStore((s) => s.selection)`. Do not select the whole store (re-renders on every change).
- `window.__ab` (store, ui, evaluator, `sampleApp`, and `tabs`: a map from app id to the store of each mounted app tab) is exposed
  for browser checks and debugging.

Formula evaluation reads a store through `evaluatorOf(state)` (the state's own `evSlot`); `getEvaluator` remains for callers
without a store. See `architecture.md` for scopes and dependency tracking.

## Platform facade usage

All data and workspace access goes through `platform` from `/home/claude/appbuilder-demo/src/platform/index.ts`. Never call `fetch`
for API routes from components; `serverApi.ts` (`/home/claude/appbuilder-demo/src/portal/serverApi.ts`) exists for the few portal-only
calls (for example the security preview) and builds on the same session.

- **Initialisation**: `platform.init()` is called once in `src/App.tsx`. It probes `GET /api/v1/status` (800 ms) and selects the
  server implementation (`createRemotePlatform`, `mode: 'server'`) or demo mode (`createPlatform(demoStorage)`, `mode: 'demo'`).
  Methods that need a backend wait for init.
- **Reactive state in React**: `usePlatform((s) => s.tables)` (selector over `WorkspaceState`; uses `useSyncExternalStore` with shallow
  equality, so select the smallest slice you need). `platform.getState()` for non-React code, `platform.subscribe(fn)`.
- **Rows are lazy**: `platform.tables.rows(name)` returns the cached rows and, when the table is not loaded yet, **returns `[]` and
  schedules a load**; the state notifies when rows arrive. Call `await platform.tables.ensureLoaded(['Orders', 'Customers'])` when you
  need the rows first (the runtime does this for an app's `dataSources` in `linkPlatform()` and for tables used by formulas).
  `ensureLoaded` is idempotent. Row lists are capped at 5,000 rows per table by the server; `WorkspaceState.truncated` lists the table names whose query hit the cap
  (the UI warns about it).
- **Writes** are optimistic: `platform.tables.insert(table, values)`, `update(table, rowId, changes)` and `delete(table, ids)` are synchronous. They validate locally (required, unique, type coercion and the mirrored privileges: they throw `PlatformError` `denied` or `invalid`), update the cache immediately and return the row; the request is sent in order afterwards. If the server refuses, the cache is rolled back and listeners of `platform.onDataError(listener)` get a
  `DataErrorEvent { table, op: 'create'|'update'|'delete', rowIds, error }` (`error.code` is the API error code). **Subscribe to
  `onDataError` anywhere you show data changes** and tell the maker what happened; the runtime does so in `linkPlatform()`
  (a toast in preview and a log entry). `platform.tables.flush()` waits for pending writes and rejects with the first error.
- **Errors**: methods throw `PlatformError` (code, message, optional field). Show `error.message`; it is already written for makers.
- **Security UI**: use `useMyAccess(table)` and `useCaps()` from `src/portal/security.ts` to hide or disable actions; they only mirror
  the server (see `security-engine.md`).
- **Demo mode** has no server: functions that need one (connections, data files, attachments, users and passwords) fail with a
  message such as "This needs the local server". Do not assume they work when you add UI; gate with `usePlatform((s) => s.mode)`.

## Styling

- Tailwind CSS 4 plus CSS variables defined in `/home/claude/appbuilder-demo/src/index.css`. Use the semantic utilities, not raw colours:
  `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `bg-primary text-primary-foreground`, `bg-secondary`,
  `bg-accent`, `bg-muted`, `border-border`, `ring-ring`, `text-destructive`, `bg-canvas` (the Studio canvas background),
  `rounded-md` / `rounded-lg` (radius is `--radius`, 0.5rem), `font-sans` (Inter, then system fonts), `font-mono`.
- Tokens are defined for `:root` (light) and `.dark`. The dark theme is toggled by a class on the root; the preference is in
  `localStorage` (`appbuilder-theme`, see `src/runtime/ui.ts`). Any new UI must work in both themes: use the tokens and check it.
- Body text is 13 px (`index.css`); the Studio is dense. The app being built is drawn at its design size and scaled
  (`scaleMode` `responsive` or `fit`), so control components use pixel props from the maker (`Size`, `Radius`) and fill their wrapper.
- Reusable primitives are in `/home/claude/appbuilder-demo/src/components/ui/` (shadcn-style wrappers over Radix). Add new primitives
  there, not inline, and import them from `@/components/ui/...`. Use `cn` from `@/lib/utils` to join class names.
- Icons: lucide-react for the product UI.
- What is not supported: no CSS-in-JS and no per-app custom CSS; makers style controls only through their properties.
