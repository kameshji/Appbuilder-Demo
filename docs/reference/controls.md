<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->

# Controls reference

A control is one building block on a screen. Each control has **properties** (each holds a formula), **outputs** (values the control produces, such as what the user typed) and **events** (properties whose formula runs when something happens). Outputs are read in formulas like a field of the control: `TextInput1.Value`, `Gallery1.Selected.Name`.

This page is generated from the control registry. Do not edit it by hand; run `npm run docs:gen`. How formulas work is in the [Formula reference](formulas.md).

How to read the tables:
- **Kind** is the type of value the property expects: `text`, `number`, `boolean`, `color`, `enum`, `table`, `record`, `any`, `tableName` (the name of a data table as text), `icon` (an icon name as text, or `anim:<id>` for an animated icon) and `action` (an event).
- **Default** is the formula a new control starts with.
- **Level**: Simple properties are on the Simple tab of the property pane; Advanced ones are only on the Advanced tab.
- **Shown as** is the label on the Simple tab when it differs from the property name. **Values** lists the choices of an `enum` property.
- Outputs whose names start with two underscores are internal and not listed.
- Controls are listed in the order of the Insert pane's categories.

**Not supported yet.** The set of controls is fixed: makers cannot add their own controls or import component packs. Apps are landscape only; there are no portrait or phone layouts.

## Common properties

