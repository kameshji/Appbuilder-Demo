/**
 * Session revocation feed for the realtime hub: every way a session ends goes through MetaStore.sessions.remove /
 * removeForUser or MetaStore.users.remove (logout, password change, an administrator disabling, deleting or resetting
 * the password of an account, package I's session list). watchSessions() wraps those three methods once, where the
 * MetaStore is created (services.ts), so the hub closes the affected sockets immediately after the database change.
 */
import type { MetaStore } from '../contracts.ts'

export type SessionEvent =
  | { kind: 'session'; idHash: string }
  | { kind: 'user'; userId: string; reason: 'sessions' | 'removed' }

type Listener = (e: SessionEvent) => void
const listeners = new Set<Listener>()

export function onSessionEvent(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function emitSessionEvent(e: SessionEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e)
    } catch {
      /* never fails the caller */
    }
  }
}

const WATCHED = Symbol('liveSessionsWatched')

/** wraps the session-ending methods of a MetaStore (idempotent); returns the same object */
export function watchSessions(meta: MetaStore): MetaStore {
  const m = meta as MetaStore & { [WATCHED]?: true }
  if (m[WATCHED]) return meta
  m[WATCHED] = true
  const remove = meta.sessions.remove.bind(meta.sessions)
  const removeForUser = meta.sessions.removeForUser.bind(meta.sessions)
  const removeUser = meta.users.remove.bind(meta.users)
  meta.sessions.remove = async (idHash) => {
    await remove(idHash)
    emitSessionEvent({ kind: 'session', idHash })
  }
  meta.sessions.removeForUser = async (userId) => {
    await removeForUser(userId)
    emitSessionEvent({ kind: 'user', userId, reason: 'sessions' })
  }
  meta.users.remove = async (id) => {
    await removeUser(id)
    emitSessionEvent({ kind: 'user', userId: id, reason: 'removed' })
  }
  return meta
}
