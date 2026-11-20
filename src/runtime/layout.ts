import type { CSSProperties } from 'react'
import type { AppDef } from '@/contracts'
import type { Geom, LayoutKind } from './evaluator'
import { deviceOf } from './sizes'

/** How the parent lays out a child: kind + the parent's children-box size at design resolution. */
export interface ParentLayout { kind: LayoutKind; dw: number; dh: number; alignItems: string }

const px = (n: number) => `${Math.round(n * 100) / 100}px`

function axis(a: string, pos: number, size: number, d: number, start: 'left' | 'top', end: 'right' | 'bottom', dim: 'width' | 'height'): CSSProperties {
  switch (a) {
    case 'end':
      return { [end]: px(d - pos - size), [dim]: px(size) }
    case 'stretch':
      return { [start]: px(pos), [end]: px(d - pos - size) }
    case 'center':
      return { [start]: `calc(50% + ${px(pos - d / 2)})`, [dim]: px(size) }
    case 'scale':
      return d > 0 ? { [start]: `${(pos / d) * 100}%`, [dim]: `${(size / d) * 100}%` } : { [start]: px(pos), [dim]: px(size) }
    default:
      return { [start]: px(pos), [dim]: px(size) }
  }
}

const alignCss = (a: string): CSSProperties['alignSelf'] | undefined =>
  a === 'start' ? 'flex-start' : a === 'end' ? 'flex-end' : a === 'center' ? 'center' : a === 'stretch' ? 'stretch' : undefined

/**
 * Wrapper style for a child. Manual parents: anchors expressed in CSS against the parent's box
 * (Start keeps left/top distance, End right/bottom, Stretch both, Center the offset from the centre,
 * Scale proportional), so nesting works at any size. Auto-layout parents: the wrapper is a flow item.
 */
export function placeStyle(
  parent: ParentLayout,
  g: Geom,
  o: { anchorH: string; anchorV: string; grow: number; alignSelf: string; exact?: boolean },
): CSSProperties {
  if (parent.kind === 'manual') {
    if (o.exact) return { position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h }
    return {
      position: 'absolute',
      ...axis(o.anchorH, g.x, g.w, parent.dw, 'left', 'right', 'width'),
      ...axis(o.anchorV, g.y, g.h, parent.dh, 'top', 'bottom', 'height'),
    }
  }
  const self = o.alignSelf === 'auto' ? '' : o.alignSelf
  const stretch = self === 'stretch' || (!self && parent.alignItems === 'stretch')
  const grow = Math.max(0, o.grow)
  const st: CSSProperties = { position: 'relative', minWidth: 0, minHeight: 0, boxSizing: 'border-box' }
  const as = alignCss(self)
  if (as) st.alignSelf = as
  if (parent.kind === 'row') {
    st.flex = `${grow} ${grow > 0 ? 1 : 0} ${px(g.w)}`
    if (!stretch) st.height = g.h
  } else if (parent.kind === 'column') {
    st.flex = `${grow} ${grow > 0 ? 1 : 0} ${px(g.h)}`
    if (!stretch) st.width = g.w
  } else {
    if (!stretch) st.height = g.h
  }
  return st
}

/* ------------------------------------------------------------------ app theme */

const LIGHT: Record<string, string> = {
  '--background': 'oklch(1 0 0)',
  '--foreground': 'oklch(0.21 0.02 265)',
  '--card': 'oklch(1 0 0)',
  '--card-foreground': 'oklch(0.21 0.02 265)',
  '--popover': 'oklch(1 0 0)',
  '--popover-foreground': 'oklch(0.21 0.02 265)',
  '--primary': 'oklch(0.51 0.19 277)',
  '--primary-foreground': 'oklch(0.99 0 0)',
  '--secondary': 'oklch(0.965 0.005 265)',
  '--secondary-foreground': 'oklch(0.25 0.02 265)',
  '--muted': 'oklch(0.965 0.005 265)',
  '--muted-foreground': 'oklch(0.52 0.02 265)',
  '--accent': 'oklch(0.955 0.02 277)',
  '--accent-foreground': 'oklch(0.3 0.1 277)',
  '--destructive': 'oklch(0.58 0.22 27)',
  '--border': 'oklch(0.915 0.006 265)',
  '--input': 'oklch(0.915 0.006 265)',
  '--ring': 'oklch(0.51 0.19 277)',
}

