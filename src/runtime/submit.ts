/**
 * Async tail of a Form submit. The local (optimistic) insert/update has already happened; here we wait
 * for the server's verdict (flush), then upload the pending files for file/image columns, then refresh.
 */

export interface SubmitDeps {
  /** platform.tables.flush: resolves when all pending writes are persisted, rejects with the server's verdict */
  flush(): Promise<void>
  /** platform.attachments.upload */
  upload(table: string, column: string, rowId: string, file: File): Promise<unknown>
  /** platform.tables.reload (optional): re-read the table so the file cells show the new attachment ids */
  reload?(table: string): Promise<void>
}

export interface SubmitPlan {
  table: string
  rowId: string
  files: Array<{ column: string; files: File[] }>
}

export class SubmitError extends Error {
  stage: 'write' | 'upload'
  constructor(stage: 'write' | 'upload', message: string) {
    super(message)
    this.stage = stage
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** resolves with the number of uploaded files; rejects with a SubmitError (stage 'write' = server refused the row) */
export async function finishSubmit(deps: SubmitDeps, plan: SubmitPlan): Promise<number> {
  try {
    await deps.flush()
  } catch (e) {
    throw new SubmitError('write', msg(e))
  }
  let uploaded = 0
  for (const group of plan.files) {
    for (const file of group.files) {
      try {
        await deps.upload(plan.table, group.column, plan.rowId, file)
        uploaded++
      } catch (e) {
        if (uploaded > 0) await refresh(deps, plan.table)
        throw new SubmitError('upload', `${file.name}: ${msg(e)}`)
      }
    }
  }
  if (uploaded > 0) await refresh(deps, plan.table)
  return uploaded
}

async function refresh(deps: SubmitDeps, table: string) {
  try {
    await deps.reload?.(table)
  } catch {
    /* the cache refreshes on the next load */
  }
}
