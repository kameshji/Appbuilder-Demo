/**
 * State of the chat dock (right-side panel in the shell and the Studio): open/closed and width (remembered in
 * localStorage), and whether chat is popped out into its own window. The chat module itself is not built yet; it
 * renders inside `ChatPanel` (ChatPanel.tsx), the only component that needs to change when it arrives.
 */
import { create } from 'zustand'
import { HEARTBEAT_MS, KEY_WINDOW, heartbeatFresh, openChatLink, type ChatLink } from './link'

const PREFS_KEY = 'appbuilder-chat-dock'
export const MIN_WIDTH = 300
export const MAX_WIDTH = 720
export const DEFAULT_WIDTH = 380

interface Prefs { open: boolean; width: number }
function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null
    return { open: v?.open === true, width: typeof v?.width === 'number' ? clampWidth(v.width) : DEFAULT_WIDTH }
  } catch {
    return { open: false, width: DEFAULT_WIDTH }
  }
}
function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}
export function clampWidth(w: number): number {
  const max = typeof window !== 'undefined' ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 480)) : MAX_WIDTH
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, w)))
}

export interface ChatDockState {
  open: boolean
  width: number
  /** chat is open in its own window; the dock shows "Chat is open in another window" */
  poppedOut: boolean
  /** the last pop-out attempt was blocked by the browser */
  blocked: boolean
  show(): void
  hide(): void
  toggle(): void
  setWidth(w: number): void
  /** open `#chat` in its own window; false when the browser blocked it */
  popOut(): boolean
  /** close the pop-out window and show chat in the dock again */
  bringBack(): void
}

let link: ChatLink | null = null

export const useChatDock = create<ChatDockState>((set, get) => {
  const prefs = readPrefs()
  const save = () => writePrefs({ open: get().open, width: get().width })
  return {
    open: prefs.open,
    width: prefs.width,
    poppedOut: false,
    blocked: false,
    show: () => {
      set({ open: true })
      save()
    },
    hide: () => {
      set({ open: false, blocked: false })
      save()
    },
    toggle: () => (get().open ? get().hide() : get().show()),
    setWidth: (w) => {
      set({ width: clampWidth(w) })
      save()
    },
    popOut: () => {
      let w: Window | null = null
      try {
        w = window.open(`${location.pathname}${location.search}#chat`, 'appbuilder-chat', 'popup,width=440,height=760')
      } catch {
        w = null
      }
      if (!w) {
        set({ blocked: true })
        return false
      }
      try {
        w.focus()
      } catch {
        /* ignore */
      }
      set({ poppedOut: true, open: true, blocked: false })
      save()
      return true
    },
    bringBack: () => {
      link?.post({ t: 'bring-back' })
      set({ poppedOut: false, open: true })
      save()
    },
  }
})

let started = false
/**
 * Main windows: follow the pop-out window (BroadcastChannel / storage events, plus its heartbeat). Call once.
 * Returns a disposer (used by tests and hot reload).
 */
export function startChatDockSync(): () => void {
  if (started) return () => {}
  started = true
  link = openChatLink((msg) => {
    if (msg.t === 'window-open') useChatDock.setState({ poppedOut: true })
    else if (msg.t === 'window-closed') {
      // chat comes back to the dock when the pop-out closes
      if (useChatDock.getState().poppedOut) useChatDock.getState().show()
      useChatDock.setState({ poppedOut: false })
    }
  })
  if (heartbeatFresh()) useChatDock.setState({ poppedOut: true })
  link.post({ t: 'ping' })
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY_WINDOW && e.newValue === null && useChatDock.getState().poppedOut) useChatDock.setState({ poppedOut: false })
  }
  try {
    window.addEventListener('storage', onStorage)
  } catch {
    /* ignore */
  }
  let poppedAt = 0
  const unsub = useChatDock.subscribe((s, prev) => {
    if (s.poppedOut && !prev.poppedOut) poppedAt = Date.now()
  })
  // a pop-out that disappeared without saying goodbye (crash, killed) stops counting once its heartbeat is stale
  const timer = setInterval(() => {
    const st = useChatDock.getState()
    if (st.poppedOut && !heartbeatFresh()) {
      // grace period right after opening: the new window may not have written its first heartbeat yet
      if (Date.now() - poppedAt < HEARTBEAT_MS * 2) return
      useChatDock.setState({ poppedOut: false })
    }
  }, HEARTBEAT_MS)
  return () => {
    started = false
    clearInterval(timer)
    unsub()
    link?.close()
    link = null
    try {
      window.removeEventListener('storage', onStorage)
    } catch {
      /* ignore */
    }
  }
}
