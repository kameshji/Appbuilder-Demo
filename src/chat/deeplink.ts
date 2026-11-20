/**
 * Where `#chat` opens, and deep links from notifications and the Mentions page (`#chat?c=<conversation>&m=<seq>`,
 * chatLink in src/platform/chat-protocol.ts).
 *
 *  - the pop-out window (window.name POPUP_NAME): chat fills it (ChatWindow);
 *  - a phone-sized window: chat fills the screen (conversation list and conversation as two screens);
 *  - a main window at desktop width with a conversation in the link: the shell stays where it was (App.tsx renders the
 *    page the person came from) and the dock opens that conversation at that message (ChatDock); when chat is popped
 *    out, the pop-out window is told instead.
 */
import { parseRoute, type Route } from '@/router'

export const POPUP_NAME = 'appbuilder-chat'
/** below this width chat fills the window (the shell's own phone breakpoint, md) */
export const PHONE_MAX_WIDTH = 767

export interface ChatTarget { c: string; m: number | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `#chat?c=<id>&m=<seq>` -> the target; null for anything else (a bare #chat has no target) */
export function parseChatLink(hash: string): ChatTarget | null {
  const m = /^#?chat\?(.*)$/.exec(hash)
  if (!m) return null
  const p = new URLSearchParams(m[1])
  const c = p.get('c') ?? ''
  if (!UUID.test(c)) return null
  const seq = Number(p.get('m'))
  return { c: c.toLowerCase(), m: Number.isInteger(seq) && seq > 0 ? seq : null }
}

export const isChatHash = (hash: string): boolean => /^#?chat(\?|$)/.test(hash)

/** the decision (pure): 'window' = chat fills this window, 'shell' = the shell stays and the dock opens the target */
export function chatPlacement(o: { popup: boolean; width: number; target: boolean }): 'window' | 'shell' {
  if (o.popup) return 'window'
  if (o.width <= PHONE_MAX_WIDTH) return 'window'
  return o.target ? 'shell' : 'window'
}

const win = (): Window | null => (typeof window === 'undefined' ? null : window)

export function isPopupWindow(): boolean {
  try {
    return win()?.name === POPUP_NAME
  } catch {
    return false
  }
}

export function isPhoneWidth(): boolean {
  const w = win()
  return !!w && w.innerWidth <= PHONE_MAX_WIDTH
}

/** App.tsx: a `#chat` route in this window keeps the shell (true) or shows chat in the whole window (false) */
export function chatOpensInShell(hash = win()?.location.hash ?? ''): boolean {
  const w = win()
  if (!w) return false
  return chatPlacement({ popup: isPopupWindow(), width: w.innerWidth, target: !!parseChatLink(hash) }) === 'shell'
}

/* ------------------------------------------------------------------ the page the person came from */

let lastShellHash = ''
let tracking = false

/** remembers the last hash that was not chat (started when this module loads in a browser) */
export function trackShellHash(): void {
  const w = win()
  if (!w || tracking) return
  tracking = true
  const note = () => {
    if (!isChatHash(w.location.hash)) lastShellHash = w.location.hash
  }
  note()
  w.addEventListener('hashchange', note)
}
trackShellHash()

/** the hash to return to when a chat link was opened in the shell (or the launcher when there is none) */
export function shellHashBeforeChat(): string {
  return lastShellHash && !isChatHash(lastShellHash) ? lastShellHash : '#u'
}

export function shellRouteForChat(): Route {
  return parseRoute(shellHashBeforeChat())
}
