/** Small pieces of the chat screens: avatars, conversation icons, badges. */
import { BellOff, Hash, Lock, User, Users } from 'lucide-react'
import type { ChatConversation } from '@/platform/chat-protocol'
import { cn } from '@/lib/utils'
import { initials } from './format'
import { countLabel } from './unread'

const COLORS = ['bg-sky-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600', 'bg-fuchsia-600']

function colorOf(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

export function Avatar({ id, name, size = 28, className }: { id: string; name: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-grid shrink-0 place-items-center rounded-full font-semibold text-white', colorOf(id || name), className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initials(name)}
    </span>
  )
}

export function KindIcon({ c, className }: { c: Pick<ChatConversation, 'kind' | 'isPrivate'>; className?: string }) {
  const cls = cn('size-4 shrink-0 text-muted-foreground', className)
  if (c.kind === 'direct') return <User className={cls} aria-hidden="true" />
  if (c.kind === 'group') return <Users className={cls} aria-hidden="true" />
  return c.isPrivate ? <Lock className={cls} aria-hidden="true" /> : <Hash className={cls} aria-hidden="true" />
}

/** what the conversation is, in words (screen readers, titles) */
export function kindLabel(c: Pick<ChatConversation, 'kind' | 'isPrivate'>): string {
  if (c.kind === 'direct') return 'Direct conversation'
  if (c.kind === 'group') return 'Group conversation'
  return c.isPrivate ? 'Private channel' : 'Open channel'
}

export const displayName = (c: Pick<ChatConversation, 'kind' | 'name'>): string => (c.kind === 'channel' ? `#${c.name}` : c.name || 'Conversation')

export function UnreadBadge({ c }: { c: ChatConversation }) {
  if (!c.me) return null
  if (c.me.muted) return c.unread > 0 ? <BellOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted, unread messages" /> : <BellOff className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="Muted" />
  if (c.mentions > 0) return <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-white" data-testid="chat-mentions" aria-label={`${c.mentions} mentions`}>@{c.mentions > 1 ? countLabel(c.mentions) : ''}</span>
  if (c.unread > 0) return <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" data-testid="chat-unread" aria-label={`${c.unread} unread`}>{countLabel(c.unread)}</span>
  return null
}
