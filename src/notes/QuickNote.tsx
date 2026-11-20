/**
 * Quick note from the shell (P3-N): a button in the header opens a small box (title and text); Save writes a private
 * note and offers to open it on the Notes page. And `NewNoteButton`, for a record's timeline: it opens the Notes page
 * with a new note about that record (`#u-notes?new=1&table=<table>&row=<row>`).
 */
import { addTimelineAction } from '@/controls/display/collab'
import { useState } from 'react'
import { Loader2, StickyNote } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errMsg, useToast } from '@/portal/kit'
import { plainToNote } from './plain'
import { notesApi } from './api'

// the record timeline's composer offers "Note": a note about this record (the timeline's extension point)
addTimelineAction({ id: 'notes.new', label: 'Note', serverOnly: true, run: ({ rowId, table }) => { location.hash = `#u-notes?new=1&row=${encodeURIComponent(rowId)}${table ? `&table=${encodeURIComponent(table)}` : ''}` } })

export function QuickNoteButton() {
  const server = usePlatform((s) => s.mode) === 'server'
  const signedIn = !!usePlatform((s) => s.currentUserId)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  if (!server || !signedIn) return null
  const save = async () => {
    setBusy(true)
    try {
      const id = await notesApi.create({ subject: title.trim() || text.trim().split('\n')[0].slice(0, 80) || 'Quick note', body: plainToNote(text) })
      setSaved(id)
      setTitle('')
      setText('')
    } catch (e) { toast(errMsg(e), 'error') } finally { setBusy(false) }
  }
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Quick note" title="Quick note" onClick={() => { setSaved(null); setOpen(true) }} data-testid="quick-note">
        <StickyNote />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="quick-note-dialog">
          <DialogHeader>
            <DialogTitle>Quick note</DialogTitle>
            <DialogDescription>A private note in Notes. Share it or add formatting there.</DialogDescription>
          </DialogHeader>
          {saved ? (
            <div className="grid gap-3 text-sm" data-testid="quick-note-saved">
              <p>Saved in Notes.</p>
              <DialogFooter>
                <Button variant="ghost" className="h-11 md:h-9" onClick={() => setSaved(null)}>Write another</Button>
                <Button className="h-11 md:h-9" onClick={() => { setOpen(false); location.hash = `#u-notes?n=${encodeURIComponent(saved)}` }} data-testid="quick-note-open">Open the note</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="grid gap-2">
              <Input className="h-11 md:h-9" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" data-testid="quick-note-title" />
              <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write the note" aria-label="Note" autoFocus data-testid="quick-note-text"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (text.trim() || title.trim())) void save() }} />
              <DialogFooter>
                <Button variant="ghost" className="h-11 md:h-9" onClick={() => setOpen(false)}>Cancel</Button>
                <Button className="h-11 md:h-9" disabled={busy || !(text.trim() || title.trim())} onClick={() => void save()} data-testid="quick-note-save">{busy && <Loader2 className="animate-spin" />}Save</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** "New note" on a record's timeline: the Notes page opens with a new note about the record */
export function NewNoteButton({ rowId, table, className }: { rowId: string; table?: string; className?: string }) {
  const server = usePlatform((s) => s.mode) === 'server'
  if (!server) return null
  return (
    <Button size="sm" variant="ghost" className={className ?? 'h-8'} data-testid="timeline-new-note"
      onClick={() => { location.hash = `#u-notes?new=1&row=${encodeURIComponent(rowId)}${table ? `&table=${encodeURIComponent(table)}` : ''}` }}>
      <StickyNote className="size-3.5" />Note
    </Button>
  )
}
