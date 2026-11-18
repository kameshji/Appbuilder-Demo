import { AtSign, Hash, LayoutGrid, MessageCircle, MessageSquareText, MessagesSquare, Paperclip, Search, SendHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * THE chat module boundary. Everything the dock and the pop-out window show as "chat" is rendered by this component;
 * the dock (ChatDock.tsx), the pop-out window (ChatWindow.tsx) and their coordination (dock.ts, link.ts) do not need
 * to change when the real chat module (P3, on the realtime hub) drops in here.
 *
 * Today: a designed "coming soon" state listing what chat will do.
 */
export function ChatPanel({ variant }: { variant: 'dock' | 'window' }) {
  return (
    <div data-testid="chat-panel" data-variant={variant} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
        <div className="flex flex-col items-center text-center">
          <span className="relative grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <MessagesSquare className="size-7" />
            <span className="absolute -right-1 -top-1 rounded-full bg-card px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shadow-sm ring-1 ring-border">Soon</span>
          </span>
          <h2 className="mt-3 text-[15px] font-semibold">Chat is on its way</h2>
          <p className="mt-1 max-w-72 text-xs leading-relaxed text-muted-foreground">
            Talk to your team next to the apps you work in. Planned for P3 Collaboration and templates.
          </p>
        </div>
        <ul className={cn('mt-5 grid gap-2', variant === 'window' && 'sm:grid-cols-2')} data-testid="chat-features">
          <Feature icon={Hash} title="Channels" text="Open and private channels for teams, sites and projects." />
          <Feature icon={MessageCircle} title="Direct messages" text="One-to-one and small group conversations." />
          <Feature icon={AtSign} title="Mentions" text="@someone or @channel, with a notification where they are." />
          <Feature icon={Paperclip} title="File sharing" text="Drop files into a conversation; they stay with the message." />
          <Feature icon={LayoutGrid} title="Share as a card" text="Share a record, an app or a dashboard; each reader sees only what they may." />
          <Feature icon={MessageSquareText} title="Per-record discussion" text="Every record gets its own thread, right inside the app." />
          <Feature icon={Search} title="Search" text="Find any message, file or shared card you have access to." />
        </ul>
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 text-xs text-muted-foreground" aria-disabled="true" title="Chat is not available yet">
          <span className="flex-1 truncate">Message #general</span>
          <SendHorizontal className="size-4 opacity-50" />
        </div>
      </div>
    </div>
  )
}

function Feature({ icon: Icon, title, text }: { icon: typeof Hash; title: string; text: string }) {
  return (
    <li className="flex gap-3 rounded-lg border border-border bg-background p-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{title}</span>
        <span className="block text-[11.5px] leading-snug text-muted-foreground">{text}</span>
      </span>
    </li>
  )
}
