import type { FxRecord, FxValue } from '@/contracts'
import { isRecord, toRows, withoutId } from '../values'
import { FxError } from '../errors'
import { def, MANY, NOT_PURE, type CallCtx, type FnDef } from './types'

/** Items for Collect: records stay records, scalars become { Value }, tables are flattened. __id is dropped so the host assigns fresh ids. */
function itemsFrom(c: CallCtx, from: number): FxRecord[] {
  const out: FxRecord[] = []
  for (let i = from; i < c.argc; i++) {
    const v = c.value(i)
    if (v === null) continue
    if (Array.isArray(v)) out.push(...toRows(v).map(withoutId))
    else if (isRecord(v)) out.push(withoutId(v))
    else out.push({ Value: v })
  }
  return out
}

function recordsFrom(c: CallCtx, from: number): FxRecord[] {
  const out: FxRecord[] = []
  for (let i = from; i < c.argc; i++) {
    const v = c.value(i)
    if (v === null) continue
    if (Array.isArray(v)) out.push(...toRows(v))
    else if (isRecord(v)) out.push(v)
    else c.fail(i, "Remove needs records. Use the rows of a collection, like Remove(Contacts, ThisItem)")
  }
  return out
}

function existingRows(c: CallCtx, coll: string): FxRecord[] {
  const rows = c.currentRows(coll)
  if (rows === undefined) return c.fail(0, `Name isn't recognised: ${coll}`)
  return rows
}

function mergeChanges(c: CallCtx, from: number, row?: FxRecord): FxRecord {
  const out: FxRecord = {}
  for (let i = from; i < c.argc; i++) {
    const v = row ? c.row(i, row) : c.value(i)
    if (v === null) continue
    if (!isRecord(v)) return c.fail(i, 'The changes must be a record, like {Name: "Asha"}')
    for (const k of Object.keys(v)) if (k !== '__id' && k !== '__proto__') out[k] = v[k]!
  }
  return out
}

function upsert(rows: FxRecord[], rec: FxRecord): FxRecord[] {
  const id = rec.__id
  if (typeof id === 'string') {
    const idx = rows.findIndex((r) => r.__id === id)
    if (idx >= 0) {
      const next = rows.slice()
      next[idx] = rec
      return next
    }
  }
  return [...rows, rec]
}

const KINDS: Record<string, 'info' | 'success' | 'warning' | 'error'> = {
  information: 'info', info: 'info', success: 'success', warning: 'warning', error: 'error',
}

