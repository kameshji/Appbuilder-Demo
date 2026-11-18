import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, CircleUser, Heading as HeadingIcon, Minus, Shapes, Smile, Star, Tags, TextQuote, TrendingUp, Users, History } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { alignOf, alignProp, fontWeightOf, recordText, toColor, toNum, toRecords, toText } from '../util'
import { DynIcon, SUCCESS_COLOR, lc, pick, pickText, variantOf } from './helpers'
import { personName, usePeopleNames } from './people'

/* ------------------------------------------------------------------ Heading */

const LEVEL_SIZE = [0, 32, 26, 20, 16]

function HeadingRender({ props }: ControlRenderProps) {
  const level = Math.min(4, Math.max(1, Math.round(toNum(props.Level, 2))))
  const custom = toNum(props.Size, 0)
  const align = alignOf(props.Align)
  return (
    <div
      className="flex size-full items-center overflow-hidden leading-tight"
      style={{
        fontSize: custom > 0 ? custom : LEVEL_SIZE[level],
        fontWeight: fontWeightOf(props.FontWeight),
        color: toColor(props.Color) ?? 'var(--foreground)',
        textAlign: align,
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        letterSpacing: '-0.01em',
      }}
    >
      <span className="max-h-full min-w-0 whitespace-pre-wrap break-words" role="heading" aria-level={level}>
        {toText(props.Text)}
      </span>
    </div>
  )
}

export const Heading: ControlType = {
  type: 'Heading',
  label: 'Heading',
  icon: HeadingIcon,
  category: 'Display',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Heading"' },
    { name: 'Level', kind: 'number', group: 'Style', default: '=2' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=0', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'FontWeight', kind: 'enum', group: 'Style', default: '=FontWeight.Bold', options: ['FontWeight.Normal', 'FontWeight.Semibold', 'FontWeight.Bold'] },
    alignProp,
  ],
  outputs: [],
  defaultSize: { width: 360, height: 44 },
  primaryProp: 'Text',
  render: HeadingRender,
}

/* ------------------------------------------------------------------ RichText (tiny markdown) */

