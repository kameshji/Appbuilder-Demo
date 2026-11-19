import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { platform } from '@/platform'
import { UNDO_SECONDS, type DeletedEvent } from '@/platform/recycle-api'
import { cn } from '@/lib/utils'
import { errorMessage } from './data'

/**
 * Recycle bin: after a delete that kept its rows (the table keeps deleted rows), "N rows deleted. Undo" for
 * UNDO_SECONDS; Undo restores exactly that delete (its batch: cascaded rows and cleared links too). Used by running
 * apps and the portal's data grid. Deletes of tables that keep no deleted rows show nothing (they are final).
 */
export function UndoDelete({ contained = false, tables, testId = 'undo-delete' }: { contained?: boolean; tables?: string[]; testId?: string }) {
  const [ev, setEv] = useState<DeletedEvent | null>(null)
  const [left, setLeft] = useState(0)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const want = tables ? new Set(tables.map((t) => t.toLowerCase())) : null

  useEffect(() => platform.recycle?.onDeleted((e) => {
    if (want && !want.has(e.table.toLowerCase())) return
    setEv(e)
    setState('idle')
    setMessage('')
    setLeft(UNDO_SECONDS)
  }) ?? (() => {}), [want ? [...want].join(',') : ''])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ev || state === 'busy') return
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(() => setLeft((n) => n - 1), 1000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [ev, state])
  useEffect(() => {
    if (ev && left <= 0 && state !== 'busy') setEv(null)
  }, [left, ev, state])

  if (!ev) return null
  const n = ev.batch.rows
  const undo = async () => {
    setState('busy')
    try {
      const r = await platform.recycle!.restore(ev.table, { batch: ev.batch.id })
      setState('done')
      setMessage(r.warnings.length ? `Restored, with notes: ${r.warnings.join(' ')}` : `Restored ${r.restored === 1 ? 'the row' : `${r.restored} rows`}.`)
      setLeft(r.warnings.length ? 8 : 3)
    } catch (e) {
      setState('error')
      setMessage(errorMessage(e))
      setLeft(8)
    }
  }
  return (
    <div className={cn('pointer-events-none inset-x-0 bottom-24 z-[310] flex justify-center', contained ? 'absolute' : 'fixed')}>
      <div role="status" data-testid={testId} className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-lg border border-border bg-popover px-3.5 py-2 text-sm text-popover-foreground shadow-lg">
        {state === 'busy' ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : state === 'done' ? <RotateCcw className="size-4 shrink-0 text-emerald-500" /> : <Trash2 className={cn('size-4 shrink-0', state === 'error' ? 'text-red-500' : 'text-muted-foreground')} />}
        <span data-testid={`${testId}-text`}>
          {state === 'idle' || state === 'busy'
            ? `${n === 1 ? '1 row' : `${n} rows`} deleted${ev.batch.rootIds.length && n > ev.batch.rootIds.length ? ` (with related rows)` : ''}. Kept for ${ev.keepDays} ${ev.keepDays === 1 ? 'day' : 'days'}.`
            : message}
        </span>
        {(state === 'idle' || state === 'busy') && (
          <button type="button" disabled={state === 'busy'} onClick={() => void undo()} data-testid={`${testId}-undo`} className="rounded-md px-2 py-1 font-medium text-primary hover:bg-accent disabled:opacity-50">
            Undo{state === 'idle' ? ` (${Math.max(0, left)})` : ''}
          </button>
        )}
        <button type="button" aria-label="Close" onClick={() => setEv(null)} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
      </div>
    </div>
  )
}
