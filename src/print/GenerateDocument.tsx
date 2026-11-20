/**
 * The record timeline's "Document" action (P2-B): pick a published print template of the record's table; the PDF is
 * generated on the server with the person's access and stored in the record's Documents (it appears in the timeline).
 */
import { useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PrintTemplateInfo } from '@/platform/print'
import { printApi } from './api'

export function GenerateDocumentButton({ rowId, table, run }: { rowId: string; table?: string; run(fn: () => Promise<unknown>): Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PrintTemplateInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const load = () => {
    setErr('')
    printApi.list(table).then((r) => setItems(r.items.filter((t) => t.status === 'published'))).catch((e: Error) => { setItems([]); setErr(e.message) })
  }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) load() }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8" data-testid="timeline-generate-document"><FileText className="size-3.5" />Document</Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">Generate a PDF into Documents</div>
        {items === null ? <div className="p-2 text-xs text-muted-foreground"><Loader2 className="inline size-3 animate-spin" /> Loading...</div>
          : items.length ? items.map((t) => (
            <button key={t.id} type="button" disabled={busy} data-testid={`generate-document-${t.name}`}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
              onClick={async () => {
                setBusy(true)
                const ok = await run(() => printApi.toDocuments(t.id, rowId))
                setBusy(false)
                if (ok) setOpen(false)
              }}>
              <FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{t.name}</span>
            </button>
          )) : <div className="p-2 text-xs text-muted-foreground">{err || 'No published print template for this table.'}</div>}
      </PopoverContent>
    </Popover>
  )
}
