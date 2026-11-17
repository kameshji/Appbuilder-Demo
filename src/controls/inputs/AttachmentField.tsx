import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Paperclip, Upload, X } from 'lucide-react'
import type { ColumnDef } from '@/platform/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  attachmentIds, attachmentUrl, fileProblem, formatAttachmentCell, formatBytes, looksLikeImage, useAttachmentRefs,
} from '@/runtime/attachments'

/** accepted MIME patterns of the column; image columns default to images only */
export function acceptList(col: ColumnDef): string[] {
  if (col.accept && col.accept.length) return col.accept
  return col.type === 'image' ? ['image/*'] : []
}

function Thumb({ file }: { file: File }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : ''), [file])
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url])
  return url ? (
    <img src={url} alt="" className="size-8 shrink-0 rounded border border-border object-cover" />
  ) : (
    <FileText className="size-4 shrink-0 text-muted-foreground" />
  )
}

interface Props {
  col: ColumnDef
  id: string
  /** the cell text: attachment id, JSON array of ids, or '' */
  existing: string
  pending: File[]
  invalid: boolean
  onExistingChange(cell: string): void
  onPendingChange(files: File[]): void
  onTouch(): void
}

/** Form field for a 'file' / 'image' column: existing attachments (removable) plus files waiting to be uploaded on save. */
export function AttachmentField({ col, id, existing, pending, invalid, onExistingChange, onPendingChange, onTouch }: Props) {
  const multiple = !!col.multiple
  const ids = attachmentIds(existing)
  const refs = useAttachmentRefs(ids)
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState('')
  const accept = acceptList(col)

  const take = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const bad: string[] = []
    const ok: File[] = []
    for (const f of Array.from(list)) {
      const p = fileProblem(f, { accept, maxSizeMB: col.maxSizeMB })
      if (p) bad.push(p)
      else ok.push(f)
    }
    setProblem(bad.join('; '))
    if (ok.length) onPendingChange(multiple ? [...pending, ...ok] : ok.slice(0, 1))
    onTouch()
  }

  const full = !multiple && (pending.length > 0 || ids.length > 0)
  return (
    <div className={cn('space-y-1.5 rounded-md border border-dashed border-input p-2', invalid && 'border-destructive')} data-testid={`attachment-field-${col.name}`}>
      {ids.map((aid) => {
        const ref = refs[aid]
        if (ref === null) return null
        const name = ref?.fileName ?? 'Loading...'
        return (
          <div key={aid} className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs" data-testid="attachment-existing">
            {ref && looksLikeImage(ref) ? (
              <img src={ref.url || attachmentUrl(aid)} alt="" className="size-8 shrink-0 rounded border border-border object-cover" />
            ) : (
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <a href={ref?.url || attachmentUrl(aid)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:underline">
              {name}
            </a>
            {ref && <span className="shrink-0 text-muted-foreground">{formatBytes(ref.sizeBytes)}</span>}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5"
              aria-label={`Remove ${name}`}
              onClick={() => {
                onExistingChange(formatAttachmentCell(ids.filter((x) => x !== aid), multiple))
                onTouch()
              }}
            >
              <X className="size-3" />
            </Button>
          </div>
        )
      })}
      {pending.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md bg-primary/5 px-2 py-1 text-xs" data-testid="attachment-pending">
          <Thumb file={f} />
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)} - uploads on save</span>
          <Button type="button" variant="ghost" size="icon-sm" className="size-5" aria-label={`Remove ${f.name}`} onClick={() => onPendingChange(pending.filter((_, k) => k !== i))}>
            <X className="size-3" />
          </Button>
        </div>
      ))}
      <input
        ref={input}
        id={id}
        type="file"
        hidden
        multiple={multiple}
        accept={accept.length ? accept.join(',') : undefined}
        data-testid={`attachment-input-${col.name}`}
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
      <Button type="button" variant="outline" size="xs" onClick={() => input.current?.click()}>
        <Upload /> {full ? 'Replace' : multiple ? 'Add files' : col.type === 'image' ? 'Choose image' : 'Choose file'}
      </Button>
      {col.maxSizeMB ? <span className="ml-2 text-[11px] text-muted-foreground">max {col.maxSizeMB} MB</span> : null}
      {problem !== '' && (
        <p className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
