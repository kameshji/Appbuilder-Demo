/** Metadata of the 300 animated icons (react-useanimations catalog.json), indexed for lookups. */
import raw from 'react-useanimations/catalog.json'
import type { Interaction } from 'react-useanimations'

export interface AnimatedIconMeta {
  /** id used in "anim:<id>" and as lib/<id> module name (the catalog's `export`) */
  id: string
  /** website id (kebab-case), also accepted after "anim:" */
  slug: string
  title: string
  category: string
  keywords: string[]
  /** the icon's own interaction */
  interaction: Interaction
  /** static SVG state names inside svg.json[slug] (empty for a few icons) */
  svg: string[]
}

type RawEntry = { id: string; export: string; title: string; category: string; keywords: string[]; interaction: string; svg: string[] }

export const ANIMATED_ICONS: AnimatedIconMeta[] = (raw as RawEntry[]).map((c) => ({
  id: c.export,
  slug: c.id,
  title: c.title,
  category: c.category,
  keywords: c.keywords,
  interaction: c.interaction as Interaction,
  svg: c.svg,
}))

const byId = new Map<string, AnimatedIconMeta>()
const byLower = new Map<string, AnimatedIconMeta>()
for (const m of ANIMATED_ICONS) {
  byId.set(m.id, m)
  byLower.set(m.id.toLowerCase(), m)
  byLower.set(m.slug.toLowerCase(), m)
}

export const ANIMATED_CATEGORIES: string[] = [...new Set(ANIMATED_ICONS.map((m) => m.category))].sort((a, b) => a.localeCompare(b))

export const ANIM_PREFIX = 'anim:'

/** "anim:heart" -> meta. Accepts the export id (loading2) and the website slug (loading-v2), any case. Undefined if not an animated icon. */
export function parseAnimatedName(name: unknown): AnimatedIconMeta | undefined {
  if (typeof name !== 'string') return undefined
  const s = name.trim()
  if (s.length <= ANIM_PREFIX.length || s.slice(0, ANIM_PREFIX.length).toLowerCase() !== ANIM_PREFIX) return undefined
  const key = s.slice(ANIM_PREFIX.length).trim()
  return byId.get(key) ?? byLower.get(key.toLowerCase())
}

export const isAnimatedName = (name: unknown): boolean => typeof name === 'string' && name.trim().toLowerCase().startsWith(ANIM_PREFIX)
