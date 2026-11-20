/**
 * The chat composer (default 6 of the spec): the comment text box approach with shortcuts (format.ts), a mention list
 * that offers only people who can read the conversation (the server's /mentionable answer), files through the attachment
 * store (uploaded first, then named in the message), cards waiting from "Share to chat", typing events.
 * Enter sends, Shift+Enter is a new line (on touch screens Enter is a new line and the button sends); Ctrl+B / Ctrl+I /
 * Ctrl+E format the selection; Up in an empty box edits my last message; Escape closes the mention list or cancels.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { AtSign, FileText, LayoutGrid, Loader2, Paperclip, SendHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CHAT_LIMITS, type ChatCardRef, type ChatConversation, type ChatFile, type ChatPerson } from '@/platform/chat-protocol'
import { chatApi, errText } from './api'
import { Avatar } from './bits'
import { fileSize, insertMention, mentionQuery, textLength, wrapSelection, type MentionMap } from './format'
import { clearShareCards, sendMessage, sendTyping, useChat } from './store'

interface Draft { key: string; name: string; size: number; state: 'uploading' | 'ready' | 'error'; file?: ChatFile; error?: string }

const coarse = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/** in-memory drafts per place (conversation or thread), so switching conversations keeps what was typed */
const drafts = new Map<string, { text: string; mentions: MentionMap }>()
const draftListeners = new Set<() => void>()

/** puts text into a place's composer (a refused message taken back for fixing); the composer shows it at once */
export function setComposerDraft(channelId: string, parentId: string | null, text: string): void {
  drafts.set(`${channelId}:${parentId ?? ''}`, { text, mentions: new Map() })
  for (const l of draftListeners) l()
}
export function onComposerDraft(fn: () => void): () => void {
  draftListeners.add(fn)
  return () => { draftListeners.delete(fn) }
}

