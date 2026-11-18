/**
 * React hooks over platform.live (package H): presence of other people in a scope, live topics, the connection state.
 * Usable from the portal, the Studio and the runtime (all may import the platform).
 */
import { useEffect, useRef, useState } from 'react'
import { platform, usePlatform } from './index'
import type { LiveMessage, PresenceMember, PresenceState } from './live-api'

/**
 * Join a presence scope (app:<id>, studio:<id>, record:<table>:<row>) with `state` while mounted (null: only watch) and
 * return the OTHER members (not me). Re-joins after an environment switch or a sign-in.
 */
export function usePresence(scope: string | null, state: PresenceState | null): PresenceMember[] {
  const [members, setMembers] = useState<PresenceMember[]>([])
  const ready = usePlatform((s) => s.ready && !!s.session)
  const env = usePlatform((s) => s.environmentId)
  const me = usePlatform((s) => s.session?.user.id ?? s.currentUserId)
  useEffect(() => {
    if (!scope || !ready) return
    const off = platform.live.subscribe(`presence:${scope}`, (m) => {
      if (m.t === 'presence' && m.scope === scope) setMembers(m.members)
    })
    if (state) platform.live.setPresence(scope, state)
    return () => {
      off()
      if (state) platform.live.setPresence(scope, null)
      setMembers([])
    }
  }, [scope, state, ready, env])
  return members.filter((m) => m.id !== me)
}

/** run a handler for every message of a topic (current environment unless env is given; null: install-wide) */
export function useLiveTopic(topic: string | null, handler: (m: LiveMessage) => void, env?: string | null): void {
  const h = useRef(handler)
  h.current = handler
  const ready = usePlatform((s) => s.ready && !!s.session)
  const current = usePlatform((s) => s.environmentId)
  useEffect(() => {
    if (!topic || !ready) return
    return platform.live.subscribe(topic, (m) => h.current(m), env === undefined ? {} : { env })
  }, [topic, ready, current, env])
}

/** the connection state ('open', 'degraded', 'connecting', 'off') */
export function useLiveStatus() {
  return usePlatform((s) => s.live ?? { state: 'off' as const, since: 0 })
}
