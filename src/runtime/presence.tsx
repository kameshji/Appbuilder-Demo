/**
 * Realtime UI pieces shared by app tabs, the player and the Studio (package H): presence avatars and the running app's
 * live bar (who else has the app open, "Update available" when someone saves a newer version).
 */
import { useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { PresenceMember } from '@/platform/live-api'
import { usePresence, useLiveTopic } from '@/platform/useLive'
import { AVATAR_HEX, avatarColorOf, initialsOf } from '@/platform/preferences'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AppStore } from './store'

/** overlapping initials circles; the rest as "+n" */
export function PresenceAvatars({ members, max = 4, size = 24, testId = 'presence-avatars', label }: { members: PresenceMember[]; max?: number; size?: number; testId?: string; label?: string }) {
  if (!members.length) return null
  const shown = members.slice(0, max)
  const more = members.length - shown.length
  const names = members.map((m) => `${m.name}${m.state === 'editing' ? ' (editing)' : ''}`).join(', ')
  return (
    <div className="flex items-center" data-testid={testId} data-count={members.length} title={`${label ?? 'Also here'}: ${names}`} aria-label={`${label ?? 'Also here'}: ${names}`}>
      {shown.map((m, i) => (
        <span
          key={m.id}
          data-testid="presence-avatar"
          data-user={m.id}
          className={cn('grid place-items-center rounded-full font-semibold text-white ring-2 ring-card', i > 0 && '-ml-1.5', m.state === 'editing' && 'outline-2 outline-offset-1 outline-amber-500')}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: AVATAR_HEX[avatarColorOf(m.id)] }}
        >
          {initialsOf(m.name)}
        </span>
      ))}
      {more > 0 && (
        <span className="-ml-1.5 grid place-items-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-card" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
          +{more}
        </span>
      )}
    </div>
  )
}

/**
 * Top-right corner of a running app: avatars of the other people who have it open, and an "Update available" pill when
 * someone saved a newer version (loading it keeps the app's variables and collections).
 */
export function AppLiveBar({ appId, store }: { appId: string; store: AppStore }) {
  const others = usePresence(`app:${appId}`, 'viewing')
  const [update, setUpdate] = useState<{ by: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const serverMode = usePlatform((s) => s.mode === 'server')
  useLiveTopic(`app:${appId}`, (m) => {
    if (m.t === 'app' && m.kind === 'saved' && !m.self) setUpdate({ by: m.by.name })
  })
  if (!others.length && !update) return null
  const load = async () => {
    setBusy(true)
    try {
      const def = await platform.apps.load(appId)
      if (def) store.getState().replaceDefinition(def)
      setUpdate(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-[340] flex items-center gap-2" data-testid="app-live-bar">
      {update && (
        <Button size="xs" variant="outline" className="h-7 gap-1.5 rounded-full bg-card shadow" onClick={() => void load()} disabled={busy} data-testid="app-update-available" title={`${update.by} saved a newer version of this app`}>
          {busy ? <RefreshCw className="animate-spin" /> : <Sparkles className="text-primary" />} Update available
        </Button>
      )}
      {others.length > 0 && (
        <span className="rounded-full bg-card/90 px-1.5 py-1 shadow">
          <PresenceAvatars members={others} size={22} label={serverMode ? 'Also using this app' : 'Open in another tab'} />
        </span>
      )}
    </div>
  )
}
