/**
 * Notes (P3 package N; docs/dev/notes.md, docs/help/notes.md): User mode page `#u-notes`. A list (search, Recent,
 * Pinned, Shared with me, About records, Mine) and the open note: title, rich text with autosave, mentions, record cards,
 * images and files, sharing with people and teams, pin, print. `#u-notes?n=<id>` opens a note (notification links);
 * `#u-notes?new=1&table=<table>&row=<row>` starts a note about a record (the record timeline's "New note").
 * Online only: notes are not kept on the device (offline, the page says so and the note cannot be changed).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Download, FileText, Loader2, Paperclip, Pin, PinOff, Plus, Printer, Search, Share2, StickyNote, Trash2, UsersRound, WifiOff, X,
} from 'lucide-react'
import { platform, usePlatform, type AttachmentRef } from '@/platform'
import type { PersonOption } from '@/platform/collab-api'
import type { ChatCardView } from '@/platform/chat-protocol'
import { attachmentIds, formatBytes, isImageMime } from '@/runtime/attachments'
import { useConnectivity, onBackOnline } from '@/phone/connectivity'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ConfirmDialog, Empty, PageHeader, errMsg, fmtRelative, useToast } from '@/portal/kit'
import { NoteEditor, RecordPicker, type NoteEditorHandle } from './NoteEditor'
import { notesApi, type NoteDetail, type NoteShare, type NoteSummary, type NotesView } from './api'
import { NoteConflict, createAutosave, type Autosave, type AutosaveSnapshot, type NoteDraft } from './autosave'
import { mergeNotes } from './merge'
import { diffShares, highlight, isEmptyDiff, type WantedShare } from './logic'
import { renderInto } from './dom'
import { noteRecordRefs } from './sanitize'
import './notes.css'

const VIEWS: { value: NotesView; label: string }[] = [
  { value: 'all', label: 'Recent' }, { value: 'pinned', label: 'Pinned' }, { value: 'shared', label: 'Shared with me' }, { value: 'records', label: 'About records' }, { value: 'mine', label: 'Mine' },
]

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/** the query of the hash (#u-notes?n=...) */
function hashQuery(): URLSearchParams {
  const h = location.hash
  const i = h.indexOf('?')
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : '')
}
const setHash = (q: string) => {
  try { history.replaceState(null, '', `${location.pathname}${location.search}#u-notes${q ? `?${q}` : ''}`) } catch { /* sandboxed */ }
}

function Marked({ text, q }: { text: string; q: string }) {
  return <>{highlight(text, q).map((s, i) => (s.hit ? <mark key={i} className="note-hit">{s.text}</mark> : <span key={i}>{s.text}</span>))}</>
}

export function NotesPage() {
  const server = usePlatform((s) => s.mode) === 'server'
  if (!server) {
    return (
      <div className="mx-auto max-w-3xl p-6" data-testid="notes-page">
        <PageHeader icon={StickyNote} title="Notes" subtitle="Rich-text notes, private or shared." />
        <Empty icon={StickyNote} title="Notes need the server" description="Notes are kept in the database with their sharing. Run the local server (PostgreSQL) to use them; demo mode has no notes." />
      </div>
    )
  }
  return <NotesServer />
}