export function Composer({ conversation, parentId = null, edit, onDone, onEditLast, autoFocus }: {
  conversation: ChatConversation
  parentId?: string | null
  /** edit mode: the message's text and mentions; save is onDone(text, mentions) */
  edit?: { text: string; mentions: MentionMap; save(text: string, mentions: MentionMap): Promise<void> }
  onDone?(): void
  onEditLast?(): void
  autoFocus?: boolean
}) {
  const me = useChat((s) => s.me)
  const shareCards = useChat((s) => s.shareCards)
  const place = `${conversation.id}:${parentId ?? ''}`
  const saved = edit ? null : drafts.get(place)
  const [text, setText] = useState(edit?.text ?? saved?.text ?? '')
  const mentions = useRef<MentionMap>(new Map(edit?.mentions ?? saved?.mentions ?? []))
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null)
  const [people, setPeople] = useState<ChatPerson[]>([])
  const [hi, setHi] = useState(0)
  const [files, setFiles] = useState<Draft[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cards: ChatCardRef[] = edit || parentId ? [] : shareCards

  // a new place: its own draft
  useEffect(() => {
    if (edit) return
    const d = drafts.get(place)
    setText(d?.text ?? '')
    mentions.current = new Map(d?.mentions ?? [])
    setFiles([])
    setError('')
    setMention(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place])
  useEffect(() => {
    if (!edit) drafts.set(place, { text, mentions: mentions.current })
  }, [text, place, edit])
  useEffect(() => {
    if (autoFocus) ta.current?.focus()
  }, [autoFocus, place])

  // a caret placed by a pick or a shortcut: set in the same commit as the text (typing may follow at once)
  const caret = useRef<[number, number] | null>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el || !caret.current) return
    el.focus()
    el.setSelectionRange(caret.current[0], caret.current[1])
    caret.current = null
  }, [text])

  // autosize up to about 8 lines
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  // the mention list: people who can read this conversation, from the server
  const canChannelMention = conversation.kind === 'channel' && (conversation.memberCount <= CHAT_LIMITS.channelMentionMembers || conversation.me?.role === 'owner' || !!me?.isAdmin)
  useEffect(() => {
    if (!mention) return
    let live = true
    const t = setTimeout(() => {
      chatApi.mentionable(conversation.id, mention.q).then((r) => { if (live) { setPeople(r.users.filter((u) => u.id !== me?.id)); setHi(0) } }).catch(() => live && setPeople([]))
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [mention, conversation.id, me?.id])
  const options = useMemo(() => {
    const list: ChatPerson[] = [...people]
    if (mention && canChannelMention && 'channel'.startsWith(mention.q.toLowerCase())) list.unshift({ id: 'channel', name: 'channel' })
    return list.slice(0, 8)
  }, [people, mention, canChannelMention])

  const change = (v: string, caret: number) => {
    setText(v)
    setError('')
    setMention(mentionQuery(v, caret))
    if (v.trim() && !edit) sendTyping(conversation.id)
  }
  const pick = (p: ChatPerson) => {
    if (!mention) return
    const r = insertMention(text, mention.at, mention.q, p.name)
    mentions.current.set(p.name, p.id)
    caret.current = [r.caret, r.caret]
    setText(r.text)
    setMention(null)
  }

  const addFiles = async (list: FileList | File[]) => {
    const arr = [...list]
    if (!arr.length) return
    if (files.length + arr.length > CHAT_LIMITS.maxFiles) {
      setError(`At most ${CHAT_LIMITS.maxFiles} files per message.`)
      return
    }
    for (const f of arr) {
      const key = `${f.name}:${f.size}:${Math.random()}`
      // refused here, before the upload: the server refuses it too (413)
      if (f.size > CHAT_LIMITS.maxFileBytes) {
        setError(`"${f.name}" is larger than ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB and cannot be sent.`)
        continue
      }
      setFiles((d) => [...d, { key, name: f.name, size: f.size, state: 'uploading' }])
      try {
        const up = await chatApi.upload(conversation.id, f)
        setFiles((d) => d.map((x) => (x.key === key ? { ...x, state: 'ready', file: up } : x)))
      } catch (e) {
        setFiles((d) => d.map((x) => (x.key === key ? { ...x, state: 'error', error: errText(e) } : x)))
      }
    }
  }
  const dropFile = (d: Draft) => {
    setFiles((list) => list.filter((x) => x.key !== d.key))
    if (d.file) void chatApi.discardFile(d.file.id).catch(() => {})
  }

  const len = textLength(text)
  const ready = files.filter((d) => d.state === 'ready').map((d) => d.file!)
  const uploading = files.some((d) => d.state === 'uploading')
  const empty = !text.trim() && !ready.length && !cards.length
  const tooLong = len > CHAT_LIMITS.maxTextChars

  const submit = async () => {
    if (empty || tooLong || uploading || busy) return
    if (edit) {
      setBusy(true)
      try {
        await edit.save(text, mentions.current)
        onDone?.()
      } catch (e) {
        setError(errText(e))
      } finally {
        setBusy(false)
      }
      return
    }
    const input = { text, mentions: new Map(mentions.current), parentId, files: ready, cards }
    setText('')
    mentions.current = new Map()
    drafts.delete(place)
    setFiles([])
    if (cards.length) clearShareCards()
    await sendMessage(conversation.id, input)
    ta.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[Math.min(hi, options.length - 1)])
        return
      }
    }
    if (e.key === 'Escape') {
      if (mention) { e.preventDefault(); e.stopPropagation(); setMention(null); return }
      if (edit) { e.preventDefault(); e.stopPropagation(); onDone?.() }
      return
    }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'e'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      const el = e.currentTarget
      const mark = { b: '*', i: '_', e: '`' }[e.key.toLowerCase() as 'b' | 'i' | 'e']
      const r = wrapSelection(text, el.selectionStart, el.selectionEnd, mark)
      caret.current = [r.start, r.end]
      setText(r.text)
      return
    }
    if (e.key === 'ArrowUp' && !text && !edit && onEditLast) {
      e.preventDefault()
      onEditLast()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (!coarse() || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (edit) return
    const f = [...e.clipboardData.files]
    if (f.length) {
      e.preventDefault()
      void addFiles(f)
    }
  }

  if (!edit && !conversation.canPost) return null

  const placeholder = edit ? 'Edit the message' : parentId ? 'Reply in the thread' : conversation.kind === 'channel' ? `Message #${conversation.name}` : `Message ${conversation.name}`
  return (
    <div className={cn('relative', !edit && 'border-t border-border bg-card p-2')} data-testid={edit ? 'chat-edit' : parentId ? 'chat-thread-composer' : 'chat-composer'}
      onDragOver={(e) => { if (!edit && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => { if (!edit && e.dataTransfer.files.length) { e.preventDefault(); void addFiles(e.dataTransfer.files) } }}>
      {mention && options.length > 0 && (
        <ul role="listbox" aria-label="People who can read this conversation" className="absolute bottom-full left-2 z-30 mb-1 max-h-60 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md" data-testid="chat-mention-list">
          {options.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === hi}>
              <button type="button" className={cn('flex min-h-9 w-full items-center gap-2 rounded px-2 py-1 text-left text-sm', i === hi ? 'bg-accent' : 'hover:bg-muted')}
                data-testid="chat-mention-option" data-person={p.name} onMouseDown={(e) => { e.preventDefault(); pick(p) }}>
                {p.id === 'channel' ? <AtSign className="size-4 text-muted-foreground" /> : <Avatar id={p.id} name={p.name} size={20} />}
                <span className="truncate">{p.id === 'channel' ? '@channel (everyone here)' : p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {mention && options.length === 0 && people.length === 0 && mention.q.length > 0 && (
        <p className="absolute bottom-full left-2 z-30 mb-1 w-64 rounded-md border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md">No match among the people who can read this conversation. Only they can be mentioned.</p>
      )}
      {(files.length > 0 || cards.length > 0) && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Attached">
          {files.map((d) => (
            <li key={d.key} className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs', d.state === 'error' ? 'border-destructive/50 text-destructive' : 'border-border')} data-testid="chat-draft-file" data-state={d.state}>
              {d.state === 'uploading' ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
              <span className="truncate">{d.name}</span>
              <span className="text-muted-foreground">{d.state === 'error' ? d.error : fileSize(d.size)}</span>
              <button type="button" aria-label={`Remove ${d.name}`} className="rounded p-0.5 hover:bg-muted" onClick={() => dropFile(d)}><X className="size-3" /></button>
            </li>
          ))}
          {cards.map((c, i) => (
            <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs" data-testid="chat-draft-card">
              <LayoutGrid className="size-3.5" />
              {c.kind === 'record' ? 'A record' : c.kind === 'app' ? 'An app' : 'A dashboard'} is shared with this message
            </li>
          ))}
          {cards.length > 0 && <li><button type="button" className="text-xs text-muted-foreground underline" onClick={() => clearShareCards()}>Remove cards</button></li>}
        </ul>
      )}
      <div className={cn('flex items-end gap-1.5', !edit && 'rounded-lg border border-input bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20')}>
        {!edit && (
          <>
            <Button variant="ghost" size="icon-sm" className="mb-0.5" title={`Attach files (up to ${CHAT_LIMITS.maxFiles}, ${CHAT_LIMITS.maxFileBytes / 1024 / 1024} MB each)`} aria-label="Attach files" onClick={() => fileRef.current?.click()} data-testid="chat-attach">
              <Paperclip />
            </Button>
            <input ref={fileRef} type="file" multiple className="hidden" data-testid="chat-file-input" onChange={(e) => { const f = e.target.files; if (f) void addFiles(f); e.target.value = '' }} />
          </>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-describedby={`chat-hint-${place}`}
          data-testid={edit ? 'chat-edit-input' : 'chat-input'}
          onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          className={cn('min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground', edit && 'rounded-md border border-input bg-background px-2 focus:border-ring')}
        />
        {!edit && (
          <Button size="icon-sm" className="mb-0.5" disabled={empty || tooLong || uploading} onClick={() => void submit()} aria-label="Send" title="Send (Enter)" data-testid="chat-send">
            <SendHorizontal />
          </Button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
        <span id={`chat-hint-${place}`} className="min-w-0 flex-1 truncate">
          {edit ? 'Enter saves, Escape cancels' : '*bold* _italic_ `code` - list, @ to mention. Shift+Enter: new line'}
        </span>
        {len > CHAT_LIMITS.maxTextChars * 0.8 && <span className={cn(tooLong && 'font-medium text-destructive')}>{len} / {CHAT_LIMITS.maxTextChars}</span>}
        {edit && (
          <>
            <Button size="xs" variant="ghost" onClick={() => onDone?.()}>Cancel</Button>
            <Button size="xs" disabled={empty || tooLong || busy} onClick={() => void submit()} data-testid="chat-edit-save">{busy && <Loader2 className="animate-spin" />}Save</Button>
          </>
        )}
      </div>
      {error && <p className="px-1 pt-1 text-xs text-destructive" role="alert" data-testid="chat-composer-error">{error}</p>}
    </div>
  )
}
