# Formulas

Formulas are short expressions, like in a spreadsheet, that you type into the formula bar. This page is a tutorial. For every function and operator see the [formula reference](../../reference/formulas.md).

Do not type a leading `=` in the formula bar; it is shown for you.

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

- Formulas run synchronously; there is no waiting for a result inside one formula.
- `;` chaining works only in action properties.
- Errors show in the formula bar and in the status bar error list.