function NotesServer() {
  const { toast } = useToast()
  const me = usePlatform((s) => s.currentUserId)
  const phone = useMedia('(max-width: 767px)')
  const online = useConnectivity((s) => s.status) === 'online'
  const [view, setView] = useState<NotesView>('all')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [items, setItems] = useState<NoteSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(() => hashQuery().get('n'))
  const [creating, setCreating] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const load = useCallback(() => {
    notesApi.list(view, debounced).then(setItems).catch((e) => { setItems((x) => x ?? []); if (online) toast(errMsg(e), 'error') })
  }, [view, debounced, toast, online])
  useEffect(() => load(), [load])
  useEffect(() => {
    const offs = ['table:sys_activities', 'table:sys_activity_shares'].map((t) => platform.live.subscribe(t, () => load()))
    return () => offs.forEach((o) => o())
  }, [load])

  const create = useCallback(async (about?: { table: string; row: string; label?: string }) => {
    setCreating(true)
    try {
      const id = await notesApi.create({ subject: about?.label ? `Note about ${about.label}`.slice(0, 200) : 'Untitled note', regardingTable: about?.table ?? null, regardingId: about?.row ?? null })
      setOpenId(id)
      setHash(`n=${encodeURIComponent(id)}`)
      load()
    } catch (e) { toast(errMsg(e), 'error') } finally { setCreating(false) }
  }, [load, toast])

  // notification links and the record timeline's "New note" arrive as the hash
  useEffect(() => {
    const read = () => {
      const p = hashQuery()
      if (p.get('new') === '1' && p.get('row')) {
        setHash('')
        void create({ table: p.get('table') ?? '', row: p.get('row') ?? '' })
      } else if (p.get('n')) setOpenId(p.get('n'))
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [create])

  const open = (id: string | null) => {
    setOpenId(id)
    setHash(id ? `n=${encodeURIComponent(id)}` : '')
  }

  const groups = useMemo(() => {
    const list = items ?? []
    if (view !== 'records') return [{ key: '', title: '', list }]
    const by = new Map<string, NoteSummary[]>()
    for (const n of list) {
      const k = n.regarding ? (n.regarding.label ? `${n.regarding.tableName}: ${n.regarding.label}` : 'A record you cannot open') : 'No record'
      ;(by.get(k) ?? by.set(k, []).get(k)!).push(n)
    }
    return [...by.entries()].map(([title, l]) => ({ key: title, title, list: l }))
  }, [items, view])

  const listPane = (
    <div className={cn('flex min-h-0 flex-col gap-2', phone ? 'flex-1' : 'w-80 shrink-0 border-r pr-3')} data-testid="notes-list-pane">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="h-11 pl-8 md:h-9" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" data-testid="notes-search" />
        </div>
        <Button className="h-11 shrink-0 md:h-9" disabled={creating || !online} onClick={() => void create()} data-testid="notes-new">{creating ? <Loader2 className="animate-spin" /> : <Plus />}New</Button>
      </div>
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Which notes" data-testid="notes-views">
        {VIEWS.map((v) => (
          <button key={v.value} type="button" role="radio" aria-checked={view === v.value} onClick={() => setView(v.value)} data-testid={`notes-view-${v.value}`}
            className={cn('h-11 shrink-0 rounded-md px-3 text-xs font-medium md:h-7', view === v.value ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted')}>{v.label}</button>
        ))}
      </div>
      <button type="button" className="text-left text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50" disabled={!online} onClick={() => setAboutOpen(true)} data-testid="notes-new-about">New note about a record...</button>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notes-list">
        {items === null ? <div className="flex justify-center p-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          : items.length === 0 ? <Empty icon={StickyNote} title={debounced ? 'No notes match' : 'No notes here'} description={debounced ? 'Try other words. Search looks at the titles and the text of the notes you can open.' : view === 'shared' ? 'Notes that someone shares with you or your teams show up here.' : 'Write a note with New. Notes are private until you share them.'} className="mt-2" />
            : groups.map((g) => (
              <div key={g.key}>
                {g.title && <div className="mt-2 px-1 text-xs font-semibold text-muted-foreground">{g.title}</div>}
                {g.list.map((n) => (
                  <button key={n.id} type="button" onClick={() => open(n.id)} data-testid="note-row" data-note-id={n.id}
                    className={cn('mt-1 block min-h-11 w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/50', openId === n.id && 'bg-accent')}>
                    <div className="flex items-center gap-1.5">
                      {n.pinned && <Pin className="size-3 shrink-0 text-primary" aria-label="Pinned" />}
                      <span className="truncate text-sm font-medium"><Marked text={n.title || 'Untitled note'} q={debounced} /></span>
                    </div>
                    {n.snippet && <div className="line-clamp-2 text-xs text-muted-foreground"><Marked text={n.snippet} q={debounced} /></div>}
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                      <span>edited {n.modifiedOn ? fmtRelative(n.modifiedOn) : ''}</span>
                      {!n.mine && n.ownerName && <span>by {n.ownerName}</span>}
                      {n.sharedWithMe && <span>shared ({n.sharedWithMe === 'edit' ? 'can edit' : 'can read'})</span>}
                      {n.regarding?.label && view !== 'records' && <span className="truncate">{n.regarding.tableName}: {n.regarding.label}</span>}
                      {n.files > 0 && <span className="inline-flex items-center gap-0.5"><Paperclip className="size-3" />{n.files}</span>}
                    </div>
                  </button>
                ))}
              </div>
            ))}
      </div>
    </div>
  )

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-3 overflow-hidden p-3 sm:p-6" data-testid="notes-page">
      {!(phone && openId) && <PageHeader icon={StickyNote} title="Notes" subtitle="Rich-text notes, private until you share them. Notes belong to this environment." />}
      {!online && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="notes-offline">
          <WifiOff className="size-4 shrink-0" />Notes need a connection. You are offline: notes cannot be opened or changed until the connection is back. Nothing you typed before is lost while the note stays open.
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-4">
        {(!phone || !openId) && listPane}
        {openId ? (
          <NotePanel key={openId} id={openId} me={me} phone={phone} online={online} onBack={() => open(null)} onChanged={load} onDeleted={() => { open(null); load() }} />
        ) : !phone && (
          <div className="hidden flex-1 md:block"><Empty icon={StickyNote} title="No note open" description="Choose a note on the left, or write a new one." className="h-full" /></div>
        )}
      </div>
      <RecordPicker open={aboutOpen} onOpenChange={setAboutOpen} title="New note about a record" onPick={(table, row, label) => void create({ table, row, label })} />
    </div>
  )
}

/* ------------------------------------------------------------------ one note */

function NotePanel({ id, me, phone, online, onBack, onChanged, onDeleted }: { id: string; me: string | null; phone: boolean; online: boolean; onBack(): void; onChanged(): void; onDeleted(): void }) {
  const { toast } = useToast()
  const [d, setD] = useState<NoteDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [subject, setSubject] = useState('')
  /** the body as the editor holds it now (the conflict dialog shows it; the editor starts from it after a choice) */
  const [body, setBody] = useState('')
  const [snap, setSnap] = useState<AutosaveSnapshot | null>(null)
  const [cards, setCards] = useState<Record<string, ChatCardView> | null>(null)
  const cardsRef = useRef<Record<string, ChatCardView> | null>(null)
  const [files, setFiles] = useState<AttachmentRef[]>([])
  const [shareOpen, setShareOpen] = useState(false)
  const [askShare, setAskShare] = useState<{ p: PersonOption; done(ok: boolean): void } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const auto = useRef<Autosave | null>(null)
  const editor = useRef<NoteEditorHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const fileIds = useMemo(() => attachmentIds(d?.note.Files ?? null), [d?.note.Files])
  const refreshFiles = useCallback(async (ids: string[]) => setFiles(await notesApi.resolveFiles(ids).catch(() => [])), [])

  useEffect(() => {
    let live = true
    notesApi.get(id).then((x) => {
      if (!live) return
      setD(x)
      setSubject(x.note.Subject)
      setBody(x.note.Body)
      const a = createAutosave({ subject: x.note.Subject, body: x.note.Body }, x.version, {
        delayMs: 1000, maxWaitMs: 5000,
        save: async (draft, v) => {
          try {
            return await notesApi.save(id, draft, v)
          } catch (e) {
            // only the version moved (an image or a file was added here): save again on the new version
            const base = auto.current?.snapshot().saved
            if (e instanceof NoteConflict && base && e.current.body === base.body && e.current.subject === base.subject) return notesApi.save(id, draft, e.current.version)
            throw e
          }
        },
        setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now(),
        onChange: (s) => {
          setSnap(s)
          if (s.state !== 'saved') return
          onChanged()
          // a record card added here: resolve it for this reader (the editor keeps the label it was inserted with meanwhile)
          if (noteRecordRefs(s.saved.body).some((r) => !cardsRef.current?.[r])) notesApi.cards(id).then((c) => { cardsRef.current = c; setCards(c) }).catch(() => undefined)
        },
      })
      auto.current = a
      setSnap(a.snapshot())
      notesApi.cards(id).then((c) => { if (live) { cardsRef.current = c; setCards(c) } }).catch(() => live && setCards({}))
      void refreshFiles(attachmentIds(x.note.Files))
    }).catch(() => { if (live) setMissing(true) })
    return () => {
      live = false
      void auto.current?.flush().finally(() => auto.current?.stop())
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // leaving the page with unsaved edits: save now and let the browser ask
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!auto.current?.dirty()) return
      void auto.current.flush()
      e.preventDefault()
    }
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [])
  useEffect(() => onBackOnline(() => auto.current?.retry()), [])

  // saved elsewhere (another tab, someone with edit access): a clean tab takes it; a tab with edits learns on its next save
  const reloadFromServer = useCallback(async () => {
    const a = auto.current
    if (!a) return
    try {
      const x = await notesApi.get(id)
      setD(x)
      if (x.version !== a.snapshot().version && a.adopt({ subject: x.note.Subject, body: x.note.Body, version: x.version })) {
        setSubject(x.note.Subject)
        setBody(x.note.Body)
        editor.current?.reset(x.note.Body)
        notesApi.cards(id).then((c) => { cardsRef.current = c; setCards(c) }).catch(() => undefined)
      }
      void refreshFiles(attachmentIds(x.note.Files))
    } catch {
      setMissing(true)
    }
  }, [id, refreshFiles])
  useEffect(() => platform.live.subscribe('table:sys_activities', () => void reloadFromServer()), [reloadFromServer])

  /** the card's text for this reader; null while it is not resolved (the editor keeps what it shows) */
  const recordLabel = useCallback((ref: string): { text: string; available: boolean } | null => {
    const c = cards?.[ref]
    if (!c) return null
    if (c.available && c.kind === 'record') return { text: `${c.tableName}: ${c.title ?? '(no name)'}`, available: true }
    return { text: 'Record not available', available: false }
  }, [cards])
  const imageUrl = useCallback((att: string) => (fileIds.includes(att) ? notesApi.fileUrl(att) : ''), [fileIds])

  const upload = async (file: File): Promise<string | null> => {
    try {
      await auto.current?.flush()
      const ref = await notesApi.upload(id, file)
      const x = await notesApi.get(id)
      setD(x)
      // the file changed the note's version: take it when the text there is what this tab last saved
      if (!auto.current?.rebase({ subject: x.note.Subject, body: x.note.Body, version: x.version })) toast('Someone changed this note meanwhile: choose which version to keep.', 'info')
      void refreshFiles(attachmentIds(x.note.Files))
      return ref.id
    } catch (e) {
      toast(errMsg(e), 'error')
      return null
    }
  }

  const onMention = async (p: PersonOption): Promise<boolean> => {
    if (p.id === me) return true
    try {
      const r = await notesApi.readers(id, [p.id])
      if (r.readers.includes(p.id)) return true
      if (!d?.isOwner) {
        toast(`${p.name} cannot open this note. Ask its owner to share it with them first.`, 'info')
        return false
      }
      const ok = await new Promise<boolean>((done) => setAskShare({ p, done }))
      if (!ok) return false
      await notesApi.addShare(id, { PrincipalType: 'user', Principal: p.id, Access: 'read' })
      setD(await notesApi.get(id))
      return true
    } catch (e) {
      toast(errMsg(e), 'error')
      return false
    }
  }

  if (missing) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-3" data-testid="note-missing">
        {phone && <Button variant="ghost" className="h-11 w-fit" onClick={onBack}><ArrowLeft />Notes</Button>}
        <Empty icon={StickyNote} title="Note not found" description="It was deleted, or it is not shared with you." />
      </div>
    )
  }
  if (!d || !snap) return <div className="flex flex-1 justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>

  const editable = d.canEdit && online && snap.state !== 'conflict'
  const status = !online ? 'Offline: not saved' : snap.state === 'saving' ? 'Saving...' : snap.state === 'dirty' ? 'Unsaved changes' : snap.state === 'error' ? `Not saved: ${snap.error}` : snap.state === 'conflict' ? 'Changed elsewhere' : 'Saved'
  const others = files.filter((f) => !isImageMime(f.mime))
  const images = files.filter((f) => isImageMime(f.mime))

  return (
    <section className="note-print flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card" data-testid="note-panel" data-note-id={id}>
      <div className="note-noprint flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        {phone && <Button variant="ghost" size="icon-sm" className="size-11" onClick={() => { void auto.current?.flush(); onBack() }} aria-label="Back to the notes" data-testid="note-back"><ArrowLeft /></Button>}
        <span className={cn('mr-auto truncate text-xs', snap.state === 'error' || snap.state === 'conflict' ? 'text-destructive' : 'text-muted-foreground')} data-testid="note-status" data-state={snap.state}>
          {status}{snap.state === 'error' && <button type="button" className="ml-2 underline" onClick={() => auto.current?.retry()}>Try again</button>}
        </span>
        <Button variant="ghost" size="icon-sm" className="size-11 md:size-8" aria-label={d.pinned ? 'Unpin' : 'Pin'} title={d.pinned ? 'Unpin' : 'Pin to the top of your notes'} data-testid="note-pin"
          onClick={() => notesApi.pin(id, !d.pinned).then((r) => { setD({ ...d, pinned: r.pinned }); onChanged() }).catch((e) => toast(errMsg(e), 'error'))}>{d.pinned ? <PinOff /> : <Pin />}</Button>
        {d.isOwner && <Button variant="ghost" size="sm" className="h-11 md:h-8" onClick={() => setShareOpen(true)} data-testid="note-share"><Share2 />Share{d.shares.length ? ` (${d.shares.length})` : ''}</Button>}
        <Button variant="ghost" size="icon-sm" className="size-11 md:size-8" aria-label="Print or save as PDF" title="Print or save as PDF" onClick={() => window.print()} data-testid="note-print"><Printer /></Button>
        {d.isOwner && <Button variant="ghost" size="icon-sm" className="size-11 md:size-8" aria-label="Delete the note" title="Delete" onClick={() => setConfirmDelete(true)} data-testid="note-delete"><Trash2 /></Button>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <input className="note-title shrink-0 bg-transparent px-3 pt-3 text-xl font-semibold outline-none md:px-4" value={subject} readOnly={!editable} aria-label="Title" placeholder="Title" maxLength={250} data-testid="note-title"
          onChange={(e) => { setSubject(e.target.value); auto.current?.change({ subject: e.target.value }) }} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-1 text-xs text-muted-foreground md:px-4">
          <span>{d.note.owner === me ? 'Your note' : `${d.ownerName ?? 'Someone'}'s note`}{!d.canEdit ? ' (you can read it)' : ''}</span>
          {d.regarding && <span data-testid="note-about">About {d.regarding.label ? `${d.regarding.tableName}: ${d.regarding.label}` : 'a record you cannot open'}</span>}
          {d.shares.length > 0 && <span className="inline-flex items-center gap-1"><UsersRound className="size-3" />shared with {d.shares.map((s) => s.name ?? 'someone').join(', ')}</span>}
        </div>
        <NoteEditor key={`${id}:${epoch}`} handle={editor} html={body} editable={editable} imageUrl={imageUrl} recordLabel={recordLabel}
          onChange={(h) => { setBody(h); auto.current?.change({ body: h }) }} onImage={upload} onMention={onMention} onError={(m) => toast(m, 'error')} />
        {(others.length > 0 || images.length > 0 || d.canEdit) && (
          <div className="note-noprint shrink-0 border-t px-3 py-2 text-xs md:px-4" data-testid="note-files">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-muted-foreground">Files</span>
              {others.map((f) => (
                <a key={f.id} href={notesApi.fileUrl(f.id)} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 rounded border px-2 hover:bg-accent" data-testid="note-file">
                  <FileText className="size-3.5" />{f.fileName}<span className="text-muted-foreground">{formatBytes(f.sizeBytes)}</span><Download className="size-3" />
                </a>
              ))}
              {images.length > 0 && <span className="text-muted-foreground">{images.length} image{images.length === 1 ? '' : 's'} in the text</span>}
              {d.canEdit && online && <Button variant="outline" size="sm" className="h-11 md:h-7" onClick={() => fileRef.current?.click()} data-testid="note-attach"><Paperclip />Attach a file</Button>}
              <input ref={fileRef} type="file" className="hidden" data-testid="note-file-input" onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void upload(f).then((att) => { if (att) toast(`${f.name} attached.`, 'success') })
              }} />
            </div>
          </div>
        )}
      </div>

      {snap.state === 'conflict' && snap.conflict && (
        <ConflictDialog base={snap.saved} mine={{ subject, body }} theirs={snap.conflict} imageUrl={imageUrl} recordLabel={recordLabel}
          onChoose={(draft) => {
            auto.current?.resolve(draft)
            setSubject(draft.subject)
            setBody(draft.body)
            setEpoch((n) => n + 1)
          }} />
      )}
      {shareOpen && <ShareDialog id={id} shares={d.shares} onClose={() => setShareOpen(false)} onSaved={async () => { setD(await notesApi.get(id)); onChanged() }} />}
      <Dialog open={!!askShare} onOpenChange={(o) => { if (!o && askShare) { askShare.done(false); setAskShare(null) } }}>
        <DialogContent className="sm:max-w-md" data-testid="note-share-offer">
          <DialogHeader>
            <DialogTitle>Share with {askShare?.p.name}?</DialogTitle>
            <DialogDescription>{askShare?.p.name} cannot open this note, so they cannot be mentioned yet. Share it with them (they can read it) and mention them?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="h-11 md:h-9" onClick={() => { askShare?.done(false); setAskShare(null) }}>Cancel</Button>
            <Button className="h-11 md:h-9" onClick={() => { askShare?.done(true); setAskShare(null) }} data-testid="note-share-offer-yes">Share and mention</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this note?" description="The note, its files and who it is shared with are deleted for everyone who can open it."
        onConfirm={async () => { try { auto.current?.stop(); await notesApi.remove(id); onDeleted() } catch (e) { toast(errMsg(e), 'error') } }} />
    </section>
  )
}

/* ------------------------------------------------------------------ the conflict choice */

function NoteView({ html, imageUrl, recordLabel, testId }: { html: string; imageUrl(a: string): string; recordLabel(r: string): { text: string; available: boolean } | null; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) renderInto(ref.current, html, { imageUrl, recordLabel, editable: false }) }, [html, imageUrl, recordLabel])
  return <div ref={ref} className="note-body max-h-48 overflow-y-auto rounded-md border bg-background p-2 text-sm" data-testid={testId} />
}

