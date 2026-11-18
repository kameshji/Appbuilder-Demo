# Inputs controls: what the runtime must do (from the Inputs agent's hand-back)

All 24 input controls live in src/controls/inputs. Every control honours `focusToken` (focus on change, not on mount).

## Form (src/controls/inputs/Form.tsx, category Data)
Props: DataSource (tableName, `="Contacts"`), Item (record, `=Blank()`), Mode (`=FormMode.Edit`), Fields, Columns, ShowButtons, SubmitText, CancelText, OnSuccess, OnFailure, OnCancel.
Outputs: Updates, Valid, Mode, LastSubmit, Error, Unsaved, plus internal counters `__reset`, `__touch`, `__saved` (initial 0; do not delete them; hide `__*` outputs from autocomplete).

1. `Updates` = record of every displayed editable field, typed to the column (number, boolean, Date, null for blank, lookup = target row id text; autonumber excluded). New mode: `platform.tables.insert(ds, Updates)`. Edit mode: `platform.tables.update(ds, Item.__id, Updates)`. Edit with a blank Item (no `__id`): treat as insert.
2. Effective mode = `Mode` output when non-blank, else the `Mode` prop. Values exactly 'Edit' | 'New' | 'View'. NewForm/EditForm/ViewForm write the `Mode` output; NewForm also bumps `__reset`.
3. ResetForm(F): increment the `__reset` output (form reloads from Item, or defaults in New mode). Plain Reset(Form1) returning outputs to initial values also works.
4. `__submit` event (built-in Save button fires it only when already valid): insert/update from Updates, then set LastSubmit to the stored record, clear Error, increment `__saved`, fire OnSuccess. On PlatformError: set Error to its message, fire OnFailure.
   SubmitForm(Form1) from a formula: the runtime must check `Valid` itself; if false, bump `__touch` (shows inline messages), set Error, fire OnFailure, do not write.
5. Add the DataSource table name to `app.dataSources` automatically.
6. Editor kinds used: DataSource = tableName, Icon props = icon, Item = record, date Default/Min/Max = any.

## Other notes
- Multiple-selection controls: `Selected` = first selected item; `SelectedItems` = all.
- Timer never runs in design mode; `Start` is edge-triggered; `AutoStart` starts on mount.
- react-day-picker installed is v10 (calendar.tsx is written for v10).
