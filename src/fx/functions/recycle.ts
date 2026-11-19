/**
 * Recycle bin functions (docs/dev/recycle-bin.md, docs/guide/maker/data.md "Deleted rows"):
 *
 *   DeletedRows(Table)       the rows of the table's recycle bin the signed-in user could delete and can see
 *                            (administrators: all), newest first, at most 500; read on the server (security-trimmed)
 *                            and cached: empty while loading, refreshed after a delete or a restore in this session.
 *                            Each row has the table's columns plus DeletedOn, DeletedBy (a name), DeleteBatch,
 *                            DaysLeft, DeletedTable (the table name) and CascadedFrom (the table whose delete took the
 *                            row along, blank when the row itself was deleted).
 *   Restore(rowOrBatch)      behaviour: brings back a row of DeletedRows(...) (with what its delete did to it) or a whole
 *                            batch (its id, such as ThisItem.DeleteBatch). Asynchronous: failures are notified.
 */
import type { FxRecord } from '../../contracts.ts'
import { isRecord } from '../values.ts'
import { def, type FnDef } from './types.ts'

export const recycleFns: FnDef[] = [
  def('DeletedRows', 'DeletedRows(table)', 'The rows in the recycle bin of a table that you could delete and can see (administrators: all), newest first (at most 500), with DeletedOn, DeletedBy, DeleteBatch, DaysLeft, DeletedTable and CascadedFrom. Empty while loading and for tables that keep no deleted rows.', 1, 1, (c) => {
    const name = c.nameOf(0)
    let v
    try {
      v = c.session.scope.resolve('DeletedRows:' + name)
    } catch (e) {
      return c.fail(null, e instanceof Error && e.message ? e.message : `Couldn't read the deleted rows of ${name}`, true)
    }
    return Array.isArray(v) ? v : []
  }),
  def('Restore', 'Restore(deletedRowOrBatch)', 'Brings back a deleted row (a row of DeletedRows(...)) or a whole deletion batch (its id, such as ThisItem.DeleteBatch), undoing what that delete did. Only rows you could delete and can see.', 1, 1, (c) => {
    const v = c.value(0)
    if (!c.host!.restore) return c.fail(null, 'Restoring deleted rows is not available here', true)
    if (typeof v === 'string' && v.trim()) {
      c.host!.restore({ batch: v.trim() })
      return null
    }
    if (isRecord(v)) {
      const r = v as FxRecord
      const id = typeof r.__id === 'string' ? r.__id : typeof r.id === 'string' ? r.id : ''
      const table = typeof r.DeletedTable === 'string' ? r.DeletedTable : ''
      if (!id || !table) return c.fail(0, 'Restore needs a row of DeletedRows(Table), like Restore(Gallery1.Selected), or a batch id')
      c.host!.restore({ rowId: id, table })
      return null
    }
    return c.fail(0, 'Restore needs a row of DeletedRows(Table), like Restore(Gallery1.Selected), or a batch id')
  }, 'behaviour'),
]
