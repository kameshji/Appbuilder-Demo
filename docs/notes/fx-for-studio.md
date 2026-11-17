# Fx phase 2: what the Studio/runtime must know (from the Fx agent's hand-back)

- Host-less behaviour call error is exactly `Behaviour function in a non-behaviour property` (fatal; span = function name). `;` without a host: "Chaining with ; only works in behaviour properties such as OnSelect".
- Form actions pass the name as typed: `SubmitForm(Form1)` -> `host.form('submit', 'Form1')`. Same pattern for Select, SetFocus, Reset. `Download(url)` -> `host.launch(url)`. `Refresh(T)` -> `host.refresh(name)`. `Trace(msg [, data])`, `Copy`, `Launch`, `Exit` -> matching host methods.
- scope.resolve keys: `User()` asks for `"User()"` (record with FullName, Email, ...); `Param("id")` asks for `"Param:id"`. Return undefined when unknown.
- Named formulas: `fx.parseNamedFormulas(app.appProps.Formulas)` whenever the text changes. Items: `{name, formula: '=expr'}`; items with `params` are user-defined functions. Resolve plain items lazily inside scope.resolve(name) by evaluating the formula, with cycle detection on the runtime side. Error offsets are positions in the source text passed in. One bad definition does not hide the others.
- UDFs: `fx.setUserFunctions(items)` with the items from the same parse (items without params are ignored; replaces the previous set; `[]` clears). Call before evaluating. `check`, `evaluate`, `functions`, `signatureAt` all see them. A UDF body is a single expression and sees only its params, host names, enums and functions (not the caller's row fields). Recursion limit 64.
- `fx.signatureAt(source, offset)`: offset = caret position; returns `{name, signature, summary, argIndex}` (argIndex 0-based, not clamped) for the innermost unclosed known call, else null. Works on unfinished formulas.
- `Table.Column` -> single-column table. `in` works on single-column tables.
- `Patch(record, record)` with a record first argument is a pure merge (no host call). `Patch(Table, Defaults(Table), {...})` and `Patch(Table, row, {...})` take the behaviour path.
- Enum names shadow host names: a maker variable or control named Size, Side, Fit, Layout, Icon, Variant, Match, Anchor, Justify, Orientation, Color, Align... is shadowed. Reject those names when a control is renamed or warn when a variable is created.
- Enums available: Anchor, Layout, Justify, AlignItems, FormMode, Fit, Orientation, Variant, Size, Side, ChartType, TextMode, SelectionMode, Icon (91 lucide names), Color (~52), Match, MatchOptions, plus the phase-1 ones. `fx.enums()` lists members for autocomplete and the icon picker.
- `Concurrent(a, b, ...)` runs every argument.
