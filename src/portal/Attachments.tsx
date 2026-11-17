/** Attachment cells ('file' / 'image' columns): thumbnails and chips in the grid, and a dialog to upload and remove. */
import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from 'lucide-react'
import { platform, usePlatform, type AttachmentRef, type ColumnDef, type TableDef } from '@/platform'
import type { FxValue } from '@/contracts'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { errMsg, useToast } from './kit'

export const isAttachmentCol = (c: ColumnDef) => c.type === 'file' || c.type === 'image'

const DIRECT = /^(https?:|data:|blob:|\/)/i

/** cell value -> attachment ids (a single id, or a JSON array of ids when the column allows several) */
export function parseAttachmentIds(v: FxValue | undefined): string[] {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x && 'Value' in x ? String((x as { Value: unknown }).Value) : String(x))).filter(Boolean)
  const t = String(v).trim()
  if (!t) return []
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t) as unknown
      if (Array.isArray(a)) return a.map(String).filter(Boolean)
    } catch { /* fall through: treat as a single value */ }
  }
  return [t]
}
export const idsToCell = (c: ColumnDef, ids: string[]): FxValue => (ids.length === 0 ? null : c.multiple ? JSON.stringify(ids) : ids[0])

/* ------------------------------------------------------------------ metadata cache */

const cache = new Map<string, AttachmentRef | null>()
const listeners = new Set<() => void>()
const pending = new Set<string>()

function resolveMissing(ids: string[]) {
  const missing = ids.filter((id) => !DIRECT.test(id) && !cache.has(id) && !pending.has(id))
  if (!missing.length) return
  for (const id of missing) pending.add(id)
  platform.attachments.resolve(missing)
    .then((refs) => { for (const id of missing) cache.set(id, refs.find((r) => r.id === id) ?? null) })
    .catch(() => { for (const id of missing) cache.set(id, null) })
    .finally(() => { for (const id of missing) pending.delete(id); listeners.forEach((l) => l()) })
}

export function useAttachmentRefs(ids: string[]): (id: string) => AttachmentRef | null | undefined {
  const [, bump] = useState(0)
  const key = ids.join('|')
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    resolveMissing(ids)
    return () => { listeners.delete(l) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (id) => cache.get(id)
}

const srcOf = (id: string) => (DIRECT.test(id) ? id : platform.attachments.url(id))
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const isImageRef = (c: ColumnDef, r: AttachmentRef | null | undefined, id: string) => (r ? r.mime.startsWith('image/') : c.type === 'image' || DIRECT.test(id))

/** client-side pre-check against the column options; the server checks again */
export function checkAttachment(c: ColumnDef, f: File): string | null {
  const max = c.maxSizeMB ?? 25
  if (f.size > max * 1024 * 1024) return `"${f.name}" is larger than ${max} MB.`
  if (f.size === 0) return `"${f.name}" is empty.`
  const acc = c.accept ?? []
  if (acc.length) {
    const mime = f.type || ''
    const ok = acc.some((p) => (p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : p.includes('*') ? new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(mime) : p.startsWith('.') ? f.name.toLowerCase().endsWith(p.toLowerCase()) : mime === p))
    if (!ok) return `"${f.name}" is not an accepted type (${acc.join(', ')}).`
  }
  return null
}

/* ------------------------------------------------------------------ grid cell */

export function AttachmentCell({ col, value, onManage, canEdit, testId }: { col: ColumnDef; value: FxValue | undefined; onManage(): void; canEdit: boolean; testId: string }) {
  const ids = parseAttachmentIds(value)
  const ref = useAttachmentRefs(ids)
  const [bad, setBad] = useState<Set<string>>(new Set())
  const shown = ids.slice(0, 3)
  return (
    <div className="flex h-full items-center gap-1 px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {shown.map((id) => {
          const r = ref(id)
          if (isImageRef(col, r, id) && !bad.has(id)) {
            return <img key={id} src={srcOf(id)} alt={r?.fileName ?? 'Attachment'} loading="lazy" onError={() => setBad((s) => new Set(s).add(id))} className="size-6 shrink-0 rounded border border-border object-cover" data-testid={`thumb-${id}`} />
          }
          return (
            <span key={id} className="inline-flex max-w-[8rem] shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px]" title={r?.fileName ?? id}>
              {r && r.mime.startsWith('image/') ? <ImageIcon className="size-3 shrink-0" /> : <FileText className="size-3 shrink-0" />}
              <span className="truncate">{r === null ? 'Unavailable' : r?.fileName ?? '...'}</span>
            </span>
          )
        })}
        {ids.length > shown.length && <span className="shrink-0 text-[11px] text-muted-foreground">+{ids.length - shown.length}</span>}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onManage() }}
        aria-label={canEdit ? `Manage attachments (${ids.length})` : `View attachments (${ids.length})`}
        title={canEdit ? 'Add or remove files' : 'View files'}
        data-testid={testId}
        className={cn('grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40', ids.length === 0 && 'opacity-50')}
      >
        <Paperclip className="size-3.5" />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ dialog */