function ConflictDialog({ base, mine, theirs, imageUrl, recordLabel, onChoose }: {
  base: NoteDraft; mine: NoteDraft; theirs: NoteDraft & { by?: string | null }; imageUrl(a: string): string; recordLabel(r: string): { text: string; available: boolean } | null; onChoose(d: NoteDraft): void
}) {
  const merged = useMemo(() => mergeNotes(base.body, mine.body, theirs.body), [base.body, mine.body, theirs.body])
  const subject = mine.subject !== base.subject ? mine.subject : theirs.subject
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl" data-testid="note-conflict" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>This note was changed somewhere else</DialogTitle>
          <DialogDescription>{theirs.by ? `${theirs.by} saved` : 'Someone (or another tab) saved'} this note after you started editing. Nothing was overwritten: choose which text to keep.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1"><div className="text-xs font-medium">Your text</div><NoteView html={mine.body} imageUrl={imageUrl} recordLabel={recordLabel} testId="note-conflict-mine" /></div>
          <div className="grid gap-1"><div className="text-xs font-medium">The saved text</div><NoteView html={theirs.body} imageUrl={imageUrl} recordLabel={recordLabel} testId="note-conflict-theirs" /></div>
        </div>
        {!merged.ok && <p className="text-xs text-muted-foreground">Both changed the same paragraph, so they cannot be merged automatically.</p>}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onChoose({ subject: theirs.subject, body: theirs.body })} data-testid="note-conflict-theirs-btn">Take the saved text</Button>
          {merged.ok && <Button variant="outline" className="h-11 md:h-9" onClick={() => onChoose({ subject, body: merged.html })} data-testid="note-conflict-merge">Merge both</Button>}
          <Button className="h-11 md:h-9" onClick={() => onChoose({ subject: mine.subject, body: mine.body })} data-testid="note-conflict-mine-btn">Keep mine</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ sharing */

