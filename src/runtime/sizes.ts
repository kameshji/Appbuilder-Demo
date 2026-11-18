/**
 * Design-size presets for apps (New app dialog, Start with data, App settings, the Studio viewport menu) and the
 * one size rule the client applies. Pure: no React. The platform and the server accept any size between 200 and
 * 16000 px per side, landscape or portrait.
 */

export type SizeGroup = 'Desktop' | 'Phone' | 'Tablet'

export interface SizePreset {
  id: string
  group: SizeGroup
  label: string
  w: number
  h: number
}

export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: 'fhd', group: 'Desktop', label: 'Full HD', w: 1920, h: 1080 },
  { id: '2k', group: 'Desktop', label: '2K', w: 2560, h: 1440 },
  { id: 'phone', group: 'Phone', label: 'Phone', w: 360, h: 800 },
  { id: 'phone-390', group: 'Phone', label: 'Phone (large)', w: 390, h: 844 },
  { id: 'phone-412', group: 'Phone', label: 'Phone (tall)', w: 412, h: 915 },
  { id: 'tablet-portrait', group: 'Tablet', label: 'Tablet portrait', w: 800, h: 1280 },
  { id: 'tablet-landscape', group: 'Tablet', label: 'Tablet landscape', w: 1280, h: 800 },
]

export const SIZE_GROUPS: readonly SizeGroup[] = ['Desktop', 'Phone', 'Tablet']
/** the preset picked when the maker chooses the Phone group */
export const DEFAULT_PHONE = 'phone'
export const DEFAULT_TABLET = 'tablet-portrait'
export const DEFAULT_DESKTOP = 'fhd'

export const MIN_SIDE = 320
export const MAX_SIDE = 7680

export const presetById = (id: string): SizePreset | undefined => SIZE_PRESETS.find((p) => p.id === id)
export const presetOf = (w: number, h: number): SizePreset | undefined => SIZE_PRESETS.find((p) => p.w === w && p.h === h)
export const isPortrait = (w: number, h: number): boolean => h > w

/** what kind of device a design size is for (presets by group; otherwise by shape and size) */
export function deviceOf(w: number, h: number): SizeGroup {
  const p = presetOf(w, h)
  if (p) return p.group
  const short = Math.min(w, h)
  if (short < 600) return 'Phone'
  if (short < 1000) return 'Tablet'
  return 'Desktop'
}

/** null when the size is valid, otherwise the message to show */
export function sizeError(w: number, h: number): string | null {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 'Width and height must be numbers.'
  if (w < MIN_SIDE || h < MIN_SIDE) return `Width and height must be at least ${MIN_SIDE} px.`
  if (w > MAX_SIDE || h > MAX_SIDE) return `Width and height must be at most ${MAX_SIDE} px.`
  return null
}

export const sizeLabel = (p: SizePreset) => `${p.label} ${p.w}×${p.h}`
