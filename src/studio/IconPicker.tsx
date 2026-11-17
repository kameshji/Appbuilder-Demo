import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { fx } from '@/fx'
import { AppIcon, ANIMATED_CATEGORIES, ANIMATED_ICONS, parseAnimatedName, type AnimatedIconMeta } from '@/controls/icon'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** Formula for the icon a maker picked: static lucide names keep writing =Icon.<Name>, animated ones ="anim:<id>". */
export const staticIconFormula = (name: string) => `=Icon.${name}`
export const animatedIconFormula = (id: string) => `="anim:${id}"`

/** Icon value (text) behind an icon property formula, or null when the formula is not a plain pick. */
export function iconValueOfFormula(formula: string, parseText: (f: string) => string | null): string | null {
  const m = /^=\s*Icon\.(\w+)\s*$/.exec(formula)
  if (m) return m[1]
  const a = /^=\s*AnimatedIcon\.(\w+)\s*$/.exec(formula)
  if (a) return `anim:${a[1].charAt(0).toLowerCase()}${a[1].slice(1)}`
  return parseText(formula)
}

/* ------------------------------------------------------------------ static thumbnails (svg.json) */

type SvgMap = Record<string, Record<string, string>>
let svgPromise: Promise<SvgMap> | null = null
let svgData: SvgMap | null = null
function loadSvgs(): Promise<SvgMap> {
  svgPromise ??= import('react-useanimations/svg.json').then((m) => (svgData = ((m as { default?: SvgMap }).default ?? (m as unknown as SvgMap))))
  return svgPromise
}

const thumbCache = new Map<string, string | null>()
/** data: URL of the icon's first static SVG state (trusted package asset, rendered as an image, never as markup). */
function thumbUrl(meta: AnimatedIconMeta): string | null {
  if (thumbCache.has(meta.id)) return thumbCache.get(meta.id)!
  const states = svgData?.[meta.slug]
  const svg = states ? (states[meta.svg[0]] ?? Object.values(states)[0]) : undefined
  const url = svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : null
  if (svgData) thumbCache.set(meta.id, url)
  return url
}

