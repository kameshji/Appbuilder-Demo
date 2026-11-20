/**
 * Connectivity (P2-A, docs/dev/phone.md "Connectivity"): is the server reachable from this page?
 *
 * Offline when the browser says so (navigator.onLine false) or when the last request got no answer at all
 * (remote.ts reports every request through the offline hook's noteNetwork). While offline, GET /api/v1/status is probed
 * with backoff (2 s, 4 s, ... 30 s) and on the browser's `online` event, so the banner clears and the outbox replays as
 * soon as the server answers again. Pure transitions (`nextState`) are unit-tested.
 */
import { create } from 'zustand'

export type Connection = 'online' | 'offline'

export interface ConnectivityState {
  status: Connection
  /** when the connection was lost (ms), null while online */
  since: number | null
  /** the browser itself reports no network (airplane mode, Wi-Fi off) */
  browserOffline: boolean
}

export type ConnectivityEvent = { t: 'request'; ok: boolean } | { t: 'browser'; online: boolean } | { t: 'probe'; ok: boolean }

export function nextState(s: ConnectivityState, e: ConnectivityEvent, now: number): ConnectivityState {
  if (e.t === 'browser') {
    if (!e.online) return { status: 'offline', since: s.since ?? now, browserOffline: true }
    // the browser has a network again; the server is reachable only when a request or the probe says so
    return { ...s, browserOffline: false }
  }
  if (e.ok) return { status: 'online', since: null, browserOffline: false }
  return { status: 'offline', since: s.since ?? now, browserOffline: s.browserOffline }
}

export const useConnectivity = create<ConnectivityState>(() => ({
  status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online',
  since: null,
  browserOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
}))

const backListeners = new Set<() => void>()
/** called each time the connection comes back (the outbox replays) */
export function onBackOnline(fn: () => void): () => void {
  backListeners.add(fn)
  return () => backListeners.delete(fn)
}

let probeTimer: ReturnType<typeof setTimeout> | null = null
let probeDelay = 2000

export function report(e: ConnectivityEvent): void {
  const prev = useConnectivity.getState()
  const next = nextState(prev, e, Date.now())
  if (next.status !== prev.status || next.browserOffline !== prev.browserOffline || next.since !== prev.since) useConnectivity.setState(next)
  if (prev.status === 'offline' && next.status === 'online') {
    probeDelay = 2000
    for (const l of [...backListeners]) {
      try {
        l()
      } catch {
        /* ignore */
      }
    }
  }
  if (next.status === 'offline') scheduleProbe()
  else if (probeTimer) {
    clearTimeout(probeTimer)
    probeTimer = null
  }
}

/** ask the server now (the banner's "Try again", the browser's online event) */
export async function probe(): Promise<boolean> {
  let ok = false
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    const res = await fetch('/api/v1/status', { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal })
    clearTimeout(t)
    ok = res.ok
  } catch {
    ok = false
  }
  report({ t: 'probe', ok })
  return ok
}

function scheduleProbe() {
  if (probeTimer || typeof window === 'undefined') return
  probeTimer = setTimeout(() => {
    probeTimer = null
    probeDelay = Math.min(30_000, probeDelay * 2)
    void probe()
  }, probeDelay)
}

let started = false
export function startConnectivity(): void {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('offline', () => report({ t: 'browser', online: false }))
  window.addEventListener('online', () => {
    report({ t: 'browser', online: true })
    void probe()
  })
}
