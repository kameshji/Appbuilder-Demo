/**
 * The note editor (P3-N; docs/dev/notes.md): a small rich-text editor over `contenteditable`, used because TipTap did not
 * fit the 300 kB bundle budget (measured: 375-480 kB minified). The browser does the typing (input methods such as
 * Devanagari, the on-screen keyboard, touch selection, undo); this component only adds formatting commands, mentions,
 * record cards, images and paste cleaning. Its content is read back through `readBody` (the NOTE_TAGS sanitiser), and
 * the server sanitises every save again: the editor is not the security boundary.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type Ref } from 'react'
import {
  Bold, Columns3, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Loader2, Pilcrow, Quote, Rows3, Table2, Underline, Waypoints,
} from 'lucide-react'
import { usePlatform } from '@/platform'
import type { PersonOption } from '@/platform/collab-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { buildNodes, readBody, renderInto, type BuildOptions } from './dom'
import { parseNoteHtml, sanitizeNoteHtml, serializeNote } from './sanitize'
import { mentionQuery } from './logic'
import { notesApi } from './api'

export interface NoteEditorHandle {
  /** replaces the content (another version was chosen, or loaded) */
  reset(html: string): void
  focus(): void
}

interface Props {
  html: string
  editable: boolean
  imageUrl(attId: string): string
  recordLabel(ref: string): { text: string; available: boolean } | null
  onChange(html: string): void
  /** uploads an image into the note's Files; resolves with its attachment id, or null */
  onImage(file: File): Promise<string | null>
  /** a person was picked after "@": true when they may be mentioned (they can read the note, or it was shared with them) */
  onMention(p: PersonOption): Promise<boolean>
  onError(message: string): void
  handle?: Ref<NoteEditorHandle>
  testId?: string
}

