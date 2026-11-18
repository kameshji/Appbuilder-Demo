/**
 * The Studio's realtime side (package H): presence of other makers in the same app (studio:<appId>), the soft edit lock
 * and "a newer version was saved" warnings. Real co-editing is out of scope: the first maker who opens an app edits it,
 * everyone after opens it read-only and may take over (the previous editor's pending changes are saved first, then they
 * become read-only). A locked production environment is read-only for everyone.
 *
 * Without a live connection (degraded) the lock cannot be enforced: the Studio stays editable, as before package H, and
 * says so; demo mode has no locks (tabs of one browser).
 */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { Eye, Lock, RefreshCw, TriangleAlert, Users } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { LivePerson, PresenceMember } from '@/platform/live-api'
import { useLiveTopic } from '@/platform/useLive'
import { useStore } from '@/runtime/store'
import { PresenceAvatars } from '@/runtime/presence'
import { Button } from '@/components/ui/button'

export type EditState = 'edit' | 'readonly' | 'pending'

interface StudioLive {
  /** other makers with this app open in the Studio */
  others: PresenceMember[]
  edit: EditState
  /** who holds the edit lock when it is not us */
  holder: LivePerson | null
  /** last notice (took over, not connected) */
  notice: string | null
  /** someone else saved while we were editing */
  newer: { by: string } | null
  /** the lock could not be checked (no live connection): editing is allowed, with a warning */
  unchecked: boolean
}

export const useStudioLive = create<StudioLive>(() => ({ others: [], edit: 'pending', holder: null, notice: null, newer: null, unchecked: false }))

/**
 * Presence + lock for one app; returns the edit state. `envLocked`: the environment is a locked production one (read-only
 * for everyone, no lock is taken).
 */
