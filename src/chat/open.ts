/**
 * Opening chat from the shell: the User menu entry, the chat button, deep links. At phone width chat fills the screen
 * (`#chat`); otherwise the dock opens (or the pop-out window is told, when chat is popped out).
 */
import { useChatDock } from './dock'
import { isPhoneWidth, isPopupWindow, parseChatLink, shellHashBeforeChat, type ChatTarget } from './deeplink'
import { openConversation } from './store'
import { postToChatWindow } from './dock'

export function openChat(target?: ChatTarget | null): void {
  if (typeof window === 'undefined') return
  if (isPhoneWidth() && !isPopupWindow()) {
    const hash = target ? `#chat?c=${target.c}${target.m ? `&m=${target.m}` : ''}` : '#chat'
    if (location.hash !== hash) location.hash = hash
    return
  }
  const dock = useChatDock.getState()
  if (dock.poppedOut && !isPopupWindow()) {
    if (target) postToChatWindow({ t: 'open', c: target.c, m: target.m })
    return
  }
  dock.show()
  if (target) void openConversation(target.c, target.m)
}

/**
 * A `#chat?c=..&m=..` link that arrived in a main window at desktop width (App.tsx kept the shell): open it in the
 * dock and put the address back to the page the person was on (replace: Back does not return to the link).
 */
export function consumeChatLinkInShell(): boolean {
  const t = parseChatLink(location.hash)
  if (!t) return false
  openChat(t)
  try {
    location.replace(`${location.pathname}${location.search}${shellHashBeforeChat()}`)
  } catch {
    location.hash = shellHashBeforeChat()
  }
  return true
}
