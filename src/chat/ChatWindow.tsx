import { useEffect, useRef, useState } from 'react'
import { MessagesSquare, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/portal/theme'
import { ChatPanel } from './ChatPanel'
import { HEARTBEAT_MS, clearHeartbeat, openChatLink, writeHeartbeat } from './link'

/**
 * `#chat`: chat popped out into its own window. Announces itself to the main windows, keeps a heartbeat while open,
 * closes itself when a main window brings chat back, and says goodbye when it is closed.
 */
export function ChatWindow() {
  useTheme()
  const [returned, setReturned] = useState(false)
  const goodbye = useRef<() => void>(() => {})

  useEffect(() => {
    document.title = 'Chat - Appbuilder'
    const link = openChatLink((msg) => {
      if (msg.t === 'ping') link.post({ t: 'window-open' })
      else if (msg.t === 'bring-back') {
        stop()
        setReturned(true)
        try {
          window.close()
        } catch {
          /* not closable: the "moved back" message stays */
        }
      }
    })
    writeHeartbeat()
    link.post({ t: 'window-open' })
    const timer = setInterval(() => writeHeartbeat(), HEARTBEAT_MS)
    let stopped = false
    function stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      clearHeartbeat()
    }
    const bye = () => {
      stop()
      link.post({ t: 'window-closed' })
    }
    goodbye.current = bye
    window.addEventListener('pagehide', bye)
    window.addEventListener('beforeunload', bye)
    return () => {
      bye()
      link.close()
      window.removeEventListener('pagehide', bye)
      window.removeEventListener('beforeunload', bye)
    }
  }, [])

  const back = () => {
    // the main window shows chat in its dock again when it hears the goodbye
    goodbye.current()
    setReturned(true)
    try {
      window.close()
    } catch {
      /* ignore */
    }
  }

  return (
    <div data-testid="chat-window" className="flex h-full flex-col bg-card text-card-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <MessagesSquare className="size-4 text-primary" />
        <span className="text-sm font-semibold">Chat</span>
        {!returned && (
          <Button variant="ghost" size="xs" className="ml-auto" data-testid="chat-window-dock" onClick={back} title="Show chat in the main window again">
            <Undo2 /> Back to the main window
          </Button>
        )}
      </header>
      {returned ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center" data-testid="chat-window-returned">
          <p className="text-sm font-medium">Chat moved back to the main window</p>
          <p className="text-xs text-muted-foreground">You can close this window.</p>
        </div>
      ) : (
        <ChatPanel variant="window" />
      )}
    </div>
  )
}
