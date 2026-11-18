import { useRef } from 'react'
import { AppWindow, ExternalLink, MessagesSquare, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChatPanel } from './ChatPanel'
import { useChatDock } from './dock'

/** button for a top bar / command bar that opens and closes the dock */
export function ChatButton({ className, size = 'icon-sm' }: { className?: string; size?: 'icon-sm' | 'icon' }) {
  const open = useChatDock((s) => s.open)
  return (
    <Button
      variant={open ? 'secondary' : 'ghost'}
      size={size}
      className={className}
      data-testid="chat-button"
      aria-pressed={open}
      aria-label={open ? 'Hide chat' : 'Show chat'}
      title={open ? 'Hide chat' : 'Chat'}
      onClick={() => useChatDock.getState().toggle()}
    >
      <MessagesSquare />
    </Button>
  )
}

/** the chat dock, right (default) or left of the shell (Settings > Chat); resizable; open/closed and width are remembered */
export function ChatDock({ side = 'right' }: { side?: 'left' | 'right' }) {
  const left = side === 'left'
  const open = useChatDock((s) => s.open)
  const width = useChatDock((s) => s.width)
  const poppedOut = useChatDock((s) => s.poppedOut)
  const blocked = useChatDock((s) => s.blocked)
  const drag = useRef<{ x: number; w: number } | null>(null)
  if (!open) return null

  return (
    <aside
      data-testid="chat-dock"
      data-side={side}
      aria-label="Chat"
      style={{ width }}
      className={cn('relative z-40 flex h-full shrink-0 flex-col border-border bg-card text-card-foreground', left ? 'border-r' : 'border-l')}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
        aria-valuenow={width}
        tabIndex={0}
        data-testid="chat-dock-resize"
        className={cn('absolute inset-y-0 z-10 w-2 cursor-col-resize', left ? '-right-1' : '-left-1', ' outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-80')}
        onPointerDown={(e) => {
          e.preventDefault()
          drag.current = { x: e.clientX, w: width }
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current) useChatDock.getState().setWidth(drag.current.w + (left ? 1 : -1) * (e.clientX - drag.current.x))
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') useChatDock.getState().setWidth(width + (left ? -24 : 24))
          else if (e.key === 'ArrowRight') useChatDock.getState().setWidth(width + (left ? 24 : -24))
        }}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <MessagesSquare className="size-4 text-primary" />
        <span className="text-sm font-semibold">Chat</span>
        <div className="ml-auto flex items-center gap-0.5">
          {!poppedOut && (
            <Button variant="ghost" size="icon-sm" data-testid="chat-popout" title="Pop out into its own window" aria-label="Pop out chat" onClick={() => useChatDock.getState().popOut()}>
              <ExternalLink />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" data-testid="chat-dock-close" title="Hide chat" aria-label="Hide chat" onClick={() => useChatDock.getState().hide()}>
            <X />
          </Button>
        </div>
      </header>
      {blocked && !poppedOut && (
        <p className="border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-testid="chat-popout-blocked">
          The browser blocked the new window. Allow pop-ups for this site to pop chat out.
        </p>
      )}
      {poppedOut ? <PoppedOut /> : <ChatPanel variant="dock" />}
    </aside>
  )
}

function PoppedOut() {
  return (
    <div data-testid="chat-popped-out" className={cn('flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center')}>
      <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <AppWindow className="size-6" />
      </span>
      <div>
        <p className="text-sm font-medium">Chat is open in another window</p>
        <p className="mt-1 text-xs text-muted-foreground">Bring it back to show it here and close the other window.</p>
      </div>
      <Button size="sm" variant="outline" data-testid="chat-bring-back" onClick={() => useChatDock.getState().bringBack()}>
        <Undo2 /> Bring back
      </Button>
    </div>
  )
}
