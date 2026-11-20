import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2, MessagesSquare, WifiOff, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LiveApi } from '@/platform/live-api'
import { useBackClose } from '@/phone/back'
import { ConversationList } from './ConversationList'
import { Conversation } from './Conversation'
import { clearNotice, closeConversation, closeThreadPane, openConversation, setPanelVisible, startChat, useChat } from './store'

/**
 * THE chat module boundary: everything the dock, the pop-out window and the phone screen show as chat. The dock
 * (ChatDock.tsx), the pop-out window (ChatWindow.tsx) and their coordination (dock.ts, link.ts) stay as they are.
 *
 * Narrow (the dock, a phone): the conversation list and the conversation are two screens; wide (the pop-out window at
 * 680 px and more): side by side. A thread replaces the conversation with a back button. Keyboard: arrows in the list,
 * Alt+Up / Alt+Down for the previous / next conversation, Escape goes back. `live` is accepted for compatibility; chat
 * subscribes its topics on the page's one live connection itself (store.ts, src/platform/live.ts).
 */
export function ChatPanel({ variant, phone = false }: { variant: 'dock' | 'window'; live?: LiveApi | null; phone?: boolean }) {
  const status = useChat((s) => s.status)
  const reason = useChat((s) => s.reason)
  const conn = useChat((s) => s.conn)
  const openId = useChat((s) => s.openId)
  const threadId = useChat((s) => s.threadId)
  const notice = useChat((s) => s.notice)
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => { void startChat() }, [])
  useEffect(() => {
    setPanelVisible(1)
    return () => setPanelVisible(-1)
  }, [])
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const wide = variant === 'window' && width >= 680
  const narrow = !wide

  // phones: Android Back closes the thread, then the conversation (one history entry each, no address change)
  useBackClose(phone && !!openId && !threadId, () => closeConversation())
  useBackClose(phone && !!threadId, () => closeThreadPane())

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const order = useChat.getState().list.order
      if (!order.length) return
      const i = openId ? order.indexOf(openId) : -1
      const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next && next !== openId) {
        e.preventDefault()
        void openConversation(next)
      }
      return
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      const t = e.target as HTMLElement
      // a text box with something in it keeps Escape for itself
      if ((t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && t.value) return
      if (threadId) { e.preventDefault(); closeThreadPane() } else if (narrow && openId) { e.preventDefault(); closeConversation() }
    }
  }

  let body
  if (status === 'idle' || status === 'loading') {
    body = <div className="grid flex-1 place-items-center" data-testid="chat-loading"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  } else if (status === 'unavailable') {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="chat-unavailable">
        <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground"><MessagesSquare className="size-6" /></span>
        <p className="text-sm font-medium">Chat is not available</p>
        <p className="text-xs text-muted-foreground">{reason}</p>
      </div>
    )
  } else if (wide) {
    body = (
      <div className="flex min-h-0 flex-1">
        <ConversationList className="w-72 shrink-0 border-r border-border" />
        {openId ? <Conversation key={openId} id={openId} narrow={false} /> : (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground" data-testid="chat-none-open">Pick a conversation, or start a new one.</div>
        )}
      </div>
    )
  } else {
    body = openId ? <Conversation key={openId} id={openId} narrow onBack={() => closeConversation()} /> : <ConversationList className="flex-1" />
  }

  return (
    <div ref={root} data-testid="chat-panel" data-variant={variant} data-phone={phone ? '1' : '0'} data-live={conn} data-status={status} className="flex min-h-0 flex-1 flex-col pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11" onKeyDown={onKey}>
      {status === 'ready' && conn !== 'open' && (
        <p className={cn('flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs', conn === 'offline' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'bg-muted text-muted-foreground')} role="status" data-testid="chat-conn">
          {conn === 'offline' ? <WifiOff className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
          {conn === 'offline' ? 'You are offline. Sending needs a connection; messages catch up when it is back.' : 'Reconnecting. Messages catch up when the connection is back.'}
        </p>
      )}
      {notice && (
        <p className="flex shrink-0 items-start gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200" role="alert" data-testid="chat-notice">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" className="rounded p-0.5 hover:bg-amber-500/20" onClick={() => clearNotice()}><X className="size-3.5" /></button>
        </p>
      )}
      {body}
    </div>
  )
}
