/**
 * Device-frame maths for the Studio Preview of phone and tablet apps. Pure: no React, no DOM.
 * The frame shows the app at one of the design size presets of its device class (sizes.ts), portrait or rotated, with a
 * bezel around the screen, scaled down (never up) to fit the Preview area.
 */
import { SIZE_PRESETS, deviceOf, type SizeGroup } from '@/runtime/sizes'

export interface FrameChoice {
  /** preset id, or 'design' for an app size that is not a preset */
  id: string
  label: string
  /** portrait size (short side first) */
  w: number
  h: number
}

/** bezel thickness and screen corner radius in px, by device class */
export const BEZEL: Record<'Phone' | 'Tablet', { bezel: number; radius: number }> = {
  Phone: { bezel: 12, radius: 34 },
  Tablet: { bezel: 18, radius: 22 },
}

export const MIN_FRAME_SCALE = 0.2

/** the portrait-first size of a size: short side is the width */
const portrait = (w: number, h: number) => ({ w: Math.min(w, h), h: Math.max(w, h) })

/**
 * The sizes a maker can switch between for a design size of this device class: the presets of the class (a tablet
 * has one portrait preset, landscape is its rotation), plus the app's own size when it is not one of them.
 * Null for a desktop design (no frame).
 */
export function frameChoices(appW: number, appH: number): FrameChoice[] | null {
  const device = deviceOf(appW, appH)
  if (device === 'Desktop') return null
  const seen = new Set<string>()
  const list: FrameChoice[] = []
  for (const p of SIZE_PRESETS) {
    if (p.group !== device) continue
    const s = portrait(p.w, p.h)
    const key = `${s.w}x${s.h}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ id: p.id.replace('-landscape', '-portrait'), label: p.label.replace(/ (portrait|landscape)$/, ''), ...s })
  }
  const own = portrait(appW, appH)
  if (!seen.has(`${own.w}x${own.h}`)) list.push({ id: 'design', label: 'Design size', ...own })
  return list
}

/** which choice and orientation the app's own size corresponds to */
export function initialFrame(appW: number, appH: number): { id: string; rotated: boolean } | null {
  const choices = frameChoices(appW, appH)
  if (!choices) return null
  const own = portrait(appW, appH)
  const hit = choices.find((c) => c.w === own.w && c.h === own.h) ?? choices[0]
  return { id: hit.id, rotated: appW > appH }
}

/** screen size of a choice, turned sideways when rotated */
export const screenSize = (c: Pick<FrameChoice, 'w' | 'h'>, rotated: boolean): { w: number; h: number } =>
  rotated ? { w: c.h, h: c.w } : { w: c.w, h: c.h }

export interface FrameLayout {
  screen: { w: number; h: number }
  /** screen plus bezel */
  outer: { w: number; h: number }
  bezel: number
  radius: number
  /** 0.2 .. 1: how much the whole frame is scaled down to fit */
  scale: number
  /** frame size on screen after scaling */
  shown: { w: number; h: number }
}

/** Sizes of the frame for a choice and orientation inside `avail` px (the Preview area minus its padding). */
export function frameLayout(device: 'Phone' | 'Tablet', choice: Pick<FrameChoice, 'w' | 'h'>, rotated: boolean, avail: { w: number; h: number }): FrameLayout {
  const { bezel, radius } = BEZEL[device]
  const screen = screenSize(choice, rotated)
  const outer = { w: screen.w + bezel * 2, h: screen.h + bezel * 2 }
  const raw = Math.min(Math.max(1, avail.w) / outer.w, Math.max(1, avail.h) / outer.h, 1)
  const scale = Math.max(MIN_FRAME_SCALE, Math.floor(raw * 1000) / 1000)
  return { screen, outer, bezel, radius, scale, shown: { w: Math.round(outer.w * scale), h: Math.round(outer.h * scale) } }
}

export const frameDevice = (appW: number, appH: number): Exclude<SizeGroup, 'Desktop'> | null => {
  const d = deviceOf(appW, appH)
  return d === 'Desktop' ? null : d
}

/** "Phone 360×800" (rotated: "800×360"), the scale as a percentage when scaled down */
export function frameCaption(label: string, layout: FrameLayout): string {
  const pct = layout.scale < 1 ? `, shown at ${Math.round(layout.scale * 100)}%` : ''
  return `${label} ${layout.screen.w}×${layout.screen.h}${pct}`
}