export const behaviourFns: FnDef[] = [
  def('Set', 'Set(variable, value)', 'Sets a global variable.', 2, 2, (c) => {
    const name = c.nameOf(0)
    const value = c.value(1)
    c.host!.setVar(name, value)
    c.session.vars.set(name, value)
    return null
  }, 'behaviour'),
  def('UpdateContext', 'UpdateContext({ name: value, ... })', 'Sets context variables for the current screen.', 1, 1, (c) => {
    const rec = c.value(0)
    if (!isRecord(rec)) return c.fail(0, 'UpdateContext needs a record, like UpdateContext({count: 1})')
    c.host!.updateContext(rec)
    for (const k of Object.keys(rec)) c.session.vars.set(k, rec[k]!)
    return null
  }, 'behaviour'),
  def('Collect', 'Collect(collection, item [, item2, ...])', 'Adds records (or the rows of a table) to a collection.', 2, MANY, (c) => {
    const name = c.nameOf(0)
    const items = itemsFrom(c, 1)
    c.host!.collect(name, items, false)
    const rows = [...(c.currentRows(name) ?? []), ...items]
    c.session.colls.set(name, rows)
    return items
  }, 'behaviour'),
  def('ClearCollect', 'ClearCollect(collection, table)', 'Replaces the contents of a collection.', 2, MANY, (c) => {
    const name = c.nameOf(0)
    const items = itemsFrom(c, 1)
    c.host!.collect(name, items, true)
    c.session.colls.set(name, items)
    return items
  }, 'behaviour'),
  def('Clear', 'Clear(collection)', 'Removes every row from a collection.', 1, 1, (c) => {
    const name = c.nameOf(0)
    c.host!.clear(name)
    c.session.colls.set(name, [])
    return null
  }, 'behaviour'),
  def('Remove', 'Remove(collection, record [, record2, ...])', 'Removes records from a collection.', 2, MANY, (c) => {
    const name = c.nameOf(0)
    const recs = recordsFrom(c, 1)
    c.host!.remove(name, recs)
    const ids = new Set(recs.map((r) => r.__id).filter((x): x is string => typeof x === 'string'))
    const cur = c.currentRows(name)
    if (cur) c.session.colls.set(name, cur.filter((r) => !(typeof r.__id === 'string' && ids.has(r.__id)) && !recs.includes(r)))
    return null
  }, 'behaviour'),
  def('RemoveIf', 'RemoveIf(collection, condition)', 'Removes every row where the condition is true.', 2, 2, (c) => {
    const name = c.nameOf(0)
    const rows = existingRows(c, name)
    const gone = rows.filter((r) => c.rowBool(1, r))
    if (gone.length) {
      c.host!.remove(name, gone)
      c.session.colls.set(name, rows.filter((r) => !gone.includes(r)))
    }
    return null
  }, 'behaviour'),
  def('UpdateIf', 'UpdateIf(collection, condition, changes)', 'Changes every row where the condition is true.', 3, MANY, (c) => {
    const name = c.nameOf(0)
    const rows = existingRows(c, name)
    const next = rows.slice()
    rows.forEach((r, i) => {
      if (!c.rowBool(1, r)) return
      const changes = mergeChanges(c, 2, r)
      const stored = c.host!.patch(name, r, changes)
      next[i] = stored
    })
    c.session.colls.set(name, next)
    return null
  }, 'behaviour'),
  {
    ...def('Patch', 'Patch(collection, base, changes) or Patch(record, changes)', 'Changes a record, or creates a new one when base is Defaults(collection). Returns the stored record. With a record as the first argument it only merges the records and returns the result.', 2, MANY, (c) => {
    const name = c.nameOf(0)
    const baseV = c.value(1)
    if (baseV !== null && !isRecord(baseV)) return c.fail(1, 'Patch needs a record as its second argument, like Defaults(Contacts) or a row')
    const base: FxRecord = baseV ?? {}
    const changes = mergeChanges(c, 2)
    const stored = c.host!.patch(name, base, changes)
    const cur = c.currentRows(name) ?? []
    c.session.colls.set(name, upsert(cur, stored))
    return stored
  }, 'behaviour'),
    tryPure(c) {
      // Patch(record, record, ...): a pure merge. Anything that is not clearly a record uses the collection form.
      let first: FxValue
      try {
        first = c.value(0)
      } catch {
        return NOT_PURE
      }
      if (!isRecord(first)) return NOT_PURE
      const out: FxRecord = { ...first }
      for (let i = 1; i < c.argc; i++) {
        const v = c.value(i)
        if (v === null) continue
        if (!isRecord(v)) return c.fail(i, 'The changes must be a record, like {Name: "Asha"}')
        for (const k of Object.keys(v)) if (k !== '__id' && k !== '__proto__') out[k] = v[k]!
      }
      return out
    },
  },
  def('Navigate', 'Navigate(Screen)', 'Goes to another screen.', 1, 2, (c) => {
    c.host!.navigate(c.nameOf(0))
    return null
  }, 'behaviour'),
  def('Back', 'Back()', 'Returns to the previous screen.', 0, 0, (c) => {
    c.host!.back()
    return null
  }, 'behaviour'),
  def('Notify', 'Notify(message [, NotificationType])', 'Shows a message to the user.', 1, 2, (c) => {
    const msg = c.text(0)
    let kind: 'info' | 'success' | 'warning' | 'error' = 'info'
    if (c.argc > 1) {
      const k = KINDS[c.text(1).trim().toLowerCase()]
      if (!k) return c.fail(1, 'Notification type must be NotificationType.Information, Success, Warning or Error')
      kind = k
    }
    c.host!.notify(msg, kind)
    return null
  }, 'behaviour'),
  def('Reset', 'Reset(control)', 'Puts an input control back to its default value.', 1, 1, (c) => {
    c.host!.reset(c.nameOf(0))
    return null
  }, 'behaviour'),
  def('Refresh', 'Refresh(table)', 'Reloads a table from storage.', 1, 1, (c) => {
    c.host!.refresh(c.nameOf(0))
    return null
  }, 'behaviour'),
  def('SubmitForm', 'SubmitForm(Form)', 'Saves the data entered in a form.', 1, 1, (c) => { c.host!.form('submit', c.nameOf(0)); return null }, 'behaviour'),
  def('ResetForm', 'ResetForm(Form)', 'Puts every field of a form back to its starting value.', 1, 1, (c) => { c.host!.form('reset', c.nameOf(0)); return null }, 'behaviour'),
  def('NewForm', 'NewForm(Form)', 'Switches a form to New mode with empty fields.', 1, 1, (c) => { c.host!.form('new', c.nameOf(0)); return null }, 'behaviour'),
  def('EditForm', 'EditForm(Form)', 'Switches a form to Edit mode.', 1, 1, (c) => { c.host!.form('edit', c.nameOf(0)); return null }, 'behaviour'),
  def('ViewForm', 'ViewForm(Form)', 'Switches a form to View mode.', 1, 1, (c) => { c.host!.form('view', c.nameOf(0)); return null }, 'behaviour'),
  def('Select', 'Select(control)', 'Runs the OnSelect of a control.', 1, 1, (c) => { c.host!.select(c.nameOf(0)); return null }, 'behaviour'),
  def('SetFocus', 'SetFocus(control)', 'Moves the keyboard focus to a control.', 1, 1, (c) => { c.host!.setFocus(c.nameOf(0)); return null }, 'behaviour'),
  def('Launch', 'Launch(url)', 'Opens a web address.', 1, 1, (c) => { c.host!.launch(c.text(0)); return null }, 'behaviour'),
  def('Download', 'Download(url)', 'Starts a download from a web address.', 1, 1, (c) => { c.host!.launch(c.text(0)); return null }, 'behaviour'),
  def('Copy', 'Copy(text)', 'Copies text to the clipboard.', 1, 1, (c) => { c.host!.copy(c.text(0)); return null }, 'behaviour'),
  def('Trace', 'Trace(message [, data])', 'Writes a line to the debug console.', 1, 2, (c) => {
    const msg = c.text(0)
    if (c.argc > 1) c.host!.trace(msg, c.value(1))
    else c.host!.trace(msg)
    return null
  }, 'behaviour'),
  def('Exit', 'Exit()', 'Closes the running app.', 0, 0, (c) => { c.host!.exit(); return null }, 'behaviour'),
  def('Concurrent', 'Concurrent(action1, action2, ...)', 'Runs several actions. Every action runs even when one fails; the first failure is then reported.', 1, MANY, (c) => {
    let first: unknown
    for (let i = 0; i < c.argc; i++) {
      try {
        c.value(i)
      } catch (e) {
        if (!(e instanceof FxError) || e.fatal) throw e
        if (first === undefined) first = e
      }
    }
    if (first !== undefined) throw first
    return null
  }, 'behaviour'),
]

