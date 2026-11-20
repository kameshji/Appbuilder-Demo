# Frontend guide

How to extend the browser side: add a UI component, add an Fx function, use the Studio state store, talk to the platform facade, and style
things. Layout of the code is in `architecture.md`. The shared contract all of it builds on is
`/home/claude/appbuilder-demo/src/contracts.ts` (its header says: do not change it without telling the architect).

Rules that apply to everything below:

- React 19 + TypeScript, strict. Client imports use the `@/` alias for `src/` (`tsconfig.app.json`, `vite.config.ts`).
- Only the UI component registry and `src/components/ui` import third-party UI libraries (Radix, recharts, react-day-picker, cmdk,
  react-useanimations). Portal and Studio code imports `@/components/ui/*`, never the libraries directly (decision D5).
- Lint is `npm run lint` (oxlint): `react/rules-of-hooks` is an error, `only-export-components` a warning.

## Adding a UI component

A UI component is one object of type `ControlType` (see `src/contracts.ts`) plus a React component. Example to copy:
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
`controls.list()` returns the insertable UI components in Insert-pane order; `controls.propsOf(type)` returns the UI component's own `props`
followed by the **common properties** added for every UI component except Screen (`commonProps` in `src/controls/util.ts`): `X`, `Y`,
`Width`, `Height`, `Visible`, `AnchorH`, `AnchorV`, `Grow`, `AlignSelf`, `Tooltip`. Do not declare these yourself.

- UI components grouped in sets are added to the arrays in `src/controls/sets/inputs.ts` or `src/controls/sets/display.ts`; the array
  order is the Insert-pane order. The first group of UI components (Label, Button, TextInput, ...) is listed directly in `index.ts`.
- Put new component files under `src/controls/inputs/` or `src/controls/display/`.

### 3. PropMeta

Every property is `{ name, label?, kind, group, default, options?, simple? }`.

| Field | Meaning |
| --- | --- |
| `name` | Property name; a formula in another UI component reads it as `Control.Name` through outputs or props as the UI component exposes |
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

- **In design mode the UI component must not capture pointer or keyboard input** (the canvas needs the clicks to select and drag): set
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

- **Outputs** are values the UI component publishes for other formulas, e.g. `TextInput1.Value`, `Toggle1.Value`, `Button1.Pressed`. Declare
  them in `outputs: [{ name, initial }]` and write them with `setOutput(name, value)`. Other formulas that read an output are
  invalidated and recalculated automatically (`o:<key>` dependency, see `architecture.md`).
- Keep an output in step with a primitive `Default` property using `useDefaultSync(def, outputs.Value, blankValue, write)` from
  `src/controls/util.ts` (initialises on mount, follows when `Default` changes, re-initialises after a Reset).
- **Events** are `action` properties. Call `fire('OnSelect')` to run the property's formula through the Fx host. Fire only in run
  mode and only when `DisplayMode` is `Edit`.
- Containers receive `children` (already rendered); a template UI component (Gallery) receives `renderTemplate(item, index)` and renders
  its row template once per item (it sets `ThisItem` for that subtree).
- `focusToken` increases when a formula calls `SetFocus`; focus your main element when it changes.

### 6. Icons, including animated `anim:` icons

- `ControlType.icon` is a lucide-react component for the Insert pane and the tree.
- Inside a UI component render icons with `AppIcon` (`/home/claude/appbuilder-demo/src/controls/icon/AppIcon.tsx`): `<AppIcon name={...}
  size color />` renders a lucide icon for names like `"Plus"` and an animated icon for `"anim:heart"`. `lucideByName(name)` resolves
  a lucide component from PascalCase, kebab-case or snake_case. Pass `fallback` for blank or unknown names. UI components in
  `src/controls/display/helpers.tsx` and `src/controls/inputs/shared.tsx` wrap it for icon props.
- Animated icons come from the `react-useanimations` package (300 icons). Each icon's Lottie data is a separate lazy module,
  loaded on first use by `src/controls/icon/loader.ts` through `import.meta.glob`. The single-file build inlines them into the HTML
  but evaluates them lazily. The icon box is reserved while data loads so layout does not shift.