/** class + CSS variables that apply the app's theme to its frame, independent of the Studio theme */
export function themeOf(app: AppDef): { className: string; style: CSSProperties } {
  const t = app.theme ?? {}
  const dark = t.mode === 'dark'
  const style: Record<string, string | number> = dark ? {} : { ...LIGHT }
  if (t.primary) {
    style['--primary'] = t.primary
    style['--ring'] = t.primary
  }
  if (typeof t.radius === 'number') style['--radius'] = `${t.radius}px`
  if (t.font) style.fontFamily = t.font
  style.color = 'var(--foreground)'
  return { className: dark ? 'dark' : '', style: style as CSSProperties }
}

/* ------------------------------------------------------------------ run-time screen size */

export const MIN_W = 1024
export const MIN_H = 576
/** minimum responsive screen of a portrait (phone / tablet portrait) design */
export const MIN_PW = 320
export const MIN_PH = 480

/**
 * Actual screen size and scale for a surface of `area` px.
 * responsive, landscape design: the screen fills the area (min 1024x576); a portrait area keeps the design aspect.
 * responsive, portrait design (phone, tablet portrait): in a portrait area (a real phone) the screen fills it
 *   (min 320x480); in a landscape area (a desktop window or app tab) the design size is kept and scaled to fit,
 *   centred by the caller.
 * fit: design size scaled uniformly.
 */
export function surfaceSize(app: AppDef, area: { w: number; h: number }): { w: number; h: number; scale: number } {
  const aw = Math.max(1, area.w)
  const ah = Math.max(1, area.h)
  const portraitDesign = app.height > app.width
  if (app.scaleMode === 'fit' || (portraitDesign && aw >= ah)) {
    const scale = Math.min(aw / app.width, ah / app.height)
    return { w: app.width, h: app.height, scale: app.scaleMode === 'fit' ? scale : Math.min(1, scale) }
  }
  if (portraitDesign) {
    const w = Math.max(MIN_PW, aw)
    const h = Math.max(MIN_PH, ah)
    return { w: Math.round(w), h: Math.round(h), scale: Math.min(1, aw / w, ah / h) }
  }
  let w = Math.max(MIN_W, aw)
  let h = Math.max(MIN_H, ah)
  if (ah > aw) {
    w = Math.max(MIN_W, aw)
    h = Math.round((w * app.height) / app.width)
  }
  const scale = Math.min(1, aw / w, ah / h)
  return { w: Math.round(w), h: Math.round(h), scale }
}

/* ------------------------------------------------------------------ phones and tablets (P2 package A) */

/**
 * The layout rule for a phone- or tablet-size app on a touch device (docs/dev/phone.md "Layout rule"):
 *  - width: 1:1 and fluid. The screen is as wide as the device; the design width is the minimum breakpoint, so a
 *    device narrower than the design scales the screen down to fit (never a horizontal scroll), a wider one (a large
 *    phone, landscape) stretches it: controls follow their horizontal anchors (Stretch / End / Center / Scale).
 *  - height: at least the design height and at least the device height. Taller content scrolls vertically; a device
 *    taller than the design grows the screen, so bottom-anchored controls stay at the bottom.
 * Returns the screen size, the scale and whether the area must scroll vertically.
 */
export function fluidSurface(app: Pick<AppDef, 'width' | 'height'>, area: { w: number; h: number }): { w: number; h: number; scale: number; scroll: boolean } {
  const aw = Math.max(1, area.w)
  const ah = Math.max(1, area.h)
  const minW = Math.max(MIN_PW, Math.min(app.width, 1400))
  const w = Math.max(minW, Math.round(aw))
  const scale = Math.min(1, aw / w)
  const h = Math.max(app.height, Math.round(ah / scale))
  return { w, h, scale, scroll: h * scale > ah + 1 }
}

/** does the fluid rule apply? A phone or tablet design (sizes.ts deviceOf) on a touch device or in an area under 600 px wide */
export function usesFluidLayout(app: Pick<AppDef, 'width' | 'height' | 'scaleMode'>, area: { w: number; h: number }, touch: boolean): boolean {
  if (app.scaleMode === 'fit') return false
  if (deviceOf(app.width, app.height) === 'Desktop') return false
  return touch || area.w < 600
}