/** Static preview. A CSS mask over the data-URL image lets it follow the text colour (theme aware). */
function Thumb({ meta, ready }: { meta: AnimatedIconMeta; ready: boolean }) {
  const url = ready ? thumbUrl(meta) : null
  if (!ready) return <span className="size-6" />
  if (!url) return <AppIcon name={`anim:${meta.id}`} size={24} interaction="loop" autoplay={false} />
  return (
    <span
      aria-hidden
      className="block size-6 bg-current"
      style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")`, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  )
}

const INTERACTION_LABEL: Record<string, string> = {
  loop: 'loop',
  hover: 'hover',
  'hover-loop': 'hover loop',
  'hover-replay': 'hover once',
  'click-replay': 'click',
  'click-toggle': 'toggle',
}

const PAGE = 60

function AnimatedGrid({ value, q, onPick }: { value: string; q: string; onPick: (id: string) => void }) {
  const [cat, setCat] = useState<string>('All')
  const [shown, setShown] = useState(PAGE)
  const [hover, setHover] = useState<string | null>(null)
  const [ready, setReady] = useState(svgData !== null)
  useEffect(() => {
    if (!svgData) void loadSvgs().then(() => setReady(true))
  }, [])
  const current = parseAnimatedName(value)?.id
  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return ANIMATED_ICONS.filter((m) => {
      if (cat !== 'All' && m.category !== cat) return false
      if (!terms.length) return true
      const hay = `${m.id} ${m.slug} ${m.title} ${m.category} ${m.keywords.join(' ')} ${m.interaction}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [q, cat])
  useEffect(() => {
    setShown(PAGE)
    setHover(null)
  }, [q, cat])
  const box = useRef<HTMLDivElement>(null)
  const more = () => {
    const el = box.current
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) setShown((n) => (n < list.length ? n + PAGE : n))
  }
  return (
    <div data-testid="anim-picker">
      <div className="mb-2 flex max-h-[52px] flex-wrap gap-1 overflow-y-auto" data-testid="anim-categories">
        {['All', ...ANIMATED_CATEGORIES].map((c) => (
          <button
            key={c}
            type="button"
            data-testid={`anim-cat-${c}`}
            onClick={() => setCat(c)}
            className={cn('rounded-full border px-2 py-0.5 text-[10px] leading-4', cat === c ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent')}
          >
            {c}
          </button>
        ))}
      </div>
      <div ref={box} onScroll={more} className="grid max-h-60 grid-cols-5 content-start gap-1 overflow-auto" data-testid="anim-grid">
        {list.slice(0, shown).map((m) => (
          <button
            key={m.id}
            type="button"
            title={`${m.title} (${m.category}, ${INTERACTION_LABEL[m.interaction] ?? m.interaction})`}
            data-testid={`anim-${m.id}`}
            data-selected={m.id === current ? 'true' : undefined}
            onClick={() => onPick(m.id)}
            onPointerEnter={() => setHover(m.id)}
            onPointerLeave={() => setHover((h) => (h === m.id ? null : h))}
            onFocus={() => setHover(m.id)}
            onBlur={() => setHover((h) => (h === m.id ? null : h))}
            className={cn(
              'flex h-[54px] flex-col items-center justify-center gap-0.5 rounded-md border border-transparent hover:border-border hover:bg-accent [content-visibility:auto]',
              m.id === current && 'border-primary bg-primary/10 text-primary',
            )}
          >
            {/* pointer-events-none: the button itself is always the hit target, so swapping the preview never eats a click */}
            <span className="pointer-events-none relative block size-6">
              <span className={cn('absolute inset-0 block', hover === m.id && 'opacity-0')}>
                <Thumb meta={m} ready={ready} />
              </span>
              {hover === m.id && (
                <span className="absolute inset-0 block">
                  <AppIcon name={`anim:${m.id}`} size={24} interaction="loop" />
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-0.5 text-[8px] leading-3 text-muted-foreground">{INTERACTION_LABEL[m.interaction] ?? m.interaction}</span>
          </button>
        ))}
        {list.length === 0 && <p className="col-span-5 p-2 text-center text-xs text-muted-foreground">No animated icons</p>}
        {shown < list.length && <div className="col-span-5 py-1 text-center text-[10px] text-muted-foreground">Scroll for more ({list.length - shown})</div>}
      </div>
      <div className="mt-1.5 h-4 truncate text-[10px] text-muted-foreground" data-testid="anim-caption">
        {list.length} icons{hover ? ` - ${ANIMATED_ICONS.find((m) => m.id === hover)?.title ?? ''}` : ''}
      </div>
    </div>
  )
}

function StaticGrid({ value, q, onPick }: { value: string; q: string; onPick: (name: string) => void }) {
  let names: string[] = []
  try {
    names = fx.enums().Icon ?? []
  } catch {
    names = []
  }
  const list = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="grid max-h-60 grid-cols-7 gap-1 overflow-auto" data-testid="static-grid">
      {list.map((n) => (
        <button
          key={n}
          type="button"
          title={n}
          data-testid={`icon-${n}`}
          onClick={() => onPick(n)}
          className={cn('grid size-8 place-items-center rounded-md border border-transparent hover:border-border hover:bg-accent', n === value && 'border-primary bg-primary/10 text-primary')}
        >
          <AppIcon name={n} size={16} fallback={undefined} />
        </button>
      ))}
      {list.length === 0 && <p className="col-span-7 p-2 text-center text-xs text-muted-foreground">No icons</p>}
    </div>
  )
}

/**
 * Icon property editor: a trigger showing the current icon and a popover with a Static (lucide) and an
 * Animated (300 useAnimations icons) tab. `onChange` receives the complete formula to store.
 */
export function IconPicker({ value, onChange, testId }: { value: string; onChange: (formula: string) => void; testId: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'static' | 'animated'>(parseAnimatedName(value) ? 'animated' : 'static')
  const meta = parseAnimatedName(value)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setTab(parseAnimatedName(value) ? 'animated' : 'static')
          setQ('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" data-testid={testId} className="flex h-7 w-full items-center gap-2 rounded-md border border-input bg-background px-1.5 text-left text-xs hover:bg-accent/50">
          {value && (meta || /^[A-Za-z][A-Za-z0-9]*$/.test(value)) ? (
            <span className="grid size-4 place-items-center text-primary">
              <AppIcon name={value} size={16} />
            </span>
          ) : (
            <span className="size-4 rounded border border-dashed border-border" />
          )}
          <span className="truncate">{meta ? `${meta.title} (animated)` : value || 'Choose an icon'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[316px] p-2" data-testid="icon-popover">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'static' | 'animated')} className="gap-2">
          <TabsList className="w-full">
            <TabsTrigger value="static" data-testid="icon-tab-static">Static</TabsTrigger>
            <TabsTrigger value="animated" data-testid="icon-tab-animated">Animated</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative my-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'animated' ? 'Search title or keyword' : 'Search icons'} className="h-7 pl-6 text-xs" data-testid="icon-search" autoFocus />
        </div>
        {tab === 'static' ? (
          <StaticGrid
            value={value}
            q={q}
            onPick={(n) => {
              onChange(staticIconFormula(n))
              setOpen(false)
            }}
          />
        ) : (
          <AnimatedGrid
            value={value}
            q={q}
            onPick={(id) => {
              onChange(animatedIconFormula(id))
              setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
