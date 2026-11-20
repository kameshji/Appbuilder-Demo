/**
 * The installable web app on the client (P2-A, docs/dev/phone.md "PWA"; the server side is server/core/pwa.ts).
 *
 *  - registerServiceWorker(): registers /api/v1/pwa/sw.js with scope "/" when the page is served by the Appbuilder
 *    server in a secure context (HTTPS or localhost). A worker of a newer build waits; `usePwa().updateReady` makes the
 *    shell show "New version available — Reload"; applyUpdate() tells it to take over and reloads once it has.
 *  - setAppManifest(appId | null): while an app is open its own manifest is linked, so "Add to Home screen" adds
 *    that app (its name and icon, starting it directly); otherwise the install manifest.
 *  - installHelp(): which instructions to show (Android Chrome: the install prompt or the menu; iOS Safari: Share >
 *    Add to Home Screen; others: the browser menu), and whether it is already installed.
 *  - `?app=<id>` in the start address (the per-app manifest's start_url) opens that app.
 */
import { create } from 'zustand'

interface PwaState {
  supported: boolean
  registered: boolean
  updateReady: boolean
  /** Android Chrome's deferred install prompt is available */
  canPrompt: boolean
}
export const usePwa = create<PwaState>(() => ({ supported: false, registered: false, updateReady: false, canPrompt: false }))

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let deferredPrompt: BeforeInstallPromptEvent | null = null
let waiting: ServiceWorker | null = null

export async function registerServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    usePwa.setState({ canPrompt: true })
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    usePwa.setState({ canPrompt: false })
  })
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  usePwa.setState({ supported: true })
  // only where the Appbuilder server answers (demo mode on a static host has no /api)
  try {
    const st = await fetch('/api/v1/status', { cache: 'no-store', credentials: 'same-origin' })
    if (!st.ok || !(st.headers.get('content-type') ?? '').includes('json')) return
  } catch {
    // offline at start: a worker registered earlier keeps working; nothing to register now
    return
  }
  try {
    const reg = await navigator.serviceWorker.register('/api/v1/pwa/sw.js', { scope: '/' })
    usePwa.setState({ registered: true })
    const track = (w: ServiceWorker | null) => {
      if (!w) return
      const check = () => {
        // a new worker installed while an older one controls the page: offer the update
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          waiting = w
          usePwa.setState({ updateReady: true })
        }
      }
      check()
      w.addEventListener('statechange', check)
    }
    track(reg.waiting)
    track(reg.installing)
    reg.addEventListener('updatefound', () => track(reg.installing))
    // check for a new build when the page comes back to the foreground, and hourly
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update().catch(() => {})
    })
    setInterval(() => void reg.update().catch(() => {}), 3600_000)
  } catch {
    /* registration refused (no HTTPS on a LAN address, private mode): the app still works online */
  }
}

/** "Reload" in the update banner: the waiting worker takes over, then the page reloads on the new build */
export function applyUpdate(): void {
  if (!waiting) {
    location.reload()
    return
  }
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  })
  waiting.postMessage({ type: 'skip-waiting' })
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable'
  const p = deferredPrompt
  deferredPrompt = null
  usePwa.setState({ canPrompt: false })
  await p.prompt()
  return (await p.userChoice).outcome
}

export function setAppManifest(appId: string | null): void {
  if (typeof document === 'undefined') return
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (!link) return
  const href = appId ? `/api/v1/pwa/apps/${encodeURIComponent(appId)}/manifest.webmanifest` : '/api/v1/pwa/manifest.webmanifest'
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}

export type InstallPlatform = 'android-chrome' | 'ios-safari' | 'ios-other' | 'desktop-chromium' | 'other'

/** pure: which install instructions apply to a user agent (unit-tested) */
export function installPlatform(ua: string, maxTouchPoints = 0): InstallPlatform {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? 'ios-other' : /Safari/i.test(ua) ? 'ios-safari' : 'ios-other'
  if (/Android/i.test(ua)) return /Chrome\//i.test(ua) && !/SamsungBrowser|Firefox|OPR|EdgA/i.test(ua) ? 'android-chrome' : 'other'
  if (/Chrome\/|Edg\//i.test(ua)) return 'desktop-chromium'
  return 'other'
}

/** the address an app opens at from the home screen: `/?app=<id>` -> `#u-<id>` (no hash given) */
export function startRouteOf(search: string, hash: string): string | null {
  if (hash && hash !== '#') return null
  const id = new URLSearchParams(search).get('app')
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? `#u-${id}` : null
}