/** formatting commands of the browser's editing engine (contenteditable); they keep the native undo history */
const exec = (cmd: string, value?: string) => {
  try {
    document.execCommand(cmd, false, value)
  } catch {
    /* not supported here */
  }
}
const SAFE_LINK = /^(https?:\/\/\S+|mailto:\S+|#\S*)$/i

export function NoteEditor({ html, editable, imageUrl, recordLabel, onChange, onImage, onMention, onError, handle, testId = 'note-body' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const opts = useRef<BuildOptions>({ imageUrl, recordLabel, editable })
  opts.current = { imageUrl, recordLabel, editable }
  const savedRange = useRef<Range | null>(null)
  const [mention, setMention] = useState<{ q: string; x: number; y: number; range: Range } | null>(null)
  const [people, setPeople] = useState<PersonOption[]>([])
  const [active, setActive] = useState(0)
  const [linkOpen, setLinkOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [inTable, setInTable] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const emit = useCallback(() => {
    if (ref.current) onChange(readBody(ref.current))
  }, [onChange])

  useImperativeHandle(handle, () => ({
    reset: (h: string) => { if (ref.current) renderInto(ref.current, h, opts.current) },
    focus: () => ref.current?.focus(),
  }))
  // first content (and when the note shown changes: the parent remounts with a key)
  useEffect(() => {
    if (ref.current) renderInto(ref.current, html, opts.current)
    try { document.execCommand('defaultParagraphSeparator', false, 'p') } catch { /* older engines */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // record labels and image URLs arrive after the content: refresh those elements in place
  useEffect(() => {
    const root = ref.current
    if (!root) return
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('span[data-record]'))) {
      const l = recordLabel(el.getAttribute('data-record') ?? '')
      if (!l) continue
      if (el.textContent !== l.text) el.textContent = l.text
      el.className = l.available ? 'note-card' : 'note-card note-card-off'
    }
    for (const el of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-att]'))) {
      const src = imageUrl(el.getAttribute('data-att') ?? '')
      if (src && el.getAttribute('src') !== src) el.setAttribute('src', src)
    }
  }, [recordLabel, imageUrl])

  /* ------------------------------------------------------------ selection helpers */

  const selectionInEditor = (): Range | null => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !ref.current) return null
    const r = sel.getRangeAt(0)
    return ref.current.contains(r.commonAncestorContainer) ? r : null
  }
  const remember = () => { savedRange.current = selectionInEditor()?.cloneRange() ?? savedRange.current }
  /** back to where the caret was before a dialog took the focus (the toolbar keeps the focus: then nothing changes) */
  const restore = () => {
    if (selectionInEditor() && document.activeElement === ref.current) return
    const r = savedRange.current
    ref.current?.focus()
    if (!r) return
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
  }
  const closestIn = (n: Node | null, sel: string): HTMLElement | null => {
    const el = n ? (n.nodeType === 1 ? (n as HTMLElement) : n.parentElement) : null
    const hit = el?.closest(sel) as HTMLElement | null
    return hit && ref.current?.contains(hit) ? hit : null
  }
  /** inserts sanitised HTML at the caret (through the editing engine, so undo works) */
  const insertHtml = (h: string) => {
    restore()
    exec('insertHTML', sanitizeNoteHtml(h))
    emit()
  }
  /** inserts an element built by us (a mention, a card) at a range, followed by a space */
  const insertNode = (node: Node, at: Range | null) => {
    const r = at ?? selectionInEditor()
    if (!r || !ref.current) return
    r.deleteContents()
    const space = document.createTextNode(' ')
    r.insertNode(space)
    r.insertNode(node)
    const sel = window.getSelection()
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(after)
    ref.current.focus()
    emit()
  }

  /* ------------------------------------------------------------ mentions */

  const checkMention = () => {
    const r = selectionInEditor()
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) { setMention(null); return }
    const text = (r.startContainer.nodeValue ?? '').slice(0, r.startOffset)
    const q = mentionQuery(text)
    if (q === null) { setMention(null); return }
    const range = document.createRange()
    range.setStart(r.startContainer, r.startOffset - q.length - 1)
    range.setEnd(r.startContainer, r.startOffset)
    const rect = range.getBoundingClientRect()
    const box = ref.current!.getBoundingClientRect()
    setMention({ q, x: Math.max(0, Math.min(rect.left - box.left, box.width - 260)), y: rect.bottom - box.top + 4, range })
  }
  useEffect(() => {
    if (!mention) return
    let live = true
    const t = setTimeout(() => notesApi.people(mention.q).then((p) => { if (live) { setPeople(p.slice(0, 8)); setActive(0) } }).catch(() => live && setPeople([])), 120)
    return () => { live = false; clearTimeout(t) }
  }, [mention?.q]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (p: PersonOption) => {
    const at = mention?.range ?? null
    setMention(null)
    if (!(await onMention(p))) return
    const span = buildNodes(parseNoteHtml(`<span data-mention="${p.id}">@${p.name.replace(/[<>&"]/g, '')}</span>`), document, opts.current)[0]
    if (span) insertNode(span, at)
  }

  /* ------------------------------------------------------------ commands */

  const block = (tag: string) => { restore(); exec('formatBlock', `<${tag}>`); emit() }
  const checklist = () => {
    restore()
    const r = selectionInEditor()
    const inList = closestIn(r?.startContainer ?? null, 'ul')
    if (inList?.getAttribute('data-type') === 'checklist') {
      inList.removeAttribute('data-type')
      for (const li of Array.from(inList.children)) li.removeAttribute('data-checked')
      emit()
      return
    }
    if (inList) {
      inList.setAttribute('data-type', 'checklist')
      for (const li of Array.from(inList.children)) if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false')
      emit()
      return
    }
    // a paragraph (or a heading) becomes a checklist of its own: built here, because the browser's list command would
    // merge it into a list right above it
    const root = ref.current
    if (!root || !r) return
    let blockEl = closestIn(r.startContainer, 'p,h1,h2,h3,blockquote,pre,div')
    if (blockEl === root) blockEl = null
    const ul = document.createElement('ul')
    ul.setAttribute('data-type', 'checklist')
    const li = document.createElement('li')
    li.setAttribute('data-checked', 'false')
    ul.appendChild(li)
    if (blockEl) {
      while (blockEl.firstChild) li.appendChild(blockEl.firstChild)
      blockEl.replaceWith(ul)
    } else {
      r.insertNode(ul)
    }
    if (!li.firstChild) li.appendChild(document.createElement('br'))
    const caret = document.createRange()
    caret.selectNodeContents(li)
    caret.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(caret)
    emit()
  }
  /** a new checklist item (Enter) starts unticked */
  const untickNewItem = () => setTimeout(() => {
    const li = closestIn(selectionInEditor()?.startContainer ?? null, 'li')
    if (li?.parentElement?.getAttribute('data-type') === 'checklist' && !(li.textContent ?? '').trim()) li.setAttribute('data-checked', 'false')
  }, 0)
  const table = () => insertHtml('<table><tbody><tr><th><br></th><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>')
  const addRow = () => {
    restore()
    const tr = closestIn(selectionInEditor()?.startContainer ?? null, 'tr')
    if (!tr) return
    const row = document.createElement('tr')
    for (let i = 0; i < tr.children.length; i++) { const td = document.createElement('td'); td.appendChild(document.createElement('br')); row.appendChild(td) }
    tr.after(row)
    emit()
  }
  const addColumn = () => {
    restore()
    const tbl = closestIn(selectionInEditor()?.startContainer ?? null, 'table')
    if (!tbl) return
    for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
      const cell = document.createElement(tr.querySelector('th') && !tr.querySelector('td') ? 'th' : 'td')
      cell.appendChild(document.createElement('br'))
      tr.appendChild(cell)
    }
    emit()
  }
  const image = async (file: File) => {
    if (!/^image\//.test(file.type)) { onError(`${file.name} is not an image.`); return }
    setBusy(true)
    try {
      const id = await onImage(file)
      if (id) insertHtml(`<img data-att="${id}">`)
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------------------------------------ events */

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!editable) return
    const files = Array.from(e.clipboardData.files ?? []).filter((f) => /^image\//.test(f.type))
    if (files.length) {
      e.preventDefault()
      remember()
      for (const f of files.slice(0, 5)) void image(f)
      return
    }
    const h = e.clipboardData.getData('text/html')
    const t = e.clipboardData.getData('text/plain')
    e.preventDefault()
    // pasted HTML goes through the same allow-list as everything else (and the server cleans it again)
    if (h) exec('insertHTML', sanitizeNoteHtml(h))
    else if (t) exec('insertText', t)
    emit()
  }
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const li = (e.target as HTMLElement).closest('li')
    if (!li || !editable || li.parentElement?.getAttribute('data-type') !== 'checklist') return
    const box = li.getBoundingClientRect()
    if (e.clientX - box.left > 30) return
    e.preventDefault()
    li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true')
    emit()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mention && people.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % people.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + people.length) % people.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); void pick(people[active]); return }
    }
    if (e.key === 'Escape') setMention(null)
    if (e.key === 'Enter') untickNewItem()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); remember(); setLinkOpen(true) }
  }
  const onSelect = () => {
    remember()
    setInTable(!!closestIn(selectionInEditor()?.startContainer ?? null, 'td,th'))
  }

  const tool = (label: string, Icon: typeof Bold, run: () => void, id: string) => (
    <Button key={id} type="button" variant="ghost" size="icon-sm" className="size-11 shrink-0 md:size-8" title={label} aria-label={label} data-testid={`note-tool-${id}`}
      onMouseDown={(e) => e.preventDefault()} onClick={run} disabled={!editable}>
      <Icon />
    </Button>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {editable && (
        <div className="note-noprint flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1 py-1" role="toolbar" aria-label="Formatting" data-testid="note-toolbar">
          {tool('Bold (Ctrl+B)', Bold, () => { restore(); exec('bold'); emit() }, 'bold')}
          {tool('Italic (Ctrl+I)', Italic, () => { restore(); exec('italic'); emit() }, 'italic')}
          {tool('Underline (Ctrl+U)', Underline, () => { restore(); exec('underline'); emit() }, 'underline')}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          {tool('Heading 1', Heading1, () => block('h1'), 'h1')}
          {tool('Heading 2', Heading2, () => block('h2'), 'h2')}
          {tool('Heading 3', Heading3, () => block('h3'), 'h3')}
          {tool('Paragraph', Pilcrow, () => block('p'), 'p')}
          {tool('Quote', Quote, () => block('blockquote'), 'quote')}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          {tool('Bulleted list', List, () => { restore(); exec('insertUnorderedList'); emit() }, 'ul')}
          {tool('Numbered list', ListOrdered, () => { restore(); exec('insertOrderedList'); emit() }, 'ol')}
          {tool('Checklist', ListChecks, checklist, 'checklist')}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          {tool('Link (Ctrl+K)', Link2, () => { remember(); setLinkOpen(true) }, 'link')}
          {tool('Link a record', Waypoints, () => { remember(); setRecordOpen(true) }, 'record')}
          {tool('Table', Table2, table, 'table')}
          {inTable && tool('Add a row', Rows3, addRow, 'row')}
          {inTable && tool('Add a column', Columns3, addColumn, 'column')}
          {tool('Image', ImagePlus, () => { remember(); fileRef.current?.click() }, 'image')}
          {busy && <Loader2 className="ml-1 size-4 shrink-0 animate-spin text-muted-foreground" />}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="note-image-input" onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void image(f)
          }} />
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: 'calc(var(--kb, 0px) + 16px)' }}>
        <div
          ref={ref}
          className={cn('note-body min-h-40 px-3 py-2 md:px-4', editable && 'cursor-text')}
          contentEditable={editable}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Note"
          data-placeholder={editable ? 'Write here. Type @ to mention someone.' : ''}
          spellCheck
          data-testid={testId}
          onInput={() => { emit(); checkMention() }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) checkMention() }}
          onMouseUp={onSelect}
          onSelect={onSelect}
          onBlur={() => setTimeout(() => setMention(null), 200)}
          onPaste={onPaste}
          onClick={onClick}
          onDrop={(e) => { if (editable) { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void image(f) } }}
        />
        {mention && (
          <div className="absolute z-30 w-64 rounded-md border bg-popover p-1 shadow-md" style={{ left: mention.x + 12, top: mention.y + 8 }} data-testid="note-mention-list">
            {people.length === 0 ? <div className="p-2 text-xs text-muted-foreground">No one found.</div> : people.map((p, i) => (
              <button key={p.id} type="button" className={cn('flex min-h-11 w-full items-center gap-2 rounded px-2 text-left text-sm md:min-h-8', i === active ? 'bg-accent' : 'hover:bg-accent')}
                onMouseDown={(e) => { e.preventDefault(); void pick(p) }} data-testid={`note-mention-${p.id}`}>
                <span className="truncate">{p.name}</span><span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <LinkDialog open={linkOpen} onOpenChange={setLinkOpen} onLink={(url) => {
        restore()
        const r = selectionInEditor()
        if (r && !r.collapsed) exec('createLink', url)
        else exec('insertHTML', serializeNote([{ t: 'el', tag: 'a', attrs: { href: url }, kids: [{ t: 'text', v: url }] }]))
        emit()
      }} />
      <RecordPicker open={recordOpen} onOpenChange={setRecordOpen} onPick={(table, row, label) => {
        restore()
        const span = buildNodes(parseNoteHtml(`<span data-record="${table}:${row}"></span>`), document, { ...opts.current, recordLabel: () => ({ text: label, available: true }) })[0]
        if (span) insertNode(span, selectionInEditor())
      }} />
    </div>
  )
}

function LinkDialog({ open, onOpenChange, onLink }: { open: boolean; onOpenChange(o: boolean): void; onLink(url: string): void }) {
  const [url, setUrl] = useState('https://')
  useEffect(() => { if (open) setUrl('https://') }, [open])
  const ok = SAFE_LINK.test(url.trim()) && url.trim() !== 'https://'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add a link</DialogTitle></DialogHeader>
        <Input className="h-11 md:h-9" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus aria-label="Address" data-testid="note-link-url"
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) { onOpenChange(false); onLink(url.trim()) } }} />
        <p className="text-xs text-muted-foreground">Web (https://), email (mailto:) or in-app (#) addresses.</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ok} onClick={() => { onOpenChange(false); onLink(url.trim()) }} data-testid="note-link-add">Add link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** pick a record of a table the person can read; the note stores only the reference (the label is resolved per reader) */
export function RecordPicker({ open, onOpenChange, onPick, title = 'Link a record' }: { open: boolean; onOpenChange(o: boolean): void; onPick(table: string, row: string, label: string): void; title?: string }) {
  const tables = usePlatform((s) => s.tables)
  const choices = tables.filter((t) => !t.system).sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name))
  const [table, setTable] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<{ id: string; label: string }[] | null>(null)
  const def = choices.find((t) => t.id === table)
  useEffect(() => { if (open && !table && choices[0]) setTable(choices[0].id) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !def) return
    let live = true
    setRows(null)
    const t = setTimeout(() => notesApi.records(def.id, def.primaryColumn, q).then((r) => live && setRows(r)).catch(() => live && setRows([])), 150)
    return () => { live = false; clearTimeout(t) }
  }, [open, def?.id, q]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="note-record-picker">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {choices.length === 0 ? <p className="text-sm text-muted-foreground">There are no tables you can read.</p> : (
          <div className="grid gap-2">
            <select className="h-11 rounded-md border bg-background px-2 text-sm md:h-9" value={table} onChange={(e) => setTable(e.target.value)} aria-label="Table" data-testid="note-record-table">
              {choices.map((t) => <option key={t.id} value={t.id}>{t.displayName || t.name}</option>)}
            </select>
            <Input className="h-11 md:h-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search records" data-testid="note-record-search" />
            <div className="max-h-64 overflow-y-auto rounded-md border">
              {rows === null ? <div className="flex justify-center p-3"><Loader2 className="size-4 animate-spin" /></div>
                : rows.length === 0 ? <div className="p-3 text-sm text-muted-foreground">No records found.</div>
                  : rows.map((r) => (
                    <button key={r.id} type="button" className="block min-h-11 w-full truncate px-3 text-left text-sm hover:bg-accent md:min-h-9" data-testid="note-record-row"
                      onClick={() => { onOpenChange(false); onPick(table, r.id, `${def?.displayName || def?.name}: ${r.label}`) }}>{r.label}</button>
                  ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
