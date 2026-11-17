import { FileText } from 'lucide-react'
import { attachmentIds, attachmentUrl, formatBytes, looksLikeImage, useAttachmentRefs } from './attachments'

/**
 * A 'file' / 'image' cell: thumbnails for images, a file chip (name, opens in a new tab) for everything else.
 * `value` is an attachment id or a JSON array of ids.
 */
export function AttachmentCell({ value, max = 3, thumb = 28 }: { value: unknown; max?: number; thumb?: number }) {
  const ids = attachmentIds(value)
  const refs = useAttachmentRefs(ids)
  if (ids.length === 0) return null
  const shown = ids.filter((id) => refs[id] !== null).slice(0, max)
  const extra = ids.filter((id) => refs[id] !== null).length - shown.length
  return (
    <span className="inline-flex items-center gap-1 align-middle" data-testid="attachment-cell">
      {shown.map((id) => {
        const ref = refs[id]
        if (ref === null) return null
        const url = ref?.url || attachmentUrl(id)
        const stop = (e: React.MouseEvent) => e.stopPropagation()
        if (ref === undefined)
          return <span key={id} className="inline-block animate-pulse rounded bg-muted" style={{ width: thumb, height: thumb }} aria-label="Loading attachment" />
        if (looksLikeImage(ref))
          return (
            <a key={id} href={url} target="_blank" rel="noopener noreferrer" onClick={stop} title={ref.fileName} data-testid="attachment-thumb">
              <img src={url} alt={ref.fileName} draggable={false} className="rounded border border-border object-cover" style={{ width: thumb, height: thumb }} />
            </a>
          )
        return (
          <a
            key={id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stop}
            title={`${ref.fileName} (${formatBytes(ref.sizeBytes)})`}
            data-testid="attachment-chip"
            className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground hover:bg-accent"
          >
            <FileText className="size-3 shrink-0" />
            <span className="truncate">{ref.fileName}</span>
          </a>
        )
      })}
      {extra > 0 && <span className="text-xs text-muted-foreground">+{extra}</span>}
    </span>
  )
}