function ShareDialog({ id, shares, onClose, onSaved }: { id: string; shares: NoteShare[]; onClose(): void; onSaved(): Promise<void> | void }) {
  const { toast } = useToast()
  const me = usePlatform((s) => s.currentUserId)
  const [pq, setPq] = useState('')
  const [found, setFound] = useState<PersonOption[]>([])
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([])
  const [want, setWant] = useState<(WantedShare & { name: string })[]>(() => shares.map((s) => ({ PrincipalType: s.PrincipalType, Principal: s.Principal, Access: s.Access, name: s.name ?? s.Principal })))
  const [who, setWho] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { notesApi.teams().then(setTeams).catch(() => setTeams([])) }, [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => notesApi.people(pq).then((p) => live && setFound(p)).catch(() => live && setFound([])), 150)
    return () => { live = false; clearTimeout(t) }
  }, [pq])
  const taken = new Set(want.map((w) => `${w.PrincipalType}:${w.Principal}`))
  const add = (v: string) => {
    const [type, pid] = v.split(':') as ['user' | 'team', string]
    const name = type === 'team' ? teams.find((t) => t.id === pid)?.name : found.find((u) => u.id === pid)?.name
    if (pid && name) setWant([...want, { PrincipalType: type, Principal: pid, Access: 'read', name }])
    setWho('')
  }
  const save = async () => {
    const diff = diffShares(shares, want)
    if (isEmptyDiff(diff)) { onClose(); return }
    setBusy(true)
    try {
      for (const r of diff.remove) await notesApi.removeShare(r)
      for (const c of diff.change) await notesApi.changeShare(c.id, c.Access)
      for (const a of diff.add) await notesApi.addShare(id, a)
      await onSaved()
      onClose()
    } catch (e) {
      toast(errMsg(e), 'error')
      await onSaved()
    } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="note-share-dialog">
        <DialogHeader>
          <DialogTitle>Share this note</DialogTitle>
          <DialogDescription>People and teams you add can open the note; with "Can edit" they can also change it. Only you can share it or delete it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {want.length === 0 && <p className="text-sm text-muted-foreground">Not shared: only you can open it (and the people who can read the record it is about).</p>}
          {want.map((w, i) => (
            <div key={`${w.PrincipalType}:${w.Principal}`} className="flex items-center gap-2" data-testid="note-share-row">
              <span className="min-w-0 flex-1 truncate text-sm">{w.PrincipalType === 'team' ? <Badge variant="secondary" className="mr-1 font-normal">Team</Badge> : null}{w.name}</span>
              <select className="h-11 rounded-md border bg-background px-2 text-sm md:h-8" value={w.Access} aria-label={`Access for ${w.name}`} data-testid="note-share-access"
                onChange={(e) => setWant(want.map((x, j) => (j === i ? { ...x, Access: e.target.value as 'read' | 'edit' } : x)))}>
                <option value="read">Can read</option><option value="edit">Can edit</option>
              </select>
              <Button variant="ghost" size="icon-sm" className="size-11 md:size-8" aria-label={`Stop sharing with ${w.name}`} onClick={() => setWant(want.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
          <Input className="h-11 md:h-9" value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Add a person: type a name or an email" aria-label="Find a person" data-testid="note-share-find" />
          {pq.trim() && (
            <div className="max-h-44 overflow-y-auto rounded-md border" data-testid="note-share-people">
              {found.filter((u) => u.id !== me && !taken.has(`user:${u.id}`)).slice(0, 8).map((u) => (
                <button key={u.id} type="button" className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent md:min-h-9" data-testid={`note-share-person-${u.id}`}
                  onClick={() => { add(`user:${u.id}`); setPq('') }}>
                  <span className="truncate">{u.name}</span><span className="ml-auto truncate text-xs text-muted-foreground">{u.email}</span>
                </button>
              ))}
              {!found.some((u) => u.id !== me && !taken.has(`user:${u.id}`)) && <div className="p-2 text-xs text-muted-foreground">No one found.</div>}
            </div>
          )}
          {teams.length > 0 && (
            <select className="h-11 rounded-md border bg-background px-2 text-sm md:h-9" value={who} onChange={(e) => add(e.target.value)} aria-label="Share with a team" data-testid="note-share-team">
              <option value="">Add a team...</option>
              {teams.filter((t) => !taken.has(`team:${t.id}`)).map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name}</option>)}
            </select>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="h-11 md:h-9" onClick={onClose}>Cancel</Button>
          <Button className="h-11 md:h-9" disabled={busy} onClick={() => void save()} data-testid="note-share-save">{busy && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
