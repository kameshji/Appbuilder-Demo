import { useMemo, type ComponentType, type CSSProperties, type MouseEventHandler } from 'react'
import * as Lucide from 'lucide-react'
import UseAnimations, { type Interaction } from 'react-useanimations'
import { cn } from '@/lib/utils'
import { parseAnimatedName } from './catalog'
import { useAnimation } from './loader'
import { useReducedMotion } from '@/platform/preferences'

type IconComp = ComponentType<{ className?: string; style?: CSSProperties; strokeWidth?: number }>

const NOT_ICONS = /^(createLucideIcon|icons|Icon|LucideProvider|useLucideContext|DynamicIcon|dynamicIconImports)$/i
const lucideBag = Lucide as unknown as Record<string, unknown>

/** lucide-react component for a name ("Plus", "plus", "arrow-right", "arrow_right"); undefined when unknown. */
export function lucideByName(name: string): IconComp | undefined {
  const raw = name.trim()
  if (!raw) return undefined
  const pascal = raw.replace(/(^|[-_ ]+)([A-Za-z0-9])/g, (_m, _s, c: string) => c.toUpperCase())
  for (const key of [raw, pascal, raw.charAt(0).toUpperCase() + raw.slice(1)]) {
    if (NOT_ICONS.test(key)) continue
    const v = lucideBag[key]
    if (v && (typeof v === 'function' || (typeof v === 'object' && '$$typeof' in (v as object)))) return v as IconComp
  }
  return undefined
}

export interface AppIconProps {
  /** lucide name ("Plus") or animated icon ("anim:heart") */
  name: string | null | undefined
  /** px number or CSS length; omit to size by className/style (default 24 when neither sets a width) */
  size?: number | string
  /** icon colour; blank = currentColor */
  color?: string
  /** colour of filled parts (animated icons only) */
  fillColor?: string
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  /** animated icons: override the icon's own interaction */
  interaction?: Interaction
  /** animated click-toggle icons: controlled state (true = end state) */
  active?: boolean
  speed?: number
  autoplay?: boolean
  onClick?: MouseEventHandler<HTMLElement>
  /** rendered when the name is blank or unknown */
  fallback?: IconComp
  'aria-label'?: string
}

const BOX: CSSProperties = { display: 'inline-block', flexShrink: 0, lineHeight: 0, verticalAlign: 'middle' }

function Animated({ id, ...p }: Omit<AppIconProps, 'name' | 'fallback'> & { id: string }) {
  const anim = useAnimation(id)
  // Settings > Appearance > Reduce motion: never loop or autoplay; hover and click effects jump to their end state.
  // (The library already does this by itself when the operating system asks for reduced motion.)
  const still = useReducedMotion()
  const sized = p.size !== undefined || (p.style && p.style.width !== undefined) || !!p.className
  const dim = p.size !== undefined ? { width: p.size, height: p.size } : sized ? {} : { width: 24, height: 24 }
  const box: CSSProperties = { ...BOX, ...dim, ...p.style }
  const hasLabel = !!p['aria-label']
  if (!anim) {
    // reserve the exact box while the icon's data loads (or if it never does): no layout shift
    return <span className={p.className} style={box} data-appicon="loading" aria-hidden={hasLabel ? undefined : true} />
  }
  return (
    <span className={p.className} style={box} data-appicon="animated" data-anim={id}>
      <UseAnimations
        animation={anim}
        size="100%"
        strokeColor={p.color || undefined}
        fillColor={p.fillColor || undefined}
        interaction={p.interaction}
        active={p.active}
        speed={still ? 50 : p.speed}
        autoplay={still ? false : p.autoplay}
        loop={still ? false : undefined}
        onClick={p.onClick}
        aria-label={p['aria-label']}
      />
    </span>
  )
}

/**
 * The one icon component. Static lucide names render lucide; "anim:<id>" renders the animated icon
 * (lazy-loaded on first use). Colour follows currentColor unless `color` is set.
 */
export function AppIcon({ name, fallback, ...p }: AppIconProps) {
  const n = typeof name === 'string' ? name : ''
  const meta = parseAnimatedName(n)
  const C = useMemo(() => (meta ? undefined : lucideByName(n) ?? fallback), [meta, n, fallback])
  if (meta) return <Animated id={meta.id} {...p} />
  if (!C) return null
  return (
    <C
      className={cn(p.className)}
      style={{ ...(p.size !== undefined ? { width: p.size, height: p.size } : {}), ...(p.color ? { color: p.color } : {}), ...p.style }}
      strokeWidth={p.strokeWidth}
    />
  )
}

/* ------------------------------------------------------------------ component adapters for resolveIcon / iconByName */

const compCache = new Map<string, IconComp>()

/**
 * A stable component for an animated icon name ("anim:heart"), shaped like a lucide icon
 * (className / style size it, colour follows text colour). Undefined for any other name.
 * strokeWidth is ignored: the animations carry their own stroke widths.
 */
export function animatedIconComponent(name: unknown): IconComp | undefined {
  const meta = parseAnimatedName(name)
  if (!meta) return undefined
  let C = compCache.get(meta.id)
  if (!C) {
    const full = `anim:${meta.id}`
    C = function AnimatedIconAdapter({ className, style }) {
      return <AppIcon name={full} className={className} style={style} />
    }
    compCache.set(meta.id, C)
  }
  return C
}
