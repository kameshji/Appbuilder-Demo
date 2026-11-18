# Formulas

Formulas are short expressions, like in a spreadsheet, that you type into the formula bar. This page is a tutorial. For every function and operator see the [formula reference](../../reference/formulas.md).

The formula bar shows a leading `=` for you. Typing one yourself is optional: `=Filter(...)` and `Filter(...)` are the same formula.

## Data properties and action properties

- A **data** property (Text, Items, Visible, Fill, DisplayMode) holds a value. It is recalculated whenever what it depends on changes. Example: Text = `"Hello, " & User().FullName`.
- An **action** property (OnSelect, OnSuccess, OnStart and similar) runs when something happens. Only these can do several things in a row, separated by `;`.

## Refer to controls

Use a control's name and a property: `TextInput1.Value`, `DataTable1.Selected`, `Toggle1.Value`. Rename controls in the tree to make formulas readable.

## Variables

- `Set(count, 0)` creates or changes a global variable. Use `count` anywhere.
- `UpdateContext({showDlg: true})` creates a variable that belongs to the current screen.
- Collections hold tables in memory: `Collect(Cart, {Item: "Tripod"})`, `ClearCollect(...)`, `Clear(Cart)`, `Remove`, `RemoveIf`, `UpdateIf`.

The Variables pane shows their current values.

## Filter a table into a gallery

Set the gallery's **Items** to:

`Filter(Equipment, Category = "Laptop" && !CheckedOut)`

Add a search box: `Filter(Equipment, IsBlank(SearchBox1.Value) || SearchBox1.Value in Item)`. Wrap with `Sort(...)`, `FirstN(...)` or `CountRows(...)` as needed. Column names in formulas are the display name without spaces ("Checked out to" becomes `CheckedOutTo`).

With the local server these formulas run in the database, so they work on tables of any size: the gallery shows the first rows and
loads more as you scroll. Calculations on number columns are fine too: `Filter(Orders, Qty * Price > 1000)`,
`Sum(Orders, Qty * Price)`, `Round(Price * 1.18, 2)`, `Year(OrderDate) = 2026`.

## When a formula can't run on the server

The formula bar shows **Runs on server**, **Runs in browser** or **Can't run** for formulas that read tables. A formula that can't be
translated into a database query (for example `Len(Title) > 3`, `Month(Due) = 3`, `Price / Cost > 2`, `Concat(Filter(Orders, ...), Title)`)
is evaluated in the browser only while the table is small (at most 2,000 rows you can see), with a warning. On a bigger table it is an
**error**: the part that can't run is underlined, and the message says why and how to rewrite it. Appbuilder never shows a result
computed from only some of the rows. See [Data: large tables](data.md#large-tables-what-runs-on-the-server).

## Change data

Patch a row: `Patch(Equipment, DataTable1.Selected, {CheckedOut: true})`. Add a new row: `Patch(Equipment, Defaults(Equipment), {Item: "Tripod"})`. Remove: `Remove(Equipment, DataTable1.Selected)`.

For editing screens, the **Form** control is usually better than Patch: it validates fields and waits for the server's answer. Set its **DataSource**, **Item** (for example `DataTable1.Selected`), **Mode** (`FormMode.Edit` or `FormMode.New`), and react in **OnSuccess** and **OnFailure**. See [Security for makers](security-for-makers.md) for why this matters.

## Navigate and Notify

`Navigate(DetailScreen)` goes to another screen, `Back()` returns. `Notify("Saved", NotificationType.Success)` shows a toast. Types: Information, Success, Warning, Error.

## Named formulas and your own functions

In **Settings > App.Formulas** write one per line:

```
Overdue = Filter(Equipment, DueDate < Today());
Area(w: Number, h: Number): Number = w * h;
```

Then use `Overdue` or `Area(2, 3)` anywhere.

## Good to know

- Formulas that read tables may wait for the server: a control shows its previous value (or nothing, the first time) until the answer
  arrives. In an action (`OnSelect`), each step of `a; b; c` reads the server after the earlier steps were saved, so
  `Patch(...); Set(n, CountRows(Orders))` counts the new row.
- `;` chaining works only in action properties.
- Errors show in the formula bar and in the status bar error list.
