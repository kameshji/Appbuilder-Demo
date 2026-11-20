/**
 * A shared record, app or dashboard (spec 5.4). The message holds a reference only; what this reader sees is the
 * server's answer for them (POST /chat/cards/resolve): the fields their column security allows, "not available" for a
 * row they may not read, an app they may not run or a dashboard they may not view. Nothing here comes from the
 * browser's own data. A record card asks again when its table changes for the reader (table topic).
 * Package E: "Share to chat" (share.tsx) makes record, app and dashboard cards; approval cards (ApprovalCard.tsx) come
 * from the system sender "Approvals" only.
 */
import { useEffect } from 'react'
import { AppWindow, LayoutDashboard, Loader2, Lock, Rows3 } from 'lucide-react'
import type { ChatCardRef } from '@/platform/chat-protocol'
import { cardKey, resolveCard, useChat, watchCardTable } from '../store'
import { ApprovalCard } from './ApprovalCard'

function show(v: unknown, type: string): string {
  if (v === null || v === undefined || v === '') return '-'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if ((type === 'date' || type === 'datetime') && typeof v === 'string') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return type === 'date' ? d.toLocaleDateString() : d.toLocaleString()
  }
  if (Array.isArray(v)) return v.map((x) => show(x, '')).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function ChatCard({ messageId, index, card, version = 0 }: { messageId: string; index: number; card: ChatCardRef; version?: number }) {
  if (card.kind === 'approval') return <ApprovalCard messageId={messageId} index={index} card={card} version={version} />
  return <ReferenceCard messageId={messageId} index={index} card={card} />
}

function ReferenceCard({ messageId, index, card }: { messageId: string; index: number; card: Exclude<ChatCardRef, { kind: 'approval' }> }) {
  const key = cardKey(messageId, index)
  const v = useChat((s) => s.cards[key])
  useEffect(() => {
    if (v === undefined) void resolveCard(messageId, index, card)
  }, [v, messageId, index, card])
  const table = card.kind === 'record' ? card.table : null
  useEffect(() => (table ? watchCardTable(card.env, table) : undefined), [card.env, table])

  const box = 'mt-1 block max-w-80 rounded-md border border-border bg-background p-2.5 text-sm'
  if (v === undefined || v === 'loading') return <div className={box} data-testid="chat-card" data-state="loading"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
  if (v === 'error') return <div className={box} data-testid="chat-card" data-state="error"><span className="text-xs text-muted-foreground">The card could not be loaded.</span></div>
  if (!v.available) {
    return (
      <div className={box} data-testid="chat-card" data-state="unavailable" data-kind={v.kind}>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3.5" /> Not available</span>
      </div>
    )
  }
  if (v.kind === 'record') {
    return (
      <div className={box} data-testid="chat-card" data-state="available" data-kind="record">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Rows3 className="size-3.5" /> {v.tableName}</div>
        {v.title !== null && <div className="mt-0.5 truncate font-medium" data-testid="chat-card-title">{v.title}</div>}
        {v.fields.length > 0 && (
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {v.fields.map((f) => (
              <div key={f.name} className="contents" data-testid="chat-card-field" data-field={f.name}>
                <dt className="text-muted-foreground">{f.displayName}</dt>
                <dd className="truncate">{show(f.value, f.type)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    )
  }
  if (v.kind === 'approval') return null
  if (v.kind === 'app') {
    return (
      <a className={`${box} hover:bg-muted`} href={`#u-${encodeURIComponent(v.app)}`} data-testid="chat-card" data-state="available" data-kind="app">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><AppWindow className="size-3.5" /> App</div>
        <div className="mt-0.5 truncate font-medium">{v.name}</div>
        {v.description && <div className="line-clamp-2 text-xs text-muted-foreground">{v.description}</div>}
      </a>
    )
  }
  return (
    <a className={`${box} hover:bg-muted`} href={`#u-dashboards?d=${encodeURIComponent(v.dashboard)}`} data-testid="chat-card" data-state="available" data-kind="dashboard">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><LayoutDashboard className="size-3.5" /> Dashboard</div>
      <div className="mt-0.5 truncate font-medium">{v.name}</div>
      {v.description && <div className="line-clamp-2 text-xs text-muted-foreground">{v.description}</div>}
    </a>
  )
}
