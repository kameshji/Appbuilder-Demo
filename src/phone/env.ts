/**
 * Phone environment (P2 package A, docs/dev/phone.md): what kind of device the page runs on, and the viewport
 * handling the runtime needs on phones. Browser-only; every access is guarded so the module loads under Node (tests).
 *
 * startPhoneEnvironment() (called once from main.tsx):
 *  - classes on <html>: `touch` (primary pointer is coarse), `ios`, `android`, `standalone` (opened from the home
 *    screen), and `touch-preview` when the Studio's touch-mode preview forces touch rules on a desktop;
 *  - CSS variables `--vvh` (visual viewport height, px) and `--kb` (height the on-screen keyboard covers, px): Chrome on
 *    Android resizes the layout with `interactive-widget=resizes-content` (index.html), iOS Safari does not, so the
 *    keyboard inset is computed from window.visualViewport;
 *  - a focused text field inside a running app is scrolled into view above the keyboard (focusin + visualViewport
 *    resize), so the keyboard never covers the field being typed into.
 */
import { useSyncExternalStore } from 'react'

export type DeviceKind = 'phone' | 'tablet' | 'desktop'

export interface DeviceInfo {
  kind: DeviceKind
  /** primary pointer is coarse (finger) */
  touch: boolean
  ios: boolean
  android: boolean
  /** opened from the home screen (display-mode standalone, or iOS navigator.standalone) */
  standalone: boolean
  screenWidth: number
  screenHeight: number
  orientation: 'portrait' | 'landscape'
  online: boolean
  /** service workers and installation need a secure context (HTTPS or localhost) */
  secure: boolean
}

const hasWindow = () => typeof window !== 'undefined' && typeof document !== 'undefined'

function mq(q: string): boolean {
  try {
    return hasWindow() && typeof window.matchMedia === 'function' && window.matchMedia(q).matches
  } catch {
    return false
  }
}

/** pure classification, unit-tested: user agent + coarse pointer + screen size */
export function classify(ua: string, coarse: boolean, screenW: number, screenH: number, maxTouchPoints = 0): Pick<DeviceInfo, 'kind' | 'ios' | 'android' | 'touch'> {
  const android = /Android/i.test(ua)
  // iPadOS 13+ reports a Mac user agent; it has touch points
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)
  const touch = coarse || ((ios || android) && maxTouchPoints > 0)
  const short = Math.min(screenW || 0, screenH || 0)
  let kind: DeviceKind = 'desktop'
  if (touch || ios || android) kind = short > 0 && short < 600 ? 'phone' : short >= 600 && short < 1100 ? 'tablet' : /Mobi/i.test(ua) ? 'phone' : 'tablet'
  if (!touch && !ios && !android) kind = 'desktop'
  return { kind, ios, android, touch }
}

let forcedTouch = false

export function deviceInfo(): DeviceInfo {
  if (!hasWindow()) {
    return { kind: 'desktop', touch: false, ios: false, android: false, standalone: false, screenWidth: 0, screenHeight: 0, orientation: 'landscape', online: true, secure: false }
  }
  const nav = navigator as Navigator & { standalone?: boolean }
  const c = classify(nav.userAgent || '', mq('(pointer: coarse)') || forcedTouch, screen?.width ?? 0, screen?.height ?? 0, nav.maxTouchPoints ?? 0)
  return {
    ...c,
    touch: c.touch || forcedTouch,
    standalone: mq('(display-mode: standalone)') || nav.standalone === true,
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
    orientation: window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape',
    online: nav.onLine !== false,
    secure: window.isSecureContext === true,
  }
}

/* ------------------------------------------------------------------ reactive snapshot */

const listeners = new Set<() => void>()
let snap: DeviceInfo = deviceInfo()
function refresh() {
  const next = deviceInfo()
  if (JSON.stringify(next) === JSON.stringify(snap)) return
  snap = next
  for (const l of [...listeners]) l()
}
export function subscribeDevice(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const currentDevice = (): DeviceInfo => snap
export function useDevice(): DeviceInfo {
  return useSyncExternalStore(subscribeDevice, currentDevice, currentDevice)
}
/** true on a touch-first device, or while the Studio's touch-mode preview is on */
export const isTouch = (): boolean => snap.touch

/** Studio "Touch mode" preview: apply the touch rules (hit targets, bottom sheets, native pickers) on a desktop */
export function setTouchPreview(on: boolean) {
  forcedTouch = on
  if (hasWindow()) document.documentElement.classList.toggle('touch-preview', on)
  refresh()
  applyClasses()
}
export const touchPreview = () => forcedTouch

/* ------------------------------------------------------------------ viewport and keyboard */

function applyClasses() {
  if (!hasWindow()) return
  const c = document.documentElement.classList
  c.toggle('touch', snap.touch)
  c.toggle('ios', snap.ios)
  c.toggle('android', snap.android)
  c.toggle('standalone', snap.standalone)
}

/** keyboard inset (px the keyboard hides at the bottom of the layout viewport), from the visual viewport */
export function keyboardInset(layoutH: number, visualH: number, visualTop: number): number {
  const kb = Math.round(layoutH - (visualH + visualTop))
  return kb > 80 ? kb : 0 // smaller differences are toolbars and zoom, not a keyboard
}

const TEXT_FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]), textarea, [contenteditable="true"]'

function revealFocused() {
  const el = document.activeElement as HTMLElement | null
  if (!el || !el.matches?.(TEXT_FIELD)) return
  if (!el.closest('[data-run-surface], [data-phone-reveal]')) return
  const vv = window.visualViewport
  const r = el.getBoundingClientRect()
  const bottom = vv ? vv.height + vv.offsetTop : window.innerHeight
  const top = vv ? vv.offsetTop : 0
  if (r.bottom > bottom - 12 || r.top < top + 8) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    } catch {
      el.scrollIntoView()
    }
  }
}

let started = false
/** install the classes, CSS variables and listeners; returns a stop function (tests, hot reload) */
export function startPhoneEnvironment(): () => void {
  if (!hasWindow() || started) return () => {}
  started = true
  const root = document.documentElement
  const setVars = () => {
    const vv = window.visualViewport
    const h = vv ? vv.height : window.innerHeight
    root.style.setProperty('--vvh', `${Math.round(h)}px`)
    root.style.setProperty('--kb', `${vv ? keyboardInset(window.innerHeight, vv.height, vv.offsetTop) : 0}px`)
  }
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  const onFocus = () => {
    // the keyboard animates in for ~250 ms; reveal after it settled (and again when the viewport resizes)
    clearTimeout(revealTimer)
    revealTimer = setTimeout(revealFocused, 300)
  }
  const onResize = () => {
    setVars()
    refresh()
    applyClasses()
    onFocus()
  }
  const onOnline = () => refresh()
  setVars()
  applyClasses()
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
  document.addEventListener('focusin', onFocus)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOnline)
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null
  mql?.addEventListener?.('change', onResize)
  return () => {
    started = false
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    window.visualViewport?.removeEventListener('resize', onResize)
    document.removeEventListener('focusin', onFocus)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOnline)
    mql?.removeEventListener?.('change', onResize)
  }
}