Every control except a screen has these 10 properties. They are not repeated in the tables below.

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `X` |  | number | Layout | `=40` | Simple |  |
| `Y` |  | number | Layout | `=40` | Simple |  |
| `Width` |  | number | Layout | the control's default size (listed under each control) | Simple |  |
| `Height` |  | number | Layout | the control's default size (listed under each control) | Simple |  |
| `Visible` |  | boolean | Layout | `=true` | Simple |  |
| `AnchorH` | Horizontal anchor | enum | Layout | `=Anchor.Start` | Simple | any [Anchor](formulas.md#anchor) member |
| `AnchorV` | Vertical anchor | enum | Layout | `=Anchor.Start` | Simple | any [Anchor](formulas.md#anchor) member |
| `Grow` |  | number | Layout | `=0` | Advanced |  |
| `AlignSelf` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Tooltip` |  | text | Content | `=""` | Advanced |  |

**`DisplayMode`** is shared by the controls that can be switched off: `=DisplayMode.Edit` by default, one of `DisplayMode.Edit`, `DisplayMode.View`, `DisplayMode.Disabled`. A control that has it says "also has `DisplayMode`" under its name; it is not repeated in the tables.

## Controls by category

- [Layout](#layout): [Screen](#screen), [Container](#container), [Row](#row), [Column](#column), [Grid](#grid), [Card](#card), [Scroll area](#scroll-area), [Divider](#divider), [Spacer](#spacer), [Dialog](#dialog), [Sheet](#sheet), [Accordion](#accordion)
- [Input](#input): [Button](#button), [Text input](#text-input), [Checkbox](#checkbox), [Toggle](#toggle), [Dropdown](#dropdown), [Text area](#text-area), [Number input](#number-input), [Password input](#password-input), [Search box](#search-box), [Radio group](#radio-group), [Combo box](#combo-box), [Date picker](#date-picker), [Date range picker](#date-range-picker), [Time picker](#time-picker), [Slider](#slider), [Range slider](#range-slider), [Rating](#rating), [Toggle group](#toggle-group), [Segmented control](#segmented-control), [Icon button](#icon-button), [Link button](#link-button), [Split button](#split-button), [Menu button](#menu-button), [File upload](#file-upload), [Color picker](#color-picker), [Stepper](#stepper), [PIN input](#pin-input), [Timer](#timer)
- [Display](#display): [Label](#label), [Image](#image), [Rectangle](#rectangle), [Heading](#heading), [Rich text](#rich-text), [Badge](#badge), [Avatar](#avatar), [Avatar group](#avatar-group), [Icon](#icon), [Shape](#shape), [Tag list](#tag-list), [Stat card](#stat-card), [Timeline](#timeline)
- [Data](#data): [Gallery](#gallery), [Form](#form), [Data table](#data-table), [List](#list), [Calendar](#calendar)
- [Navigation](#navigation): [Tabs](#tabs), [Breadcrumb](#breadcrumb), [Pagination](#pagination), [Nav menu](#nav-menu), [Top bar](#top-bar), [Steps](#steps)
- [Feedback](#feedback): [Progress](#progress), [Circular progress](#circular-progress), [Spinner](#spinner), [Skeleton](#skeleton), [Alert](#alert), [Empty state](#empty-state)
- [Media](#media): [Video](#video), [Audio](#audio), [Animated icon](#animated-icon)
- [Charts](#charts): [Chart](#chart), [Sparkline](#sparkline)

## Layout

### Screen

One page of the app. Every app has at least one; controls are placed on a screen. A screen is not inserted from the Insert pane.

Type: `Screen` · main property: `Fill`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Fill` |  | color | Style | `=Color.White` | Simple |  |
| `OnVisible` |  | action | Behaviour | `=false` | Advanced |  |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Manual` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |

**Events:** `OnVisible`.

- **Container.** Holds the controls of the screen. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode.
- A screen has no X, Y, Width, Height or other common properties: it is not positioned like other controls. `OnVisible` runs when the screen is shown while the app is running.

### Container

A box that holds other controls. Children are placed by hand or arranged in a row, column or grid.

Type: `Container` · default size 320 x 240 · main property: `Fill`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Fill` |  | color | Style | `=Color.White` | Simple |  |
| `Radius` |  | number | Style | `=12` | Simple |  |
| `BorderColor` |  | color | Style | `=RGBA(228, 228, 231, 1)` | Simple |  |
| `BorderWidth` |  | number | Style | `=1` | Simple |  |
| `Shadow` |  | boolean | Style | `=true` | Simple |  |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Manual` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Row

A container that lays its children out in a horizontal row.

Type: `Row` · default size 480 x 96 · main property: `Gap`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Row` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |
| `Fill` |  | color | Style | `=Color.Transparent` | Simple |  |
| `Radius` |  | number | Style | `=0` | Advanced |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Column

A container that lays its children out in a vertical column.

Type: `Column` · default size 240 x 320 · main property: `Gap`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Column` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |
| `Fill` |  | color | Style | `=Color.Transparent` | Simple |  |
| `Radius` |  | number | Style | `=0` | Advanced |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Grid

A container that lays its children out in a grid with a number of columns.

Type: `Grid` · default size 480 x 320 · main property: `Gap`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Grid` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |
| `Fill` |  | color | Style | `=Color.Transparent` | Simple |  |
| `Radius` |  | number | Style | `=0` | Advanced |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Card

A container with an optional title and description above its content, with a fill and a border.

Type: `Card` · default size 360 x 240 · main property: `Title`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Title` |  | text | Content | `="Card title"` | Simple |  |
| `Description` |  | text | Content | `=""` | Simple |  |
| `ShowHeader` |  | boolean | Content | `=true` | Simple |  |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Manual` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |
| `Fill` |  | color | Style | `=Blank()` | Simple |  |
| `Radius` |  | number | Style | `=12` | Simple |  |
| `BorderColor` |  | color | Style | `=Blank()` | Advanced |  |
| `BorderWidth` |  | number | Style | `=1` | Advanced |  |
| `Shadow` |  | boolean | Style | `=true` | Simple |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Scroll area

A container whose content scrolls when it is bigger than the box.

Type: `ScrollArea` · default size 360 x 280 · main property: `LayoutMode`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Column` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=12` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |
| `ShowScrollbar` |  | boolean | Style | `=true` | Simple |  |
| `Fill` |  | color | Style | `=Color.Transparent` | Simple |  |

**Events:** none.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Divider

A thin line, with an optional label, that separates parts of a screen.

Type: `Divider` · default size 320 x 24 · main property: `Orientation`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Orientation` | enum | Style | `=Orientation.Horizontal` | Simple | any [Orientation](formulas.md#orientation) member |
| `Label` | text | Content | `=""` | Simple |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `Thickness` | number | Style | `=1` | Simple |  |

**Events:** none.

### Spacer

Empty space between controls in a row, column or grid.

Type: `Spacer` · default size 80 x 24 · main property: `Width`

No properties of its own beyond the common ones.

**Events:** none.

### Dialog

A pop-up window over the screen with a title, content and a close button. Shown only while Open is true.

Type: `Dialog` · default size 480 x 320 · main property: `Open`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Open` |  | boolean | Behaviour | `=false` | Simple |  |
| `Title` |  | text | Content | `="Title"` | Simple |  |
| `Description` |  | text | Content | `=""` | Simple |  |
| `ShowClose` |  | boolean | Content | `=true` | Simple |  |
| `CloseOnBackdrop` |  | boolean | Behaviour | `=true` | Advanced |  |
| `OnClose` |  | action | Behaviour | `=false` | Simple |  |
| `Fill` |  | color | Style | `=Blank()` | Simple |  |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Manual` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |

**Events:** `OnClose`.

- **Overlay.** Shown above everything else on the screen, and only while `Open` is true. The Studio canvas shows it in place so that its children can be edited.
- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.
- Close button, a click on the backdrop (when `CloseOnBackdrop` is true) and the Escape key run `OnClose`. Your `OnClose` formula should set the variable that `Open` reads to false.

### Sheet

A panel that slides in from one side of the screen. Shown only while Open is true.

Type: `Sheet` · default size 400 x 600 · main property: `Open`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Open` |  | boolean | Behaviour | `=false` | Simple |  |
| `Title` |  | text | Content | `="Title"` | Simple |  |
| `Description` |  | text | Content | `=""` | Simple |  |
| `ShowClose` |  | boolean | Content | `=true` | Simple |  |
| `CloseOnBackdrop` |  | boolean | Behaviour | `=true` | Advanced |  |
| `OnClose` |  | action | Behaviour | `=false` | Simple |  |
| `Fill` |  | color | Style | `=Blank()` | Simple |  |
| `Side` |  | enum | Layout | `=Side.Right` | Simple | any [Side](formulas.md#side) member |
| `LayoutMode` | Layout | enum | Layout | `=Layout.Manual` | Simple | any [Layout](formulas.md#layout) member |
| `Gap` |  | number | Layout | `=16` | Simple |  |
| `Padding` |  | number | Layout | `=0` | Simple |  |
| `Justify` |  | enum | Layout | `=Justify.Start` | Advanced | any [Justify](formulas.md#justify) member |
| `AlignItems` |  | enum | Layout | `=AlignItems.Auto` | Advanced | any [AlignItems](formulas.md#alignitems) member |
| `Wrap` |  | boolean | Layout | `=false` | Advanced |  |
| `Columns` |  | number | Layout | `=3` | Advanced |  |
| `Scroll` |  | boolean | Layout | `=false` | Advanced |  |

**Events:** `OnClose`.

- **Overlay.** Shown above everything else on the screen, and only while `Open` is true. The Studio canvas shows it in place so that its children can be edited.
- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.
- Close button, a click on the backdrop (when `CloseOnBackdrop` is true) and the Escape key run `OnClose`. Your `OnClose` formula should set the variable that `Open` reads to false. `Side` chooses the edge: left and right sheets are `Width` wide and full height; top and bottom sheets are `Height` tall and full width.

### Accordion

A list of sections that expand and collapse.

Type: `Accordion` · default size 420 x 200 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Title: "What is this?", Content: "A collapsible section. Bind Items to a table with Title and Content columns."}, {Title: "How do I change it?", Content: "Edit the Items formula."}, {Title: "Can several be open?", Content: "Yes, set AllowMultiple to true."})` | Simple |
| `AllowMultiple` | boolean | Behaviour | `=false` | Simple |
| `DefaultOpen` | number | Behaviour | `=1` | Simple |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

## Input

### Button

A push button. Its OnSelect formula runs when it is clicked.

Type: `Button` · default size 120 x 40 · main property: `OnSelect` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Button"` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |
| `Style` | enum | Style | `=ButtonStyle.Primary` | Simple | any [ButtonStyle](formulas.md#buttonstyle) member |
| `Fill` | color | Style | `=Blank()` | Simple |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |
| `Radius` | number | Style | `=8` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Pressed` | `false` |

**Events:** `OnSelect`.

### Text input

A single-line text box.

Type: `TextInput` · default size 240 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | text | Content | `=""` | Simple |
| `Placeholder` | text | Content | `="Type here"` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |
| `Size` | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |

**Events:** `OnChange`.

### Checkbox

A tick box with a text label. Its value is true or false.

Type: `Checkbox` · default size 160 x 24 · main property: `Text` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Option"` | Simple |
| `Default` | boolean | Content | `=false` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `false` |

**Events:** `OnChange`.

### Toggle

An on/off switch with a text label. Its value is true or false.

Type: `Toggle` · default size 160 x 28 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Toggle"` | Simple |
| `Default` | boolean | Content | `=false` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `false` |

**Events:** `OnChange`.

### Dropdown

A closed list that opens to pick one item.

Type: `Dropdown` · default size 240 x 40 · main property: `Items` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["One", "Two", "Three"]` | Simple |
| `Default` | text | Content | `=""` | Simple |
| `Placeholder` | text | Content | `="Select..."` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |

**Events:** `OnChange`.

### Text area

A multi-line text box.

Type: `TextArea` · default size 320 x 120 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | text | Content | `=""` | Simple |
| `Placeholder` | text | Content | `="Type here"` | Simple |
| `Rows` | number | Content | `=4` | Simple |
| `MaxLength` | number | Content | `=0` | Advanced |
| `OnChange` | action | Behaviour | `=false` | Simple |
| `Size` | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |

**Events:** `OnChange`.

### Number input

A box for entering a number, with a minimum, maximum and step.

Type: `NumberInput` · default size 160 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | number | Content | `=0` | Simple |
| `Min` | number | Content | `=Blank()` | Simple |
| `Max` | number | Content | `=Blank()` | Simple |
| `Step` | number | Content | `=1` | Simple |
| `Placeholder` | text | Content | `="0"` | Advanced |
| `OnChange` | action | Behaviour | `=false` | Simple |
| `Size` | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | blank |

**Events:** `OnChange`.

### Password input

A text box that hides what is typed, with an optional show/hide toggle.

Type: `PasswordInput` · default size 240 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | text | Content | `=""` | Simple |
| `Placeholder` |  | text | Content | `="Password"` | Simple |
| `ShowToggle` | Show reveal button | boolean | Content | `=true` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |

**Events:** `OnChange`.

### Search box

A text box for search terms. OnSearch runs when a search is submitted, and optionally while typing.

Type: `SearchBox` · default size 280 x 40 · main property: `OnSearch` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | text | Content | `=""` | Simple |
| `Placeholder` |  | text | Content | `="Search..."` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `OnSearch` |  | action | Behaviour | `=false` | Simple |
| `SearchOnType` | Search while typing | boolean | Behaviour | `=false` | Advanced |
| `Size` |  | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |

**Events:** `OnChange`, `OnSearch`.

### Radio group

A list of options that are all visible, with one choice.

Type: `RadioGroup` · default size 220 x 104 · main property: `Items` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Option 1", "Option 2", "Option 3"]` | Simple |  |
| `Default` | text | Content | `=""` | Simple |  |
| `Orientation` | enum | Style | `=Orientation.Vertical` | Simple | any [Orientation](formulas.md#orientation) member |
| `OnChange` | action | Behaviour | `=false` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |
| `Color` | color | Style | `=Blank()` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |

**Events:** `OnChange`.

### Combo box

A searchable list. Picks one item or several.

Type: `ComboBox` · default size 260 x 40 · main property: `Items` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Apple", "Banana", "Cherry", "Mango", "Orange"]` | Simple |  |
| `DisplayField` | text | Data | `=""` | Simple |  |
| `SearchField` | text | Data | `=""` | Advanced |  |
| `Default` | text | Content | `=""` | Simple |  |
| `Placeholder` | text | Content | `="Select..."` | Simple |  |
| `SelectionMode` | enum | Behaviour | `=SelectionMode.Single` | Simple | `SelectionMode.Single`, `SelectionMode.Multiple` |
| `Clearable` | boolean | Content | `=true` | Advanced |  |
| `OnChange` | action | Behaviour | `=false` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedItems` | `[]` |
| `SelectedText` | `""` |
| `SearchText` | `""` |

**Events:** `OnChange`.

- **Selection.** `Selected` is the first selected item; `SelectedItems` holds all of them.

### Date picker

Picks one date from a calendar.

Type: `DatePicker` · default size 240 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | any | Content | `=Blank()` | Simple |
| `Min` | any | Content | `=Blank()` | Simple |
| `Max` | any | Content | `=Blank()` | Simple |
| `Format` | text | Content | `="yyyy-mm-dd"` | Simple |
| `Placeholder` | text | Content | `="Pick a date"` | Simple |
| `Clearable` | boolean | Content | `=true` | Advanced |
| `OnChange` | action | Behaviour | `=false` | Simple |
| `Size` | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `SelectedDate` | blank |

**Events:** `OnChange`.

### Date range picker

Picks a start date and an end date.

Type: `DateRangePicker` · default size 300 x 40 · main property: `DefaultStart` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `DefaultStart` | Default start | any | Content | `=Blank()` | Simple |
| `DefaultEnd` | Default end | any | Content | `=Blank()` | Simple |
| `Min` |  | any | Content | `=Blank()` | Advanced |
| `Max` |  | any | Content | `=Blank()` | Advanced |
| `Format` |  | text | Content | `="yyyy-mm-dd"` | Simple |
| `Placeholder` |  | text | Content | `="Pick a date range"` | Simple |
| `Clearable` |  | boolean | Content | `=true` | Advanced |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `StartDate` | blank |
| `EndDate` | blank |

**Events:** `OnChange`.

### Time picker

Picks a time of day.

Type: `TimePicker` · default size 200 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | text | Content | `=""` | Simple |
| `Placeholder` |  | text | Content | `="Pick a time"` | Simple |
| `Use24Hour` | 24-hour clock | boolean | Content | `=true` | Simple |
| `MinuteStep` | Minute step | number | Content | `=5` | Advanced |
| `Clearable` |  | boolean | Content | `=true` | Advanced |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |
| `Hour` | blank |
| `Minute` | blank |

**Events:** `OnChange`.

### Slider

Picks a number between a minimum and a maximum by dragging a handle.

Type: `Slider` · default size 280 x 32 · main property: `Default` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | number | Content | `=50` | Simple |
| `Min` |  | number | Content | `=0` | Simple |
| `Max` |  | number | Content | `=100` | Simple |
| `Step` |  | number | Content | `=1` | Simple |
| `ShowValue` | Show value | boolean | Content | `=true` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Advanced |
| `Color` |  | color | Style | `=Blank()` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | blank |

**Events:** `OnChange`.

### Range slider

Picks a low and a high number between a minimum and a maximum with two handles.

Type: `RangeSlider` · default size 320 x 32 · main property: `DefaultLow` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `DefaultLow` | Default low | number | Content | `=25` | Simple |
| `DefaultHigh` | Default high | number | Content | `=75` | Simple |
| `Min` |  | number | Content | `=0` | Simple |
| `Max` |  | number | Content | `=100` | Simple |
| `Step` |  | number | Content | `=1` | Simple |
| `ShowValue` | Show values | boolean | Content | `=true` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Advanced |
| `Color` |  | color | Style | `=Blank()` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Low` | blank |
| `High` | blank |

**Events:** `OnChange`.

### Rating

A star rating.

Type: `Rating` · default size 180 x 32 · main property: `Default` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | number | Content | `=0` | Simple |
| `Max` |  | number | Content | `=5` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` | Star size | number | Style | `=24` | Simple |
| `Color` |  | color | Style | `=Blank()` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | blank |

**Events:** `OnChange`.

### Toggle group

A row of buttons from a list of items, where one or several can be switched on.

Type: `ToggleGroup` · default size 280 x 40 · main property: `Items` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Left", "Center", "Right"]` | Simple |  |
| `Default` | text | Content | `=""` | Simple |  |
| `SelectionMode` | enum | Behaviour | `=SelectionMode.Single` | Simple | `SelectionMode.Single`, `SelectionMode.Multiple` |
| `OnChange` | action | Behaviour | `=false` | Simple |  |
| `Variant` | enum | Style | `=Variant.Outline` | Simple | any [Variant](formulas.md#variant) member |
| `Size` | enum | Style | `=Size.Medium` | Simple | any [Size](formulas.md#size) member |
| `Color` | color | Style | `=Blank()` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedItems` | `[]` |
| `SelectedText` | `""` |

**Events:** `OnChange`.

- **Selection.** `Selected` is the first selected item; `SelectedItems` holds all of them.

### Segmented control

A row of joined buttons from a list of items, for picking one.

Type: `SegmentedControl` · default size 280 x 40 · main property: `Items` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Day", "Week", "Month"]` | Simple |
| `Default` | text | Content | `="Day"` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |
| `Size` | number | Style | `=14` | Simple |
| `Color` | color | Style | `=Blank()` | Advanced |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |

**Events:** `OnChange`.

### Icon button

A button that shows only an icon.

Type: `IconButton` · default size 40 x 40 · main property: `OnSelect` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Icon` | icon | Content | `="Plus"` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |
| `Variant` | enum | Style | `=Variant.Default` | Simple | any [Variant](formulas.md#variant) member |
| `Size` | enum | Style | `=Size.Medium` | Simple | any [Size](formulas.md#size) member |
| `Shape` | enum | Style | `="Rounded"` | Simple | `"Rounded"`, `"Circle"`, `"Square"` |
| `Fill` | color | Style | `=Blank()` | Advanced |  |
| `Color` | color | Style | `=Blank()` | Advanced |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Pressed` | `false` |

**Events:** `OnSelect`.

### Link button

A button that looks like a text link.

Type: `LinkButton` · default size 120 x 32 · main property: `OnSelect` · also has `DisplayMode`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Learn more"` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |
| `Underline` | boolean | Style | `=false` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `Align` | enum | Style | `=Align.Left` | Simple | any [Align](formulas.md#align) member |

**Events:** `OnSelect`.

### Split button

A button with a main action and a menu of related actions.

Type: `SplitButton` · default size 150 x 40 · main property: `OnSelect` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Text` |  | text | Content | `="Save"` | Simple |  |
| `Items` |  | table | Data | `=["Save as draft", "Save and close", "Save as template"]` | Simple |  |
| `OnSelect` |  | action | Behaviour | `=false` | Simple |  |
| `OnItemSelect` |  | action | Behaviour | `=false` | Simple |  |
| `Variant` |  | enum | Style | `=Variant.Default` | Simple | any [Variant](formulas.md#variant) member |
| `Size` | Font size | number | Style | `=14` | Simple |  |
| `Fill` |  | color | Style | `=Blank()` | Advanced |  |
| `Color` |  | color | Style | `=Blank()` | Advanced |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `SelectedItem` | blank |

**Events:** `OnSelect`, `OnItemSelect`.

### Menu button

A button that opens a menu of items.

Type: `MenuButton` · default size 140 x 40 · main property: `Items` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `Text` |  | text | Content | `="Actions"` | Simple |  |
| `Icon` |  | icon | Content | `=""` | Simple |  |
| `Items` |  | table | Data | `=Table({Label: "Edit", Icon: "Pencil"}, {Label: "Duplicate", Icon: "Copy"}, {Label: "Delete", Icon: "Trash"})` | Simple |  |
| `OnItemSelect` |  | action | Behaviour | `=false` | Simple |  |
| `Variant` |  | enum | Style | `=Variant.Outline` | Simple | any [Variant](formulas.md#variant) member |
| `ShowChevron` | Show chevron | boolean | Style | `=true` | Simple |  |
| `Size` | Font size | number | Style | `=14` | Simple |  |
| `Fill` |  | color | Style | `=Blank()` | Advanced |  |
| `Color` |  | color | Style | `=Blank()` | Advanced |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `SelectedItem` | blank |

**Events:** `OnItemSelect`.

### File upload

Lets the user choose one or more files.

Type: `FileUpload` · default size 360 x 140 · main property: `OnChange` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Label` |  | text | Content | `="Drop files here or click to browse"` | Simple |
| `Hint` |  | text | Content | `=""` | Advanced |
| `Accept` |  | text | Content | `=""` | Simple |
| `Multiple` |  | boolean | Content | `=false` | Simple |
| `MaxSizeMB` | Max size (MB) | number | Content | `=5` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Files` | `[]` |
| `Error` | `""` |
| `FileToken` | `""` |

**Events:** `OnChange`.

### Color picker

Picks a colour.

Type: `ColorPicker` · default size 180 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Default` |  | color | Content | `="#4f46e5"` | Simple |
| `ShowHex` | Show hex code | boolean | Content | `=true` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `Size` |  | number | Style | `=14` | Advanced |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |

**Events:** `OnChange`.

### Stepper

A number box with minus and plus buttons.

Type: `Stepper` · default size 140 x 40 · main property: `Default` · also has `DisplayMode`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | number | Content | `=0` | Simple |
| `Min` | number | Content | `=0` | Simple |
| `Max` | number | Content | `=100` | Simple |
| `Step` | number | Content | `=1` | Simple |
| `OnChange` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | blank |

**Events:** `OnChange`.

### PIN input

A row of boxes for a short code such as a PIN, with an optional mask.

Type: `PinInput` · default size 220 x 48 · main property: `OnComplete` · also has `DisplayMode`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Length` |  | number | Content | `=4` | Simple |
| `Default` |  | text | Content | `=""` | Simple |
| `Numeric` | Digits only | boolean | Content | `=true` | Simple |
| `Mask` | Mask characters | boolean | Content | `=false` | Simple |
| `OnChange` |  | action | Behaviour | `=false` | Simple |
| `OnComplete` |  | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `""` |
| `Complete` | `false` |

**Events:** `OnChange`, `OnComplete`.

### Timer

A timer that runs for a set time and raises events when it starts and ends.

Type: `Timer` · default size 120 x 32 · main property: `OnTimerEnd`

| Property | Shown as | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- | --- |
| `Duration` | Duration (ms) | number | Content | `=5000` | Simple |
| `Repeat` |  | boolean | Behaviour | `=false` | Simple |
| `AutoStart` | Auto start | boolean | Behaviour | `=false` | Simple |
| `Start` |  | boolean | Behaviour | `=false` | Simple |
| `Reset` |  | boolean | Behaviour | `=false` | Advanced |
| `ShowText` | Show remaining time | boolean | Style | `=false` | Simple |
| `OnTimerStart` |  | action | Behaviour | `=false` | Advanced |
| `OnTimerEnd` |  | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Value` | `0` |
| `Running` | `false` |

**Events:** `OnTimerStart`, `OnTimerEnd`.

- The timer never runs while you design; it runs in preview and in the running app. `Start` is edge-triggered (it acts when it becomes true); `AutoStart` starts it when the screen appears.

## Display

### Label

Shows a piece of text.

Type: `Label` · default size 200 x 32 · main property: `Text`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Label"` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |
| `Color` | color | Style | `=RGBA(24, 24, 27, 1)` | Simple |  |
| `FontWeight` | enum | Style | `=FontWeight.Normal` | Simple | any [FontWeight](formulas.md#fontweight) member |
| `Align` | enum | Style | `=Align.Left` | Simple | any [Align](formulas.md#align) member |
| `Fill` | color | Style | `=Color.Transparent` | Simple |  |

**Events:** none.

### Image

Shows a picture.

Type: `Image` · default size 160 x 120 · main property: `Image`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Image` | text | Content | `=""` | Simple |  |
| `Fit` | enum | Style | `="Cover"` | Simple | `"Cover"`, `"Contain"`, `"Fill"` |
| `Radius` | number | Style | `=0` | Simple |  |

**Events:** none.

### Rectangle

A plain box with a fill, an optional border and rounded corners.

Type: `Rectangle` · default size 160 x 96 · main property: `Fill`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Fill` | color | Style | `=RGBA(228, 228, 231, 1)` | Simple |
| `Radius` | number | Style | `=8` | Simple |
| `BorderColor` | color | Style | `=RGBA(161, 161, 170, 1)` | Simple |
| `BorderWidth` | number | Style | `=0` | Simple |

**Events:** none.

### Heading

Shows a title text, with a heading level.

Type: `Heading` · default size 360 x 44 · main property: `Text`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Heading"` | Simple |  |
| `Level` | number | Style | `=2` | Simple |  |
| `Size` | number | Style | `=0` | Advanced |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `FontWeight` | enum | Style | `=FontWeight.Bold` | Simple | any [FontWeight](formulas.md#fontweight) member |
| `Align` | enum | Style | `=Align.Left` | Simple | any [Align](formulas.md#align) member |

**Events:** none.

### Rich text

Shows formatted text written with simple markup: bold, italics, links and lists.

Type: `RichText` · default size 360 x 120 · main property: `Text`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="**Rich text** supports *italic*, [links](https://example.com) and lists:\n- first item\n- second item"` | Simple |  |
| `Size` | number | Style | `=14` | Simple |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `Align` | enum | Style | `=Align.Left` | Simple | any [Align](formulas.md#align) member |

**Events:** none.

### Badge

A small label, for a status or a count.

Type: `Badge` · default size 72 x 24 · main property: `Text`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Text` | text | Content | `="Badge"` | Simple |  |
| `Variant` | enum | Style | `=Variant.Default` | Simple | `Variant.Default`, `Variant.Secondary`, `Variant.Outline`, `Variant.Destructive` |
| `Icon` | icon | Content | `=""` | Advanced |  |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `TextColor` | color | Style | `=Blank()` | Advanced |  |
| `Size` | number | Style | `=12` | Simple |  |

**Events:** none.

### Avatar

A round picture or initials for a person.

Type: `Avatar` · default size 48 x 48 · main property: `Name`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Name` | text | Content | `="Ada Lovelace"` | Simple |
| `Image` | text | Content | `=""` | Simple |
| `Size` | number | Style | `=0` | Simple |

**Events:** none.

### Avatar group

A row of overlapping avatars for a list of people.

Type: `AvatarGroup` · default size 180 x 40 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Name: "Ada Lovelace"}, {Name: "Grace Hopper"}, {Name: "Alan Turing"}, {Name: "Linus Torvalds"}, {Name: "Margaret Hamilton"})` | Simple |
| `Max` | number | Style | `=4` | Simple |
| `Size` | number | Style | `=0` | Simple |

**Events:** none.

### Icon

Shows an icon. It can also run a formula when selected.

Type: `Icon` · default size 40 x 40 · main property: `Icon`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Icon` | icon | Content | `="Star"` | Simple |
| `Color` | color | Style | `=Blank()` | Simple |
| `Size` | number | Style | `=24` | Simple |
| `Thickness` | number | Style | `=2` | Advanced |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Events:** `OnSelect`.

### Shape

A simple shape: rectangle, ellipse, line or triangle.

Type: `Shape` · default size 120 x 120 · main property: `Kind`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Kind` | enum | Style | `="Rectangle"` | Simple | `"Rectangle"`, `"Ellipse"`, `"Line"`, `"Triangle"` |
| `Fill` | color | Style | `=Blank()` | Simple |  |
| `BorderColor` | color | Style | `=Blank()` | Simple |  |
| `BorderWidth` | number | Style | `=0` | Simple |  |
| `Radius` | number | Style | `=0` | Advanced |  |

**Events:** none.

### Tag list

A row of small tags from a list of items.

Type: `TagList` · default size 280 x 56 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Design","Build","Ship"]` | Simple |  |
| `Variant` | enum | Style | `=Variant.Secondary` | Simple | `Variant.Default`, `Variant.Secondary`, `Variant.Outline`, `Variant.Destructive` |
| `Color` | color | Style | `=Blank()` | Advanced |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

### Stat card

A card showing one key figure with its change since earlier.

Type: `StatCard` · default size 280 x 112 · main property: `Value`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Label` | text | Content | `="Revenue"` | Simple |  |
| `Value` | any | Content | `="$12,480"` | Simple |  |
| `Delta` | text | Content | `="+12.5%"` | Simple |  |
| `DeltaLabel` | text | Content | `="vs last month"` | Advanced |  |
| `Trend` | enum | Style | `="Auto"` | Simple | `"Auto"`, `"Up"`, `"Down"`, `"Flat"` |
| `Icon` | icon | Content | `="DollarSign"` | Simple |  |
| `Fill` | color | Style | `=Blank()` | Advanced |  |
| `Radius` | number | Style | `=12` | Advanced |  |

**Events:** none.

### Timeline

A vertical list of events in time order, each with a title, description and time.

Type: `Timeline` · default size 360 x 240 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Title: "Order placed", Description: "Payment confirmed", Time: "09:12"}, {Title: "Packed", Description: "Ready for pickup", Time: "11:40"}, {Title: "Delivered", Description: "Left at the front desk", Time: "16:05"})` | Simple |

**Events:** none.

## Data

### Gallery

Repeats a row template for every item in a table, as a vertical list, a horizontal strip or a grid.

Type: `Gallery` · default size 320 x 320 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=[]` | Simple |  |
| `Layout` | enum | Layout | `="Vertical"` | Simple | `"Vertical"`, `"Horizontal"`, `"Grid"` |
| `Columns` | number | Layout | `=3` | Simple |  |
| `TemplateHeight` | number | Layout | `=64` | Simple |  |
| `TemplateWidth` | number | Layout | `=240` | Simple |  |
| `Gap` | number | Layout | `=8` | Simple |  |
| `ShowScrollbar` | boolean | Style | `=true` | Simple |  |
| `Selectable` | boolean | Behaviour | `=true` | Simple |  |
| `EmptyText` | text | Content | `="No items"` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |
| `Fill` | color | Style | `=Color.Transparent` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedIndex` | blank |
| `AllItems` | `[]` |
| `VisibleCount` | `0` |

**Events:** `OnSelect`.

- **Template.** The controls inside it are a template that is repeated for every item in `Items`. Inside the template, `ThisItem` is the current item. The Studio shows one blank template row when `Items` is empty.
- `Layout` is text: `"Vertical"`, `"Horizontal"` or `"Grid"` (it is not the `Layout` enum). Vertical rows are as wide as the gallery and `TemplateHeight` tall; horizontal rows are `TemplateWidth` x `TemplateHeight`; a grid uses `Columns`.

### Form

Edits or creates one row of a table, with the fields made from the table columns and Save and Cancel buttons.

Type: `Form` · default size 720 x 420 · main property: `DataSource`

| Property | Shown as | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- | --- |
| `DataSource` |  | tableName | Data | `="Contacts"` | Simple |  |
| `Item` |  | record | Data | `=Blank()` | Simple |  |
| `Mode` |  | enum | Content | `=FormMode.Edit` | Simple | any [FormMode](formulas.md#formmode) member |
| `Fields` |  | text | Content | `=""` | Simple |  |
| `Columns` |  | number | Layout | `=2` | Simple |  |
| `ShowButtons` | Show buttons | boolean | Content | `=true` | Simple |  |
| `SubmitText` | Save button text | text | Content | `="Save"` | Advanced |  |
| `CancelText` | Cancel button text | text | Content | `="Cancel"` | Advanced |  |
| `OnSuccess` |  | action | Behaviour | `=false` | Simple |  |
| `OnFailure` |  | action | Behaviour | `=false` | Simple |  |
| `OnCancel` |  | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Updates` | `{}` |
| `Valid` | `true` |
| `Mode` | `""` |
| `LastSubmit` | blank |
| `Error` | `""` |
| `Unsaved` | `false` |

**Events:** `OnSuccess`, `OnFailure`, `OnCancel`.

- The `DataSource` table is added to the app's data sources automatically.
- In New mode it inserts a row; in Edit mode it updates the row in `Item` (an `Item` that is blank means insert). `Updates` holds the values of the fields shown.
- `NewForm`, `EditForm` and `ViewForm` change the form's `Mode` output, which takes over from the `Mode` property once it has been set. `ResetForm` puts the fields back to their starting values.
- `SubmitForm` checks `Valid` first. When it is false, the inline messages appear, `Error` is set and `OnFailure` runs; nothing is written.

### Data table

Shows a table of rows as a grid with optional search, sorting and paging.

Type: `DataTable` · default size 640 x 360 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=[]` | Simple |  |
| `Columns` | text | Data | `=""` | Simple |  |
| `SelectionMode` | enum | Behaviour | `=SelectionMode.Single` | Simple | any [SelectionMode](formulas.md#selectionmode) member |
| `Searchable` | boolean | Behaviour | `=false` | Simple |  |
| `Sortable` | boolean | Behaviour | `=true` | Simple |  |
| `PageSize` | number | Layout | `=0` | Simple |  |
| `Striped` | boolean | Style | `=false` | Simple |  |
| `Dense` | boolean | Style | `=false` | Simple |  |
| `EmptyText` | text | Content | `="No data"` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedItems` | `[]` |
| `SortColumn` | `""` |
| `SortOrder` | `""` |
| `Page` | `1` |
| `SearchText` | `""` |
| `VisibleCount` | `0` |

**Events:** `OnSelect`.

- **Selection.** `Selected` is the first selected item; `SelectedItems` holds all of them.
- `Columns` entries are a field name or `field:Header`. With `Columns` blank the table hides fields that start with `__` and the `id` field but still shows system columns such as `createdOn` and `owner`. Set `Columns` in generated apps.

### List

Shows rows as a simple list with a title, subtitle, icon or image for each item.

Type: `List` · default size 360 x 320 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=[]` | Simple |
| `TitleField` | text | Data | `=""` | Simple |
| `SubtitleField` | text | Data | `=""` | Simple |
| `IconField` | text | Data | `=""` | Advanced |
| `ImageField` | text | Data | `=""` | Advanced |
| `TrailingField` | text | Data | `=""` | Simple |
| `Selectable` | boolean | Behaviour | `=true` | Simple |
| `Dividers` | boolean | Style | `=true` | Simple |
| `EmptyText` | text | Content | `="No items"` | Simple |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

### Calendar

A month calendar that can show events.

Type: `Calendar` · default size 320 x 340 · main property: `Default`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Default` | any | Data | `=Today()` | Simple |
| `Events` | table | Data | `=[]` | Simple |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `SelectedDate` | blank |
| `SelectedEvents` | `[]` |

**Events:** `OnSelect`.

## Navigation

### Tabs

A row of tabs from a list of items.

Type: `Tabs` · default size 420 x 44 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Overview","Details","Activity"]` | Simple |  |
| `Default` | text | Data | `=""` | Simple |  |
| `Variant` | enum | Style | `="Underline"` | Simple | `"Underline"`, `"Pills"`, `"Segmented"` |
| `Color` | color | Style | `=Blank()` | Advanced |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

### Breadcrumb

A trail of links showing where the user is.

Type: `Breadcrumb` · default size 320 x 28 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=["Home","Library","Data"]` | Simple |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

### Pagination

Page buttons for moving through a long list.

Type: `Pagination` · default size 420 x 36 · main property: `Total`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Total` | number | Data | `=100` | Simple |
| `PageSize` | number | Data | `=10` | Simple |
| `ShowEdges` | boolean | Style | `=true` | Advanced |
| `Siblings` | number | Style | `=1` | Advanced |
| `OnChange` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Page` | `1` |
| `Skip` | `0` |
| `PageCount` | `1` |

**Events:** `OnChange`.

### Nav menu

A side menu of items. It does not navigate by itself: write Navigate(...) in OnSelect.

Type: `NavMenu` · default size 240 x 480 · main property: `Items`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Label: "Home", Icon: "House", Screen: "Home"}, {Label: "Reports", Icon: "ChartColumn", Screen: "Reports"}, {Label: "Settings", Icon: "Settings", Screen: "Settings"})` | Simple |
| `Default` | text | Data | `=""` | Simple |
| `Title` | text | Content | `=""` | Simple |
| `Collapsible` | boolean | Behaviour | `=false` | Simple |
| `Collapsed` | boolean | Behaviour | `=false` | Advanced |
| `Fill` | color | Style | `=Blank()` | Advanced |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |
| `SelectedIndex` | blank |
| `SelectedScreen` | `""` |
| `Collapsed` | `false` |

**Events:** `OnSelect`.

- `SelectedScreen` carries the screen text of the selected row. Write `Navigate(...)` in `OnSelect` to go there.

### Top bar

A bar across the top of a screen with a title, a subtitle and optional items. It can hold other controls.

Type: `TopBar` · default size 960 x 56 · main property: `Title`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Title` | text | Content | `="My app"` | Simple |
| `Subtitle` | text | Content | `=""` | Simple |
| `Icon` | icon | Content | `="Menu"` | Simple |
| `Items` | table | Data | `=[]` | Simple |
| `Fill` | color | Style | `=Blank()` | Simple |
| `OnSelect` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedText` | `""` |

**Events:** `OnSelect`.

- **Container.** Holds other controls. `LayoutMode` decides how they are placed: `Layout.Manual` (each child uses its own X and Y) or a row, column or grid. `Padding` applies in every mode, so children in a manual layout are offset by it.

### Steps

A progress trail through the steps of a process.

Type: `Steps` · default size 560 x 72 · main property: `Current`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Title: "Details", Description: "Basic info"}, {Title: "Review", Description: "Check and confirm"}, {Title: "Done", Description: "All set"})` | Simple |  |
| `Current` | number | Data | `=2` | Simple |  |
| `Orientation` | enum | Style | `=Orientation.Horizontal` | Simple | any [Orientation](formulas.md#orientation) member |
| `Clickable` | boolean | Behaviour | `=false` | Simple |  |
| `Color` | color | Style | `=Blank()` | Advanced |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |
| `SelectedIndex` | blank |

**Events:** `OnSelect`.

## Feedback

### Progress

A horizontal bar showing how far something has got.

Type: `Progress` · default size 280 x 24 · main property: `Value`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Value` | number | Data | `=40` | Simple |
| `Max` | number | Data | `=100` | Simple |
| `ShowLabel` | boolean | Content | `=false` | Simple |
| `Thickness` | number | Style | `=8` | Simple |
| `Color` | color | Style | `=Blank()` | Simple |
| `TrackColor` | color | Style | `=Blank()` | Advanced |

**Events:** none.

### Circular progress

A round gauge showing how far something has got.

Type: `CircularProgress` · default size 96 x 96 · main property: `Value`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Value` | number | Data | `=65` | Simple |
| `Max` | number | Data | `=100` | Simple |
| `ShowLabel` | boolean | Content | `=true` | Simple |
| `Thickness` | number | Style | `=8` | Simple |
| `Color` | color | Style | `=Blank()` | Simple |
| `TrackColor` | color | Style | `=Blank()` | Advanced |

**Events:** none.

### Spinner

A small spinning indicator for waiting.

Type: `Spinner` · default size 96 x 64 · main property: `Size`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Size` | number | Style | `=28` | Simple |
| `Label` | text | Content | `=""` | Simple |
| `Color` | color | Style | `=Blank()` | Simple |

**Events:** none.

### Skeleton

A grey placeholder shape shown while content loads.

Type: `Skeleton` · default size 240 x 80 · main property: `Kind`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Kind` | enum | Style | `="Rectangle"` | Simple | `"Rectangle"`, `"Circle"`, `"Text"` |
| `Radius` | number | Style | `=8` | Simple |  |
| `Animate` | boolean | Style | `=true` | Simple |  |
| `Fill` | color | Style | `=Blank()` | Advanced |  |

**Events:** none.

### Alert

A message box in a coloured style, which can be dismissed.

Type: `Alert` · default size 420 x 72 · main property: `Text`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Title` | text | Content | `="Heads up"` | Simple |  |
| `Text` | text | Content | `="Something you should know about."` | Simple |  |
| `Variant` | enum | Style | `="Info"` | Simple | `"Info"`, `"Success"`, `"Warning"`, `"Error"` |
| `Icon` | icon | Content | `=""` | Advanced |  |
| `Dismissible` | boolean | Behaviour | `=false` | Simple |  |
| `OnDismiss` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Dismissed` | `false` |

**Events:** `OnDismiss`.

### Empty state

A friendly message with an icon and an optional action, for when there is nothing to show.

Type: `EmptyState` · default size 360 x 220 · main property: `Title`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Icon` | icon | Content | `="Inbox"` | Simple |
| `Title` | text | Content | `="Nothing here yet"` | Simple |
| `Description` | text | Content | `="Items you add will show up here."` | Simple |
| `ActionText` | text | Content | `=""` | Simple |
| `OnAction` | action | Behaviour | `=false` | Simple |

**Events:** `OnAction`.

## Media

### Video

Plays a video from a source address.

Type: `Video` · default size 480 x 270 · main property: `Source`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Source` | text | Content | `=""` | Simple |  |
| `Poster` | text | Content | `=""` | Advanced |  |
| `Controls` | boolean | Behaviour | `=true` | Simple |  |
| `AutoPlay` | boolean | Behaviour | `=false` | Simple |  |
| `Loop` | boolean | Behaviour | `=false` | Simple |  |
| `Muted` | boolean | Behaviour | `=false` | Simple |  |
| `Fit` | enum | Style | `="Contain"` | Advanced | `"Contain"`, `"Cover"`, `"Fill"` |
| `OnEnd` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Playing` | `false` |

**Events:** `OnEnd`.

### Audio

Plays sound from a source address.

Type: `Audio` · default size 360 x 48 · main property: `Source`

| Property | Kind | Group | Default | Level |
| --- | --- | --- | --- | --- |
| `Source` | text | Content | `=""` | Simple |
| `Controls` | boolean | Behaviour | `=true` | Simple |
| `AutoPlay` | boolean | Behaviour | `=false` | Simple |
| `Loop` | boolean | Behaviour | `=false` | Simple |
| `OnEnd` | action | Behaviour | `=false` | Simple |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Playing` | `false` |

**Events:** `OnEnd`.

### Animated icon

An animated icon that can play on hover, on click or in a loop.

Type: `AnimatedIcon` · default size 64 x 64 · main property: `Icon`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Icon` | icon | Content | `=AnimatedIcon.Heart` | Simple |  |
| `Interaction` | enum | Behaviour | `="Default"` | Simple | `"Default"`, `"Loop"`, `"Hover"`, `"HoverLoop"`, `"HoverReplay"`, `"ClickReplay"`, `"ClickToggle"` |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `FillColor` | color | Style | `=Blank()` | Advanced |  |
| `Size` | number | Style | `=32` | Simple |  |
| `Speed` | number | Behaviour | `=1` | Advanced |  |
| `Active` | boolean | Behaviour | `=false` | Simple |  |
| `Autoplay` | boolean | Behaviour | `=true` | Advanced |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Active` | `false` |

**Events:** `OnSelect`.

## Charts

### Chart

A bar, line, area, pie or donut chart of a table.

Type: `Chart` · default size 520 x 320 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=Table({Month: "Jan", Sales: 120, Costs: 80}, {Month: "Feb", Sales: 160, Costs: 95}, {Month: "Mar", Sales: 140, Costs: 90}, {Month: "Apr", Sales: 210, Costs: 120}, {Month: "May", Sales: 190, Costs: 110}, {Month: "Jun", Sales: 260, Costs: 140})` | Simple |  |
| `Type` | enum | Style | `=ChartType.Bar` | Simple | any [ChartType](formulas.md#charttype) member |
| `CategoryField` | text | Data | `=""` | Simple |  |
| `ValueFields` | text | Data | `=""` | Simple |  |
| `Title` | text | Content | `=""` | Simple |  |
| `ShowLegend` | boolean | Style | `=true` | Simple |  |
| `ShowGrid` | boolean | Style | `=true` | Simple |  |
| `Stacked` | boolean | Style | `=false` | Simple |  |
| `OnSelect` | action | Behaviour | `=false` | Simple |  |

**Outputs**

| Output | Initial value |
| --- | --- |
| `Selected` | blank |

**Events:** `OnSelect`.

### Sparkline

A tiny chart without axes, to show a trend inside a row or a card.

Type: `Sparkline` · default size 160 x 48 · main property: `Items`

| Property | Kind | Group | Default | Level | Values |
| --- | --- | --- | --- | --- | --- |
| `Items` | table | Data | `=[3, 5, 4, 8, 6, 9, 7, 12]` | Simple |  |
| `ValueField` | text | Data | `=""` | Simple |  |
| `Kind` | enum | Style | `="Area"` | Simple | `"Area"`, `"Line"`, `"Bar"` |
| `Color` | color | Style | `=Blank()` | Simple |  |
| `ShowDot` | boolean | Style | `=true` | Advanced |  |

**Events:** none.
