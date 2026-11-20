/** Chat's view of the page's live connection (pure): the banner over the conversation follows it. */
import type { LiveStatus } from '@/platform/live'

export type SocketState = 'off' | 'connecting' | 'open' | 'offline'

export function socketStateOf(s: LiveStatus): SocketState {
  if (s.state === 'open') return 'open'
  if (s.state === 'off') return 'off'
  if (s.state === 'degraded' && s.reason === 'You are offline.') return 'offline'
  return 'connecting'
}