- Catalog metadata (title, category, keywords, own interaction) is in `src/controls/icon/catalog.ts` (`parseAnimatedName`).
  `AnimatedIconControl` (`src/controls/icon/AnimatedIconControl.tsx`) is the ready-made UI component, with an `Interaction` enum
  (`Default`, `Loop`, `Hover`, `HoverLoop`, `HoverReplay`, `ClickReplay`, `ClickToggle`) and an `Active` output.
- In formulas the icons are `AnimatedIcon.<Member>` (`=AnimatedIcon.Heart` evaluates to `"anim:heart"`) and lucide ones `Icon.<Member>`.
  The member list is `ANIMATED_ICON_IDS` in `src/fx/animatedIcons.ts`, a **generated** file. After upgrading `react-useanimations`
  run `node scripts/gen-animated-icons.mjs`; the test `src/fx/animatedIcons.test.ts` fails when the file drifts from
  `react-useanimations/catalog.json`.

### 7. Test and check

- Add a unit test for any logic you extract (coercion, selection math) next to it; component rendering is not unit tested in this
  repository (no DOM test environment: the vitest `environment` is `node`).
- Open the Studio, insert the UI component, change every property, resize it, switch to Preview and exercise the events and
  `DisplayMode` values. Check both light and dark theme.
- **Docs.** `docs/reference/ui-components.md` is generated from the registry. Add a one-line description for the new UI component to
  `DESCRIPTIONS` in `/home/claude/appbuilder-demo/scripts/docs/controls.ts` (the test "every UI component has a description" fails
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
  (`MAX_UDF_DEPTH`). A built-in name cannot be redefined by a user function. They belong to an **engine instance**
  (`src/fx/engine.ts`): `createEngine({ formulas })` parses App.Formulas into user functions and named formulas;
  `engine.setUserFunctions` / `setNamedFormulas` / `setFormulas` replace them on that instance only. The built-ins are shared and
  immutable; the function table is passed explicitly into evaluation (`FunctionTable` in `functions/index.ts`), never global.
- The engine is **shared with the server** (architecture rule 3): inside `src/fx` import with relative paths and an explicit `.ts`
  extension (`import { toText } from '../values.ts'`, `import type { FxValue } from '../../contracts.ts'`), use only erasable
  TypeScript (no enums, namespaces or constructor parameter properties), no React, DOM or browser globals; side effects go through
  `c.host`. `src/fx/layering.test.ts` fails otherwise, and `server/core/fx.test.ts` loads the engine under plain Node.
- A new function that should work in pushed-down queries also needs a rule in `src/fx/query/` (see `query-v2.md`); otherwise a
  condition using it over a large table is reported as "can't run on the server".

Docs: `docs/reference/formulas.md` is generated from `fx.functions()`. Add the new function to `CATEGORY_OF` in
`/home/claude/appbuilder-demo/scripts/docs/formulas.ts` (an unmapped function is listed under "Other" with a warning), run
`npm run docs:gen` and commit the page.

Tests: add cases to the matching file in `src/fx/` (`functions.test.ts`, `functions2.test.ts`, `behaviour.test.ts`, `tables.test.ts`,
`udf.test.ts`, ...) using the helpers in `/home/claude/appbuilder-demo/src/fx/testutil.ts`: `val(formula)` returns the value, `err(formula)`
the first error, `run`/`fakeHost` for behaviour functions, `contacts` as sample table data. Test the blank case, the error case and
laziness. Keep results deterministic (no `Now()` without injection).

The formula language itself (lexer, parser, evaluator) is in `src/fx/{lexer,parser,ast,evaluate,values,errors}.ts`; named formulas in
`named.ts`; `signature.ts` supports the signature help; `print.ts` prints an AST back to formula text; `engine.ts` is the engine
instance; `query/` translates formulas over data-source tables into Query v2 plans (`analyze`, `explain`, the reference executor and
keyset cursors, `docs/dev/query-v2.md`).

## The application shell

Routing (`/home/claude/appbuilder-demo/src/router.ts`, hash routes) decides the top level in `/home/claude/appbuilder-demo/src/App.tsx`:

| Route | Rendered by | Notes |
| --- | --- | --- |
| `#run-<appId>` | `RunApp` (standalone) | the player in its own window; debug bar when the Studio of the app is open |
| `#chat` | `src/chat/ChatWindow.tsx` | chat popped out into its own window |
| `#settings`, `#settings-<section>` | `SettingsPage` (`src/portal/Settings.tsx`) inside `Portal` | full window in front of the shell, in the current mode |
| `#admin`, `#admin-<section>` | `AdminConsole` (`src/portal/Admin.tsx`) as a Dev mode page | administrators only |
| `#datamodel` | `DataModel` (`src/portal/model/DataModel.tsx`) as a full-bleed Dev mode page | makers; the data model designer (`data-model.md`) |
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
  one. Start with data (`src/portal/actions.ts`) uses the auto app generator (`src/autoapp`, [auto-apps.md](auto-apps.md)):
  a wide layout for desktop and landscape sizes, a one-column layout for phones and portrait sizes.
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
  `current()`, `select(id)`, state `environments` / `environmentId`. Server mode: the environments the user may enter
  (`GET /api/v1/environments`, also in `GET /workspace`); `select(id)` posts `/environments/:id/select` (remembered on the user),
  sets the request environment (`setRequestEnvironment`, `environmentHeaders()` in `src/platform/environments.ts`: every
  `remote.ts` call and `src/portal/serverApi.ts` / `environmentApi.ts` fetch sends `X-Appbuilder-Environment`) and reloads the
  workspace. Attachment URLs get `?env=` (`withEnvironment`). Demo mode: one built-in Default. The picker
  (`EnvironmentPicker.tsx`: `TypeBadge`, `EnvironmentStripe`, `EnvironmentBadge` for the Studio, `switchEnvironment()` which saves
  the Studio's pending changes first and leaves environment-specific routes) and the admin pages (`AdminEnvironments.tsx`,
  `SolutionPlan.tsx` with `PlanView` and `DeployDialog`) are the UI. App tabs are keyed per environment (`useWorkspaceKey()` in
  `workspace.ts`).
- **Settings** (`src/portal/Settings.tsx`): opened from `SettingsEntry` at the bottom of the sidebar (both modes) or the avatar
  menu, through `openSettings(section?)` (`Profile.tsx`), which remembers the route to return to; `settingsReturnRoute()` is what
  Back, the x and Esc go to. `Frame` renders it in front of the shell like the Studio (the shell stays mounted and hidden, so app
  tabs keep their state). Sections: profile, appearance, region, notifications, chat, studio (makers), data, admin (admins),
  about; `settingsSections(caps)` decides which a user sees. **Rule:** a setting is real only when its backing exists; otherwise
  render it with `Row soon="..."` (disabled, `SoonBadge`, one line naming what arrives and the phase). Never a working-looking
  setting that does nothing.
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

## Error boundaries (P3-D)

`src/components/ErrorBoundary.tsx` (a class component; React has no hook for it). A boundary catches the render errors of its subtree and shows
"This part of the page could not be shown", a **Reload** button for that part, the request reference when the error is a server error
(`referenceOf`), and, outside production only, the message and the component stack (never the stack in a production build). `resetKeys`:
when one changes the boundary retries its children.

| Scope | Where | Resets on |
| --- | --- | --- |
| `portal`, `run-app`, `kiosk` | `App.tsx` around the portal, the player and the kiosk page | Reload |
| `portal-page` | `Portal.tsx`, the page area inside the shell | route change |
| `app-tab:<id>` | `UserMode.tsx` `AppTabPanes`, one per tab | the active tab changing |
| `studio` | `Portal.tsx` around `Studio` | the app changing |
| `chat-dock` | `Portal.tsx` around both docks | Reload |
| `tile:<id>` | `DashboardsPage.tsx` `Tile` (so the viewer, the editor preview, pins and the kiosk all have it) | new data |
| `component:<name>` | `runtime/RenderNode.tsx`, around each UI component's renderer | Reload |

`main.tsx` gives the root `onCaughtError` / `onUncaughtError`, which log the error and its component stack to the console
(`logRenderError`). **There is no client-error endpoint on the server and none was added**, so nothing is reported anywhere else.
Cost of one boundary per UI component, measured with `renderToString` of 2,000 siblings: about 6 microseconds each (7.8 ms against 20.0 ms
for 2,000), so about 1 ms for a 200-component screen; accepted. Test hook: `window.__abForceCrash(scope[, false])` makes the boundaries of
that exact scope throw on their next render through the real catch path (it can only break the viewer's own page); `p3-misc.mjs` uses it
on the production build. Not caught by a boundary (React limitation): errors in event handlers, in async code and in the boundary itself.

## The flow designer

Dev mode > Flows > a flow (`src/flows/FlowsPage.tsx`) renders `FlowDesigner` (`src/flows/designer/`, P1 package B; design in
[flows.md](flows.md#designer-p1-package-b), decision D28). Patterns to reuse:

- **The definition is the state.** `useDesigner` (zustand, one designer at a time) holds the flow document and its
  connection references; change it only through `edit(fn, key?)` (one undo step; edits with the same `key` within a second
  merge) or the commands in `actions.ts`. Pure helpers live in `model.ts` / `refs.ts` / `filter.ts` / `literal.ts` /
  `dynamic.ts` and are unit-tested without a DOM (`designer.test.ts`).
- **Fields.** `FxField` is the one field component for step settings: a typed plain value (text with dynamic content,
  number, yes/no, date, choice, lookup row) or a formula, with server problems under it matched by step id and field (the
  validator's names: `values.Amount`, `inputs.to`, `trigger.condition` as step `trigger` + field `condition`). New step
  settings should use it so problems, dynamic content and read-only mode work for free.
- **Read-only** comes from `useDesigner((s) => s.readOnly)` (locked environment, the soft lock held by someone else, or no
  right to edit); `edit` refuses changes while it is set.
- **Canvas** (`Canvas.tsx`): HTML cards and SVG lines in one transformed layer; elements that must not start a drag carry
  `data-no-drag`; scrollable panels inside the canvas area carry `data-no-canvas-wheel`.
- **Entry points**: `automate({ table, templateId? })` (`src/flows/intent.ts`) opens the gallery from anywhere;
  `RunFlowHelper` (`src/flows/RunFlowHelper.tsx`) is the Studio formula bar's "Run a flow" for behaviour properties.
- **Approvals**: the approval step's form is package C's `ApprovalStepForm`, loaded through `approvalAdapter.tsx`.

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
- User-defined functions: every `Evaluator` owns a formula engine instance (`evaluator.engine`, `createEngine()` from `@/fx`) that
  holds its app's user-defined functions, so apps with different (or same-named) functions can be mounted together; there is no
  shared active set. Evaluate, check and autocomplete through `ev.engine` (`ev.engine.evaluate`, `.check`, `.functions()`,
  `.signatureAt`) wherever an app's formulas are involved; the global `fx` object is the default engine with built-ins only.
  `parseNamedFormulas` checks names against built-ins only.
- `src/runtime/instances.test.ts` proves the isolation (two stores: variables, collections, navigation, UDFs, log listeners).

- Definition and editor state (`StudioState`): `app` (the `AppDef`), `appId`, `loadState`, `saveState` (`saved|saving|unsaved|error`),
  `selection`, `currentScreenId`, `mode` (`design|preview`), `env` (actual size of the rendering surface), `history`
  (`past`/`future` snapshots with coalescing by key), `epoch` (bumps when the whole app is replaced).
- Editing actions, all undoable: `setProp(id, prop, formula, coalesceKey?)`, `setAppProp`, `setAppSettings`, `setGeometry`, `nudge`,
  `align`, `insert(type, opts)`, `remove`, `rename` (also rewrites references in formulas via `fx.renameIdentifier`), `copy`/`paste`
  /`duplicate`, `reorder`, `reparent`, `moveNode`, `addScreen`/`deleteScreen`, `undo`/`redo`, `addDataSource`/`removeDataSource`.
  Never mutate `app` outside these actions; they keep names unique, ids stable and history consistent.
- Runtime (`RuntimeState`): `vars`, per-screen `context`, `collections`, `outputs` (keyed per UI component instance, including gallery row
  keys), `resetKeys`, `focusKeys`, `formModes`, `navStack`, `toasts`, `dataKey`, `userId`, `exited`.
- Runtime actions: `fire(nodeId, event, ctx?)` runs an action property through the Fx host (`src/runtime/host.ts`), `runOnStart`,
  `restartRuntime`, `startPreview`/`exitPreview`, `navigateTo`, `setOutput`, `notify`, logging (`log`, `onLog`).
- `loadApp(id, def, opts)` replaces everything; `replaceDefinition(def)` is a hot reload that keeps runtime state (used when another
  window saved). Autosave lives in `src/runtime/session.ts` (debounced `platform.apps.save`, broadcast over `src/runtime/channel.ts`).
- UI-only state (panes, zoom, pan, theme) is a separate store, `useUi` in `src/runtime/ui.ts`. Per-app UI prefs and the UI component
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
- **Queries (server mode reads tables through them)**: `platform.tables.queryState(plan, { pageSize?, owner? })` returns the cached
  `QueryState` of a Query v2 plan synchronously (`status: 'loading' | 'ready' | 'error'`, `rows`, `count`, `hasMore`, `refreshing`,
  `loadingMore`, `truncated`) and starts or refreshes the request; `await platform.tables.query(plan)` waits for it;
  `platform.tables.loadMore(key)` fetches the next page of a paged entry; `platform.tables.onQueryChange((keys) => ...)` fires with the
  changed cache keys; `platform.tables.releaseQuery(owner)` when a component goes away; `platform.tables.invalidateQueries(table)` for
  a table-changed message. In React use `useQuery(plan, { owner, pageSize })` from `src/platform/useQuery.ts`. The cache
  (`src/platform/query-cache.ts`) de-duplicates (one request per plan), keys entries by the plan (a paged list and a whole answer of the
  same plan are separate entries), cancels a request whose owner moved to another plan (typing in a search box), keeps at most 300
  entries, overlays pending optimistic writes on cached rows, folds a confirmed write in and then refetches the table's entries in the
  background while their previous rows stay visible (no flicker). Demo mode answers the same calls with the reference executor over
  the in-memory rows (`query-local.ts`), so one component works in both modes.
- **Rows are lazy, and only small tables are held whole**: `platform.tables.rows(name)` returns the cached rows of a table that is
  loaded, otherwise `[]`. In server mode a table is loaded whole only when it is small: `platform.tables.sizeInfo(name)` counts the
  rows the user may read (a cached count query) and loads the table when there are at most 2,000 (`SMALL_TABLE_ROWS`);
  `ensureLoaded(names)` does the same and leaves larger tables alone. Code that needs rows of a possibly large table must use a query.
  `WorkspaceState.truncated` now lists only tables on connections that cannot run queries (MySQL, data files, Google Sheets) whose
  last query answer was capped at 5,000 rows.
- **Writes** are optimistic: `platform.tables.insert(table, values)`, `update(table, rowId, changes)` and `delete(table, ids)` are synchronous. They validate locally (required, unique, type coercion and the mirrored privileges: they throw `PlatformError` `denied` or `invalid`), update the cache immediately and return the row; the request is sent in order afterwards. If the server refuses, the cache is rolled back and listeners of `platform.onDataError(listener)` get a
  `DataErrorEvent { table, op: 'create'|'update'|'delete', rowIds, error }` (`error.code` is the API error code). **Subscribe to
  `onDataError` anywhere you show data changes** and tell the maker what happened; the runtime does so in `linkPlatform()`
  (a toast in preview and a log entry). `platform.tables.flush()` waits for pending writes and rejects with the first error.
- **Errors**: methods throw `PlatformError` (code, message, optional field). Show `error.message`; it is already written for makers.
- **Security UI**: use `useMyAccess(table)` and `useCaps()` from `src/portal/security.ts` to hide or disable actions; they only mirror
  the server (see `security-engine.md`).
- **Demo mode** has no server: functions that need one (connections, data files, attachments, users and passwords) fail with a
  message such as "This needs the local server". Do not assume they work when you add UI; gate with `usePlatform((s) => s.mode)`.

## Formulas over tables in server mode (delegation)

`src/runtime/delegation.ts`, used by the evaluator (`Evaluator.delegate`), the action runner (`runFormulaAsync` in `host.ts`) and the
UI components. Demo mode, collections and formulas without table reads take none of these paths.

- **Properties and named formulas.** For a formula that reads tables (`tableReads`: names of data-source tables, not the first argument
  of Patch / Collect / Remove / Defaults ...), the evaluator calls `analyze()` (`src/fx/query`) with the platform's schema (column kinds,
  and for the tables read, `sizeInfo`), its own engine and scope. Plans go to `platform.tables.queryState` (owner = the property key);
  the evaluator records `q:<cache key>` dependencies, and `linkStore` bumps `runtime.queryVersion` when the cache reports changes, so
  only formulas that read a changed query re-run (`queryDepsSince`). While a plan loads, the property keeps its previous value
  (`PropEval.loading`), or the default the first time. The residual formula runs over the bound results.
- **Errors, never partial results.** An error diagnostic over a table that is not small is the property's error: the message names the
  sub-expression, the table size and the suggestion; `PropEval.diag` spans the sub-expression. While the table's size is still being
  counted the property shows loading instead (it may turn out small). A small, fully loaded table evaluates the formula in the browser
  and `PropEval.warning` says so (Studio data warnings).
- **Lists.** An unbounded rows plan (Items of a gallery or table) is paged (100 rows, `loadMore()` for more). The array carries a
  non-enumerable `__query` (`QueryMeta`: exact `count`, `hasMore`, `loadMore`, `columns`, `plan`, `pure`, `view`); read it with
  `queryMeta(items)`. DataTable (SortColumn / SortOrder / SearchText outputs), Dropdown and ComboBox (SearchText) shape the plan of
  their Items: the evaluator adds the sort key first and a `contains` search over the text columns (`ListView`). When Items is a list
  from elsewhere (a named formula) and `pure` (no calculation on top), `deriveList` re-plans it the same way; otherwise the UI component
  sorts and searches the rows it holds (`viewMatches` tells which).
- **Actions.** `needsServer(formula)` (a read of a table that is not held whole) sends the action through `runFormulaAsync`: each
  top-level step (`a; b; c`) waits for the writes of the earlier steps (`flush`), then `prepareAction` analyses the step with the
  current variables, fetches its plans and runs the residual with the host. A read the server can't run fails the action with the
  reason. Other actions stay synchronous.
- **UI components.** `src/controls/virtual.ts` (`useVirtualRows`, `queryMeta`): DataTable and Gallery render only the rows in view (fixed
  pitch, spacers) and load the next page near the end (infinite scroll; DataTable's pager mode fetches the pages it shows); both show
  the exact count (`[data-row-count]`). A new sort or search scrolls to the top. Dropdown with a paged Items becomes a type-ahead combo
  box; ComboBox searches on the server (250 ms debounce) and keeps selected records that are not among the rows shown. Charts and
  StatCard need nothing: their aggregate formulas become aggregate plans.
- **Studio.** `PropEval.delegation` (`DelegationInfo { where: 'server' | 'browser' | 'error', explain, diagnostics }`): the formula bar
  shows "Runs on server" / "Runs in browser" / "Can't run" (hover: `explain()`), underlines the sub-expression of the first error or
  warning, and shows the warning chip; `Evaluator.warningsOf(node)` feeds the status bar's data warnings.
- **Portal grid** (`src/portal/DataGrid.tsx`): server mode pages with `useQuery` (200 rows, scroll or "Show more"), sorts by a header and
  searches the text columns on the server (300 ms debounce), shows the exact count, reads lookup labels for the rows on screen by id,
  and exports CSV through `GET /tables/:id/csv`. Demo mode keeps the in-memory grid.

## Lookup fields and labels

Lookups work on tables of any size, in server mode, demo mode and offline, through the platform facade only (no direct
HTTP). Decisions are pure functions in `src/controls/lookups.ts` (tested in `lookups.test.ts`); the React side is
`src/controls/lookupLabels.ts` (label store and batch requests) and `src/controls/inputs/LookupPicker.tsx`.

- **Form lookup field** (`LookupPicker`): a combobox button with the current value's label. Opening it runs
  `pickerPlan(target, text)`: `contains` on the target's primary column (a number primary column: equality when the text
  is a number), sorted by it, `select` that column only; through `useQuery` with `pageSize` 25 (the cache asks for the
  exact count with the first page, `loadMore` on scroll). Typing is debounced (250 ms). The query runs as the signed-in
  user, so only rows they may read are offered. The current value's label is read by id (below), so it shows even when
  the row is far from the first page. Desktop: a popover with a cmdk search box (arrows, Enter, Escape; Backspace or
  Delete on the closed button clears an optional value; a clear button too). Touch: `PickerSheet` (bottom sheet, search,
  44 px rows, more rows near the end). Messages (`pickerMessage`): "No Products match "x".", "Products has no records you
  can pick yet.", "Could not load Products: ...", and offline "Products is not available offline. Connect to pick a
  record." (an "available offline" table answers from the device through `remote.ts`'s snapshot path, so it simply
  works). A target table the user cannot see shows "You cannot see ... here". The Form no longer checks a lookup
  against a list held in the browser: the picker only offers existing rows and the server refuses an id that is not a
  readable row of the target (`checkLookup`).
- **Form choice fields on touch** (`ChoiceSheetField`): the same bottom sheet over `choices`; desktop keeps the Radix
  select.
- **Labels in lists** (`useLookupRequests`, `lookupLabel`): a component asks for the ids it shows that it has not asked
  for yet as `id in [...]` plans of at most 200 ids (`labelPlans`), so a screenful costs one request per target table,
  never one per row; identical plans of several components are one request (the query cache). Answers fill a label store
  per signed-in user and table (`labelStoreKey`); asked ids that did not come back are stored as null. A component keeps
  owning its plans while mounted (at most 40), so the query cache refetches them when the target changes (a save here, a
  live message) and labels follow.
- **Rows the viewer cannot read, or deleted rows**: the cell shows a muted, italic *Not available* (tooltip: "This
  record was deleted or you cannot see it."). Never the id, and the two cases are not told apart (the server answers a
  hidden row exactly like a missing one). While a batch is on its way the cell shows "…".
- **DataTable** (and its phone cards): lookup columns of the rows' table (`QueryMeta.table`, or the table whose columns
  the rows have) render labels. Sorting (P3-C): a list paged from the server sorts by a lookup's LABEL on the server:
  `withView` in `src/runtime/delegation.ts` turns the header sort into a Query v2 sort key through the lookup
  (`lookupSortKey`: `{ col, dir, via: { table: target, col: target's primary column } }`, [query-v2.md 5b](query-v2.md#5b-sorting-by-a-lookup-column-p3-c)),
  never by record id. The server reads the target as the viewer: a row whose target they cannot read (or that is
  deleted, or blank) sorts with the blank labels, by the row's own creation order, so its position tells nothing about
  the hidden row; the cell shows *Not available*. The header offers it only where `lookupSortInfo` (delegation.ts, on top
  of `lookupSortSupport` in lookups.ts) says the server can: the viewer may read the target table and its primary column,
  the primary column can be sorted (not a file or image), and both tables are in the same PostgreSQL store (the default
  database; another connection only when the workspace says it is PostgreSQL, which only makers see). Otherwise the
  header keeps `data-sortable="false"` with the reason on hover ("you cannot see the names in Customers it would be
  sorted by", "... stored where the server cannot sort by a lookup's names", "... has no name column to sort by") and
  the card **Sort by** box leaves the column out; the server refuses such a sort too (403 for a hidden primary column,
  422 for another store). A list held in the browser sorts by label (up to
  2,000 distinct ids; it then asks for every label). Search: on the server, a lookup column is searched through its
  target's primary column with a lookup path (`lookupSearchCondition`: `{ via: { col, table, where: contains } }`),
  never by id; targets that are unreadable, have a hidden or non-text primary column, or live in another connection are
  left out of the search. In the browser, search reads labels.
- **Gallery**: lookups of the rows in view are fetched as whole rows (`{ full: true }`), and `recordById`
  (`src/runtime/data.ts`) reads them (`lookupRowById`), so a template's `ThisItem.Customer.Name` works in server mode for
  any target table, not only Users. The evaluator records the answer's `q:<key>` (`lookupRowDep`) and re-runs when it
  arrives. `ThisItem.Customer` itself is still the id (formulas need it for `Patch` and filters).

## Live data, presence and notifications

The platform keeps one realtime connection per tab (`platform.live`, `src/platform/live.ts` and `remote-live.ts`; protocol and rules
in `live.md`). What a UI component author needs to know:

- **Data refreshes by itself.** Anything that reads through `platform.tables.queryState` / `query` or the small-table cache is
  refreshed when someone else changes the table: the query cache refetches in the background and keeps the previous rows until
  the new ones arrive. Keep your component mounted and keyed by data, not by version counters, so scroll positions survive.
- **Do not overwrite what the user is typing.** A UI component that edits a record (the Form is the model) follows the record by id,
  reloads its values only while there are no unsaved edits, and otherwise shows a conflict panel. Pass the version you started
  from: `platform.tables.update(table, id, changes, { ifVersion: row.modifiedOn })`; a stale save comes back as a `DataErrorEvent`
  with code `conflict` and field `modifiedOn` (the error also carries `current` and `changedBy`).
- **Topics**: `useLiveTopic(topic, handler)` (current environment; `null` env for `user:<me>`), `usePresence(scope, state)` returns
  the other people in a scope (`app:<id>`, `studio:<id>`, `record:<table>:<row>`), `useLiveStatus()` the connection state.
  `PresenceAvatars` (`src/runtime/presence.tsx`) draws them.
- **Notifications**: `platform.notifications` (list, mark read, settings, `send`) and `onNotification`. The bell, its panel, the
  toasts and the desktop notifications are `src/portal/Notifications.tsx`; formulas use `SendNotification` (host
  `sendNotification`, asynchronous; failures become a toast through the same listener as Share failures).
- **Studio read-only**: `StudioState.readOnly` (locked production environment, or another maker holds the soft edit lock) makes
  every design edit, undo and redo a no-op; the Studio wraps the formula bar, the left rail and the properties panel in a
  disabled `fieldset`, and the canvas does not start moves or resizes. New edit paths must go through `mutate` (store.ts).
- **Demo mode** implements the same API between tabs of one browser (`demo-live.ts`, BroadcastChannel).

## Styling

- Tailwind CSS 4 plus CSS variables defined in `/home/claude/appbuilder-demo/src/index.css`. Use the semantic utilities, not raw colours:
  `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `bg-primary text-primary-foreground`, `bg-secondary`,
  `bg-accent`, `bg-muted`, `border-border`, `ring-ring`, `text-destructive`, `bg-canvas` (the Studio canvas background),
  `rounded-md` / `rounded-lg` (radius is `--radius`, 0.5rem), `font-sans` (Inter, then system fonts), `font-mono`.
- Tokens are defined for `:root` (light) and `.dark`. The dark theme is toggled by a class on the root; the preference is in
  `localStorage` (`appbuilder-theme`, see `src/runtime/ui.ts`). Any new UI must work in both themes: use the tokens and check it.
- Body text is 13 px (`index.css`); the Studio is dense. The app being built is drawn at its design size and scaled
  (`scaleMode` `responsive` or `fit`), so UI component renderers use pixel props from the maker (`Size`, `Radius`) and fill their wrapper.
- Reusable primitives are in `/home/claude/appbuilder-demo/src/components/ui/` (shadcn-style wrappers over Radix). Add new primitives
  there, not inline, and import them from `@/components/ui/...`. Use `cn` from `@/lib/utils` to join class names.
- Icons: lucide-react for the product UI.
- What is not supported: no CSS-in-JS and no per-app custom CSS; makers style UI components only through their properties.
