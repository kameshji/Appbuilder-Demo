/**
 * Coordination between the main window(s) and the chat pop-out window (`#chat`).
 *
 * Transport: BroadcastChannel('appbuilder-chat'); where that is unavailable, messages are written to localStorage
 * and arrive through the `storage` event in the other windows. Independently of the transport, the pop-out window
 * keeps a heartbeat in localStorage (KEY_WINDOW) while it is open, so a main window that loads later (or missed a
 * message, or whose pop-out crashed) can tell whether chat is open elsewhere. Every browser API is wrapped in
 * try/catch: sandboxed hosts may refuse storage or BroadcastChannel.
 */

export type ChatLinkMsg =
  /** the pop-out window is open (sent on load and in reply to a ping) */
  | { t: 'window-open' }
  /** the pop-out window is closing */
  | { t: 'window-closed' }
  /** a main window asks whether a pop-out is open */
  | { t: 'ping' }
  /** a main window takes chat back: the pop-out closes itself */
  | { t: 'bring-back' }

export const CHANNEL = 'appbuilder-chat'
export const KEY_MSG = 'appbuilder-chat-msg'
export const KEY_WINDOW = 'appbuilder-chat-window'
/** how often the pop-out refreshes its heartbeat, and when a heartbeat counts as stale */
export const HEARTBEAT_MS = 3000
export const STALE_MS = 9000

export interface ChatLink {
  post(msg: ChatLinkMsg): void
  close(): void
  /** true when BroadcastChannel is used (false: storage-event fallback) */
  broadcast: boolean
}

const isMsg = (m: unknown): m is ChatLinkMsg => !!m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string'

export function openChatLink(onMessage: (msg: ChatLinkMsg) => void): ChatLink {
  let bc: BroadcastChannel | null = null
  try {
    bc = new BroadcastChannel(CHANNEL)
    bc.onmessage = (e: MessageEvent) => {
      if (isMsg(e.data)) onMessage(e.data)
    }
  } catch {
    bc = null
  }
  const onStorage = (e: StorageEvent) => {
    if (bc || e.key !== KEY_MSG || !e.newValue) return
    try {
      const v = JSON.parse(e.newValue) as { msg?: unknown }
      if (isMsg(v.msg)) onMessage(v.msg)
    } catch {
      /* ignore malformed */
    }
  }
  try {
    window.addEventListener('storage', onStorage)
  } catch {
    /* no window events */
  }
  return {
    broadcast: !!bc,
    post(msg) {
      if (bc) {
        try {
          bc.postMessage(msg)
          return
        } catch {
          /* fall through to storage */
        }
      }
      try {
        // a nonce makes every write a change, so the storage event fires even for repeated messages
        localStorage.setItem(KEY_MSG, JSON.stringify({ msg, n: Math.random() }))
      } catch {
        /* storage refused */
      }
    },
    close() {
      try {
        bc?.close()
      } catch {
        /* ignore */
      }
      try {
        window.removeEventListener('storage', onStorage)
      } catch {
        /* ignore */
      }
    },
  }
}

/** the pop-out's heartbeat: `at` (ms) or null when none / unreadable */
export function readHeartbeat(): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_WINDOW) ?? 'null') as { at?: unknown } | null
    return v && typeof v.at === 'number' ? v.at : null
  } catch {
    return null
  }
}
export function writeHeartbeat(at = Date.now()) {
  try {
    localStorage.setItem(KEY_WINDOW, JSON.stringify({ at }))
  } catch {
    /* ignore */
  }
}
export function clearHeartbeat() {
  try {
    localStorage.removeItem(KEY_WINDOW)
  } catch {
    /* ignore */
  }
}
/** is a pop-out window alive according to its heartbeat? */
export function heartbeatFresh(now = Date.now(), at = readHeartbeat()): boolean {
  return at !== null && now - at < STALE_MS
}