export function useStudioLock(appId: string, envLocked: boolean): EditState {
  const ready = usePlatform((s) => s.ready && !!s.session)
  const mode = usePlatform((s) => s.mode)
  const liveState = usePlatform((s) => s.live?.state ?? 'off')
  const env = usePlatform((s) => s.environmentId)
  const me = usePlatform((s) => s.session?.user.id ?? s.currentUserId)
  const edit = useStudioLive((s) => s.edit)
  const scope = `studio:${appId}`
  const acquiring = useRef(false)

  // presence: who else has the Studio of this app open, and the lock as the server sees it
  useEffect(() => {
    if (!ready) return
    useStudioLive.setState({ others: [], edit: envLocked ? 'readonly' : mode === 'demo' ? 'edit' : 'pending', holder: null, notice: null, newer: null, unchecked: false })
    const off = platform.live.subscribe(`presence:${scope}`, (m) => {
      if (m.t === 'presence' && m.scope === scope) {
        useStudioLive.setState({ others: m.members.filter((x) => x.id !== me) })
        if (envLocked || mode === 'demo' || !m.lock) return
        const cur = useStudioLive.getState()
        if (m.lock.mine) {
          if (cur.edit !== 'edit') useStudioLive.setState({ edit: 'edit', holder: null })
        } else if (m.lock.holder) {
          if (cur.edit === 'edit' && !cur.unchecked) useStudioLive.setState({ edit: 'readonly', holder: m.lock.holder })
          else useStudioLive.setState({ holder: m.lock.holder })
        } else if (cur.edit !== 'edit') {
          // the editor left: take the lock (the app is reloaded with their last save)
          void acquire('acquire')
        }
      } else if (m.t === 'lock' && m.scope === scope && !m.id && !m.mine && m.message) {
        // someone took over
        useStudioLive.setState({ edit: 'readonly', holder: m.holder, notice: m.message })
      }
    })
    return () => {
      off()
      platform.live.setPresence(scope, null)
      if (!envLocked && mode === 'server') void platform.live.lock(scope, 'release')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, ready, envLocked, mode, env])

  async function acquire(action: 'acquire' | 'takeover') {
    if (acquiring.current) return
    acquiring.current = true
    try {
      const r = await platform.live.lock(scope, action)
      if (r.ok && r.mine) useStudioLive.setState({ edit: 'edit', holder: null, unchecked: false, notice: action === 'takeover' ? 'You took over editing.' : null })
      else if (!r.ok && r.holder) useStudioLive.setState({ edit: 'readonly', holder: r.holder, unchecked: false })
      else useStudioLive.setState({ edit: 'edit', unchecked: true, notice: r.message ?? null })
    } finally {
      acquiring.current = false
    }
  }

  // others see "editing" only for the lock holder
  useEffect(() => {
    if (!ready) return
    platform.live.setPresence(scope, edit === 'edit' && !envLocked ? 'editing' : 'viewing')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, ready, envLocked, appId, env])

  // take the lock when the live connection is (or comes back) open
  useEffect(() => {
    if (!ready || envLocked || mode !== 'server') return
    if (liveState === 'open') void acquire('acquire')
    else if (liveState === 'degraded' && useStudioLive.getState().edit === 'pending') useStudioLive.setState({ edit: 'edit', unchecked: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveState, ready, envLocked, mode, appId, env])

  // someone saved a newer version: follow it while read-only, warn while editing
  useLiveTopic(`app:${appId}`, (m) => {
    if (m.t !== 'app' || m.self || m.kind !== 'saved') return
    if (useStudioLive.getState().edit === 'edit') useStudioLive.setState({ newer: { by: m.by.name } })
    else void reloadDefinition(appId)
  })

  return envLocked ? 'readonly' : edit
}

export function takeOver(appId: string): Promise<void> {
  return platform.live.lock(`studio:${appId}`, 'takeover').then((r) => {
    if (r.ok && r.mine) useStudioLive.setState({ edit: 'edit', holder: null, notice: 'You took over editing.', newer: null })
    else useStudioLive.setState({ notice: r.message ?? 'Could not take over.' })
  })
}

/** read the saved definition again (keeps selection where it can) */
export async function reloadDefinition(appId: string): Promise<void> {
  const def = await platform.apps.load(appId).catch(() => null)
  if (!def || useStore.getState().appId !== appId) return
  useStore.getState().replaceDefinition(def)
  useStudioLive.setState({ newer: null })
}

/** avatars of the other makers in this app's Studio (command bar) */
export function StudioPeople() {
  const others = useStudioLive((s) => s.others)
  if (!others.length) return null
  return (
    <span className="flex items-center gap-1.5" data-testid="studio-people">
      <Users className="size-3.5 text-muted-foreground" />
      <PresenceAvatars members={others} size={22} label="Also in the Studio" testId="studio-presence" />
    </span>
  )
}

/** the banner under the command bar: read-only because someone else edits, a newer save, or no lock check */
export function StudioLiveBanner({ appId, envLocked }: { appId: string; envLocked: boolean }) {
  const { edit, holder, notice, newer, unchecked, others } = useStudioLive()
  if (envLocked) return null
  const editingOthers = others
  if (edit === 'readonly') {
    return (
      <div role="status" data-testid="studio-soft-locked" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-100">
        <Eye className="size-3.5 shrink-0" />
        <span>
          {notice ? <>{notice} </> : null}
          <b>Read-only.</b> {holder?.name ?? 'Another maker'} is editing this app. You see their saved changes as they happen.
        </span>
        <Button size="xs" variant="outline" className="ml-auto h-6" data-testid="studio-take-over" onClick={() => void takeOver(appId)}>
          <Lock /> Take over editing
        </Button>
      </div>
    )
  }
  if (newer) {
    return (
      <div role="status" data-testid="studio-newer-save" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-100">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span><b>{newer.by}</b> saved a newer version of this app. Your next change overwrites it; load theirs first to keep both.</span>
        <Button size="xs" variant="outline" className="ml-auto h-6" onClick={() => void reloadDefinition(appId)}><RefreshCw /> Load their version</Button>
      </div>
    )
  }
  if (edit === 'edit' && unchecked) {
    return (
      <div role="status" data-testid="studio-lock-unchecked" className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span>Live updates are not connected, so Appbuilder cannot tell whether someone else is editing this app. Saves still work; the last save wins.</span>
      </div>
    )
  }
  if (edit === 'edit' && editingOthers.length) {
    return (
      <div role="status" data-testid="studio-also-editing" className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
        <Users className="size-3.5 shrink-0" />
        <span>Also open by {editingOthers.map((o) => o.name).join(', ')}, read-only while you edit.</span>
      </div>
    )
  }
  return null
}
