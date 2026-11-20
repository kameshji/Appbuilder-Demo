import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, MessagesSquare, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/portal/theme'
import { ChatPanel } from './ChatPanel'
import { HEARTBEAT_MS, clearHeartbeat, openChatLink, writeHeartbeat } from './link'
import { isPopupWindow, parseChatLink, shellHashBeforeChat } from './deeplink'
import { openConversation } from './store'

/**
 * `#chat`: chat in a window of its own.
 *  - the pop-out window (opened by the dock): announces itself to the main windows, keeps a heartbeat while open, closes
 *    itself when a main window brings chat back, says goodbye when it is closed, opens links a main window sends;
 *  - a phone-sized window (or a #chat address typed into a main window): chat fills the screen, Back returns to the
 *    page the person came from. It is not a pop-out, so the main windows' docks are left alone.
 * `#chat?c=<id>&m=<seq>` opens that conversation at that message in both.
 */
export function ChatWindow() {
  useTheme()
  const popup = isPopupWindow()
  const [returned, setReturned] = useState(false)
  const goodbye = useRef<() => void>(() => {})

  // the conversation (and message) in the address, now and when it changes
  useEffect(() => {
    const go = () => {
      const t = parseChatLink(location.hash)
      if (t) void openConversation(t.c, t.m)
    }
    go()
    window.addEventListener('hashchange', go)
    return () => window.removeEventListener('hashchange', go)
  }, [])

  useEffect(() => {
    document.title = 'Chat - Appbuilder'
    if (!popup) return
    const link = openChatLink((msg) => {
      if (msg.t === 'ping') link.post({ t: 'window-open' })
      else if (msg.t === 'open') void openConversation(msg.c, msg.m)
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
  }, [popup])

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
    <div data-testid="chat-window" data-popup={popup ? '1' : '0'} className="flex h-full flex-col bg-card text-card-foreground" style={popup ? undefined : { paddingBottom: 'var(--kb, 0px)' }}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
        {!popup && (
          <Button variant="ghost" size="icon-sm" aria-label="Back to the app" title="Back" data-testid="chat-window-back" onClick={() => { location.hash = shellHashBeforeChat() }}>
            <ArrowLeft />
          </Button>
        )}
        <MessagesSquare className="size-4 text-primary" />
        <span className="text-sm font-semibold">Chat</span>
        {popup && !returned && (
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
        <ChatPanel variant="window" phone={!popup} />
      )}
    </div>
  )
}