const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split(INLINE).forEach((part, i) => {
    if (!part) return
    const k = `${key}-${i}`
    if (/^\*\*[^*]+\*\*$/.test(part) || /^__[^_]+__$/.test(part)) out.push(<strong key={k}>{inline(part.slice(2, -2), k)}</strong>)
    else if (/^\*[^*\s][^*]*\*$/.test(part) || /^_[^_\s][^_]*_$/.test(part)) out.push(<em key={k}>{inline(part.slice(1, -1), k)}</em>)
    else if (/^`[^`]+`$/.test(part)) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1, -1)}</code>)
    else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(part)) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)!
      out.push(
        SAFE_URL.test(m[2]) ? (
          <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {m[1]}
          </a>
        ) : (
          <span key={k}>{m[1]}</span>
        ),
      )
    } else out.push(part)
  })
  return out
}

function markdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join('\n'), `p${blocks.length}`)}</p>)
    para = []
  }
  const flushList = () => {
    if (!list) return
    const L = list
    const Tag = L.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`l${blocks.length}`} className={cn('ml-5', L.ordered ? 'list-decimal' : 'list-disc')}>
        {L.items.map((t, i) => <li key={i}>{inline(t, `l${blocks.length}-${i}`)}</li>)}
      </Tag>,
    )
    list = null
  }
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (h) {
      flushPara(); flushList()
      const sizes = ['1.5em', '1.3em', '1.15em', '1.05em']
      blocks.push(<div key={`h${blocks.length}`} className="font-semibold leading-tight" style={{ fontSize: sizes[h[1].length - 1] }}>{inline(h[2], `h${blocks.length}`)}</div>)
    } else if (ul || ol) {
      flushPara()
      const ordered = !!ol
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
      list.items.push((ul ?? ol)![1])
    } else if (line.trim() === '') {
      flushPara(); flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara(); flushList()
  return blocks
}

function RichTextRender({ props }: ControlRenderProps) {
  return (
    <div
      className="size-full space-y-2 overflow-hidden whitespace-pre-wrap break-words leading-relaxed [&_p]:whitespace-pre-wrap"
      style={{ fontSize: toNum(props.Size, 14), color: toColor(props.Color) ?? 'var(--foreground)', textAlign: alignOf(props.Align) }}
    >
      {markdown(toText(props.Text))}
    </div>
  )
}

export const RichText: ControlType = {
  type: 'RichText',
  label: 'Rich text',
  icon: TextQuote,
  category: 'Display',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="**Rich text** supports *italic*, [links](https://example.com) and lists:\n- first item\n- second item"' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    alignProp,
  ],
  outputs: [],
  defaultSize: { width: 360, height: 120 },
  primaryProp: 'Text',
  render: RichTextRender,
}

/* ------------------------------------------------------------------ Badge */

function BadgeRender({ props }: ControlRenderProps) {
  const v = variantOf(props.Variant)
  const color = toColor(props.Color)
  const textColor = toColor(props.TextColor)
  return (
    <Badge
      variant={v === 'ghost' ? 'outline' : v}
      className={cn('size-full w-full justify-center truncate rounded-md text-[length:inherit]', v === 'ghost' && 'border-transparent')}
      style={{
        fontSize: toNum(props.Size, 12),
        background: color,
        color: textColor ?? (color ? '#fff' : undefined),
        borderColor: color ? 'transparent' : undefined,
      }}
    >
      <DynIcon name={props.Icon} />
      {toText(props.Text)}
    </Badge>
  )
}

export const BadgeControl: ControlType = {
  type: 'Badge',
  label: 'Badge',
  icon: Tags,
  category: 'Display',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Badge"' },
    { name: 'Variant', kind: 'enum', group: 'Style', default: '=Variant.Default', options: ['Variant.Default', 'Variant.Secondary', 'Variant.Outline', 'Variant.Destructive'] },
    { name: 'Icon', kind: 'icon', group: 'Content', default: '=""', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'TextColor', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Size', kind: 'number', group: 'Style', default: '=12' },
  ],
  outputs: [],
  defaultSize: { width: 72, height: 24 },
  primaryProp: 'Text',
  render: BadgeRender,
}

/* ------------------------------------------------------------------ Avatar / AvatarGroup */

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}
function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

export function AvatarCircle({ src, name, size, ring }: { src: string; name: string; size: string; ring?: boolean }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const hue = hueOf(name)
  const ini = initials(name)
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium', ring && 'ring-2 ring-background')}
      style={{
        width: size,
        height: size,
        fontSize: `calc(${size} * 0.4)`,
        background: src && !failed ? 'var(--muted)' : `oklch(0.7 0.1 ${hue} / 0.28)`,
        color: `oklch(0.55 0.15 ${hue})`,
      }}
    >
      {src && !failed ? (
        <img src={src} alt={name} draggable={false} className="size-full select-none object-cover" onError={() => setFailed(true)} />
      ) : ini ? (
        ini
      ) : (
        <CircleUser className="size-3/5 opacity-70" strokeWidth={1.5} />
      )}
    </span>
  )
}

function AvatarRender({ props }: ControlRenderProps) {
  const size = toNum(props.Size, 0)
  // User: a user id or a record of Users (createdBy, owner, User()): the name comes from the Users system table
  const bound = props.User !== null && props.User !== undefined && props.User !== ''
  const names = usePeopleNames(bound)
  const name = bound ? personName(props.User, names) : toText(props.Name)
  return (
    <div className="flex size-full items-center justify-center" style={{ containerType: 'size' }} title={name}>
      <AvatarCircle src={toText(props.Image).trim()} name={name} size={size > 0 ? `${size}px` : '100cqmin'} />
    </div>
  )
}

export const Avatar: ControlType = {
  type: 'Avatar',
  label: 'Avatar',
  icon: CircleUser,
  category: 'Display',
  props: [
    { name: 'Name', kind: 'text', group: 'Content', default: '="Ada Lovelace"' },
    { name: 'User', kind: 'any', group: 'Data', default: '=Blank()' },
    { name: 'Image', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=0' },
  ],
  outputs: [],
  defaultSize: { width: 48, height: 48 },
  primaryProp: 'Name',
  render: AvatarRender,
}

function AvatarGroupRender({ props }: ControlRenderProps) {
  // Users: a table of user ids or Users records (e.g. followers, assignees); otherwise Items with Name / Image
  const people = Array.isArray(props.Users) ? props.Users : null
  const names = usePeopleNames(!!people)
  const items = people
    ? people.map((v) => ({ Name: personName(v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && 'Value' in v && Object.keys(v).length === 1 ? v.Value : v, names) }))
    : toRecords(props.Items)
  const max = Math.max(1, Math.round(toNum(props.Max, 4)))
  const size = toNum(props.Size, 0)
  const diam = size > 0 ? `${size}px` : '100cqh'
  const shown = items.slice(0, max)
  const extra = items.length - shown.length
  return (
    <div className="flex size-full items-center" style={{ containerType: 'size' }}>
      <div className="flex items-center">
        {shown.map((r, i) => (
          <div key={i} style={{ marginLeft: i === 0 ? 0 : `calc(${diam} * -0.28)` }}>
            <AvatarCircle src={pickText(r, 'Image', 'Photo', 'Picture', 'Avatar')} name={pickText(r, 'Name', 'Title', 'Label') || recordText(r)} size={diam} ring />
          </div>
        ))}
        {extra > 0 && (
          <div style={{ marginLeft: `calc(${diam} * -0.28)` }}>
            <span
              className="inline-flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background"
              style={{ width: diam, height: diam, fontSize: `calc(${diam} * 0.36)` }}
            >
              +{extra}
            </span>
          </div>
        )}
        {items.length === 0 && <span className="text-sm text-muted-foreground">No people</span>}
      </div>
    </div>
  )
}

export const AvatarGroup: ControlType = {
  type: 'AvatarGroup',
  label: 'Avatar group',
  icon: Users,
  category: 'Display',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=Table({Name: "Ada Lovelace"}, {Name: "Grace Hopper"}, {Name: "Alan Turing"}, {Name: "Linus Torvalds"}, {Name: "Margaret Hamilton"})' },
    { name: 'Users', kind: 'table', group: 'Data', default: '=Blank()', simple: false },
    { name: 'Max', kind: 'number', group: 'Style', default: '=4' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=0' },
  ],
  outputs: [],
  defaultSize: { width: 180, height: 40 },
  primaryProp: 'Items',
  render: AvatarGroupRender,
}

/* ------------------------------------------------------------------ Icon */

function IconRender({ props, mode, fire }: ControlRenderProps) {
  const size = Math.max(4, toNum(props.Size, 24))
  const run = mode === 'run'
  return (
    <div
      className={cn('flex size-full items-center justify-center', run && 'cursor-pointer')}
      style={{ color: toColor(props.Color) ?? 'var(--foreground)' }}
      onClick={run ? () => fire('OnSelect') : undefined}
    >
      <DynIcon name={props.Icon} fallback={Smile} style={{ width: size, height: size }} strokeWidth={toNum(props.Thickness, 2)} />
    </div>
  )
}

export const IconControl: ControlType = {
  type: 'Icon',
  label: 'Icon',
  icon: Star,
  category: 'Display',
  props: [
    { name: 'Icon', kind: 'icon', group: 'Content', default: '="Star"' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=24' },
    { name: 'Thickness', kind: 'number', group: 'Style', default: '=2', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [],
  defaultSize: { width: 40, height: 40 },
  primaryProp: 'Icon',
  render: IconRender,
}

/* ------------------------------------------------------------------ Shape */

function ShapeRender({ props }: ControlRenderProps) {
  const kind = lc(props.Kind)
  const fill = toColor(props.Fill) ?? 'var(--primary)'
  const stroke = toColor(props.BorderColor)
  const bw = Math.max(0, toNum(props.BorderWidth, 0))
  if (kind === 'ellipse') {
    return (
      <div
        className="box-border size-full rounded-full"
        style={{ background: fill, border: stroke && bw > 0 ? `${bw}px solid ${stroke}` : undefined }}
      />
    )
  }
  if (kind === 'line') {
    return (
      <svg className="size-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
        <line
          x1="0" y1="50" x2="100" y2="50"
          stroke={stroke ?? fill}
          strokeWidth={Math.max(1, bw || 2)}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (kind === 'triangle') {
    return (
      <svg className="size-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
        <polygon
          points="50,0 100,100 0,100"
          fill={fill}
          stroke={stroke && bw > 0 ? stroke : 'none'}
          strokeWidth={bw}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <div
      className="box-border size-full"
      style={{ background: fill, borderRadius: toNum(props.Radius, 0), border: stroke && bw > 0 ? `${bw}px solid ${stroke}` : undefined }}
    />
  )
}

export const Shape: ControlType = {
  type: 'Shape',
  label: 'Shape',
  icon: Shapes,
  category: 'Display',
  props: [
    { name: 'Kind', kind: 'enum', group: 'Style', default: '="Rectangle"', options: ['"Rectangle"', '"Ellipse"', '"Line"', '"Triangle"'] },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'BorderColor', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'BorderWidth', kind: 'number', group: 'Style', default: '=0' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=0', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 120, height: 120 },
  primaryProp: 'Kind',
  render: ShapeRender,
}

/* ------------------------------------------------------------------ TagList */

function TagListRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const items = toRecords(props.Items)
  const v = variantOf(props.Variant)
  const color = toColor(props.Color)
  const run = mode === 'run'
  const selectedText = toText(outputs.SelectedText)
  return (
    <div className="flex size-full flex-wrap content-start items-start gap-1.5 overflow-hidden">
      {items.map((rec, i) => {
        const text = recordText(rec)
        const active = run && selectedText !== '' && selectedText === text
        return (
          <Badge
            key={i}
            variant={v === 'ghost' ? 'outline' : v}
            asChild={false}
            onClick={run ? () => { setOutput('Selected', rec); setOutput('SelectedText', text); setOutput('SelectedIndex', i + 1); fire('OnSelect') } : undefined}
            className={cn('h-6 px-2.5 text-xs', run && 'cursor-pointer', active && 'ring-2 ring-ring/60')}
            style={{ background: color, color: color ? '#fff' : undefined, borderColor: color ? 'transparent' : undefined }}
          >
            {text}
          </Badge>
        )
      })}
      {items.length === 0 && <span className="text-sm text-muted-foreground">No tags</span>}
    </div>
  )
}

export const TagList: ControlType = {
  type: 'TagList',
  label: 'Tag list',
  icon: Tags,
  category: 'Display',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Design","Build","Ship"]' },
    { name: 'Variant', kind: 'enum', group: 'Style', default: '=Variant.Secondary', options: ['Variant.Default', 'Variant.Secondary', 'Variant.Outline', 'Variant.Destructive'] },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 280, height: 56 },
  primaryProp: 'Items',
  render: TagListRender,
}

/* ------------------------------------------------------------------ StatCard / KPI */

function trendOf(v: string, delta: string): 'up' | 'down' | 'flat' {
  const t = v.trim().toLowerCase()
  if (t === 'up' || t === 'down' || t === 'flat') return t
  const d = delta.trim()
  if (!d) return 'flat'
  if (d.startsWith('-') || d.startsWith('−') || d.startsWith('(')) return 'down'
  if (/^[+\d]/.test(d) && !/^0(\.0+)?%?$/.test(d)) return 'up'
  return 'flat'
}

function StatCardRender({ props }: ControlRenderProps) {
  const delta = toText(props.Delta)
  const trend = trendOf(toText(props.Trend), delta)
  const trendColor = trend === 'up' ? SUCCESS_COLOR : trend === 'down' ? 'var(--destructive)' : 'var(--muted-foreground)'
  const Arrow = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : Minus
  const hasIcon = toText(props.Icon).trim() !== ''
  return (
    <div
      className="box-border flex size-full items-center gap-4 overflow-hidden border bg-card px-5 py-4 text-card-foreground"
      style={{ borderRadius: toNum(props.Radius, 12), background: toColor(props.Fill), boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="truncate text-sm text-muted-foreground">{toText(props.Label)}</div>
        <div className="truncate text-3xl font-semibold leading-none tracking-tight">{toText(props.Value)}</div>
        {delta !== '' && (
          <div className="flex items-center gap-1 text-xs font-medium" style={{ color: trendColor }}>
            <Arrow className="size-3.5" />
            <span>{delta}</span>
            {toText(props.DeltaLabel) !== '' && <span className="font-normal text-muted-foreground">{toText(props.DeltaLabel)}</span>}
          </div>
        )}
      </div>
      {hasIcon && (
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-lg"
          style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
        >
          <DynIcon name={props.Icon} className="size-5" />
        </div>
      )}
    </div>
  )
}

export const StatCard: ControlType = {
  type: 'StatCard',
  label: 'Stat card',
  icon: TrendingUp,
  category: 'Display',
  props: [
    { name: 'Label', kind: 'text', group: 'Content', default: '="Revenue"' },
    { name: 'Value', kind: 'any', group: 'Content', default: '="$12,480"' },
    { name: 'Delta', kind: 'text', group: 'Content', default: '="+12.5%"' },
    { name: 'DeltaLabel', kind: 'text', group: 'Content', default: '="vs last month"', simple: false },
    { name: 'Trend', kind: 'enum', group: 'Style', default: '="Auto"', options: ['"Auto"', '"Up"', '"Down"', '"Flat"'] },
    { name: 'Icon', kind: 'icon', group: 'Content', default: '="DollarSign"' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=12', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 280, height: 112 },
  primaryProp: 'Value',
  render: StatCardRender,
}

/* ------------------------------------------------------------------ Timeline */

function TimelineRender({ props, mode }: ControlRenderProps) {
  const items = toRecords(props.Items)
  if (items.length === 0) {
    return <div className="flex size-full items-center justify-center text-sm text-muted-foreground">No events</div>
  }
  return (
    <div className={cn('size-full', mode === 'design' ? 'overflow-hidden' : 'overflow-y-auto')}>
      {items.map((rec, i) => {
        const last = i === items.length - 1
        const title = pickText(rec, 'Title', 'Label', 'Name') || recordText(rec)
        const desc = pickText(rec, 'Description', 'Text', 'Content')
        const time = pickText(rec, 'Time', 'Date', 'When')
        const icon = pick(rec, 'Icon')
        return (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background text-primary">
                {icon ? <DynIcon name={icon} className="size-3" /> : <span className="size-1.5 rounded-full bg-primary" />}
              </span>
              {!last && <span className="my-1 w-px flex-1 bg-border" />}
            </div>
            <div className={cn('min-w-0 flex-1', !last && 'pb-5')}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="truncate text-sm font-medium">{title}</div>
                {time !== '' && <div className="shrink-0 text-xs text-muted-foreground">{time}</div>}
              </div>
              {desc !== '' && <div className="mt-0.5 text-sm text-muted-foreground">{desc}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export const Timeline: ControlType = {
  type: 'Timeline',
  label: 'Timeline',
  icon: History,
  category: 'Display',
  props: [
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default:
        '=Table({Title: "Order placed", Description: "Payment confirmed", Time: "09:12"}, {Title: "Packed", Description: "Ready for pickup", Time: "11:40"}, {Title: "Delivered", Description: "Left at the front desk", Time: "16:05"})',
    },
  ],
  outputs: [],
  defaultSize: { width: 360, height: 240 },
  primaryProp: 'Items',
  render: TimelineRender,
}