export function AttachmentsDialog({ open, onOpenChange, table, col, rowId, canEdit }: { open: boolean; onOpenChange(o: boolean): void; table: TableDef; col: ColumnDef; rowId: string; canEdit: boolean }) {
  const { fail, toast } = useToast()
  usePlatform((s) => s.dataVersion)
  const [busy, setBusy] = useState('')
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const row = open ? platform.tables.rows(table.name, { secure: false }).find((r) => String(r.__id ?? r.id) === rowId) : undefined
  const ids = parseAttachmentIds(row?.[col.name])
  const ref = useAttachmentRefs(ids)
  const single = !col.multiple
  const label = col.type === 'image' ? 'image' : 'file'

  const readIds = () => parseAttachmentIds(platform.tables.rows(table.name, { secure: false }).find((r) => String(r.__id ?? r.id) === rowId)?.[col.name])
  const setCell = (next: string[]) => {
    try {
      platform.tables.update(table.name, rowId, { [col.name]: idsToCell(col, next) }, { secure: false })
    } catch (e) {
      fail(e)
    }
  }

  const upload = async (picked: File[]) => {
    const files = single ? picked.slice(0, 1) : picked
    const oldIds = readIds()
    for (const f of files) {
      const bad = checkAttachment(col, f)
      if (bad) { fail(new Error(bad)); continue }
      setBusy(`Uploading ${f.name}...`)
      try {
        const r = await platform.attachments.upload(table.name, col.name, rowId, f)
        cache.set(r.id, r)
        // the server links the attachment to the row; make sure the local cell agrees
        const cur = readIds()
        if (!cur.includes(r.id)) setCell(single ? [r.id] : [...cur, r.id])
        if (single) {
          for (const old of oldIds) if (old !== r.id) await platform.attachments.remove(old).catch(() => undefined)
          const after = readIds()
          if (after.length !== 1 || after[0] !== r.id) setCell([r.id])
        }
        toast(`Attached ${r.fileName}`, 'success')
      } catch (e) {
        fail(e)
      }
    }
    setBusy('')
  }

  const remove = async (id: string) => {
    setBusy('Removing...')
    try {
      if (!DIRECT.test(id)) await platform.attachments.remove(id)
      cache.delete(id)
      const cur = readIds()
      if (cur.includes(id)) setCell(cur.filter((x) => x !== id))
      toast('Removed', 'success')
    } catch (e) {
      fail(new Error(errMsg(e)))
    } finally {
      setBusy('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-lg" data-testid="attachments-dialog">
        <DialogHeader>
          <DialogTitle>{col.displayName}</DialogTitle>
          <DialogDescription>{canEdit ? `Add or remove ${col.multiple ? `${label}s` : `the ${label}`} for this row.` : 'You can view these files but not change them.'}{col.accept?.length ? ` Accepted: ${col.accept.join(', ')}.` : ''}{col.maxSizeMB ? ` Up to ${col.maxSizeMB} MB each.` : ''}</DialogDescription>
        </DialogHeader>
        {ids.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Nothing attached yet.</p>
        ) : (
          <ul className="grid gap-2" data-testid="attachment-list">
            {ids.map((id) => {
              const r = ref(id)
              const img = isImageRef(col, r, id)
              return (
                <li key={id} className="flex items-center gap-3 rounded-lg border border-border p-2" data-testid={`attachment-${id}`}>
                  {img ? <img src={srcOf(id)} alt={r?.fileName ?? 'Attachment'} className="size-14 shrink-0 rounded-md border border-border object-cover" /> : <span className="grid size-14 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><FileText className="size-6" /></span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r === null ? 'Unavailable' : r?.fileName ?? 'Loading...'}</div>
                    <div className="truncate text-xs text-muted-foreground">{r ? `${r.mime} · ${fmtSize(r.sizeBytes)}` : r === null ? 'You may not have access to this file.' : ''}</div>
                  </div>
                  <Button asChild variant="ghost" size="icon-sm" aria-label={`Open ${r?.fileName ?? 'file'}`}>
                    <a href={srcOf(id)} target="_blank" rel="noopener noreferrer" download={r?.fileName}><Download /></a>
                  </Button>
                  {canEdit && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${r?.fileName ?? 'file'}`} disabled={!!busy} onClick={() => void remove(id)} data-testid={`remove-attachment-${id}`}><Trash2 /></Button>}
                </li>
              )
            })}
          </ul>
        )}
        {canEdit && (
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]) }}
            className={cn('flex items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 text-sm', over ? 'border-primary bg-accent/60' : 'border-border')}
          >
            {busy ? <Spinner /> : <Upload className="size-4 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{busy || (single && ids.length ? `Drop a ${label} to replace it` : `Drop ${col.multiple ? `${label}s` : `a ${label}`} here`)}</span>
            <input ref={inputRef} type="file" multiple={!!col.multiple} accept={col.accept?.length ? col.accept.join(',') : undefined} className="sr-only" aria-label="Choose files to attach" data-testid="attachment-input"
              onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void upload(f) }} />
            <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => inputRef.current?.click()} data-testid="attachment-choose">{single && ids.length ? 'Replace' : 'Choose'}</Button>
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
