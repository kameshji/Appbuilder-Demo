import { CircleCheck, CircleX, Gauge, Inbox, Info, Loader, LoaderCircle, OctagonAlert, Square, TriangleAlert, X } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toBool, toColor, toNum, toText } from '../util'
import { DynIcon, SUCCESS_COLOR, WARNING_COLOR, lc } from './helpers'

/* ------------------------------------------------------------------ Progress */

function pct(props: Record<string, unknown>): number {
  const max = toNum(props.Max as never, 100)
  const v = toNum(props.Value as never, 0)
  return max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0
}

function ProgressRender({ props }: ControlRenderProps) {
  const p = pct(props)
  const thickness = Math.max(2, toNum(props.Thickness, 8))
  const color = toColor(props.Color) ?? 'var(--primary)'
  return (
    <div className="flex size-full items-center gap-3">
      <div
        role="progressbar"
        aria-valuenow={Math.round(p)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative w-full flex-1 overflow-hidden rounded-full"
        style={{ height: thickness, background: toColor(props.TrackColor) ?? 'var(--muted)' }}
      >
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${p}%`, background: color }} />
      </div>
      {toBool(props.ShowLabel, false) && <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{Math.round(p)}%</span>}
    </div>
  )
}

export const ProgressControl: ControlType = {
  type: 'Progress',
  label: 'Progress',
  icon: Gauge,
  category: 'Feedback',
  props: [
    { name: 'Value', kind: 'number', group: 'Data', default: '=40' },
    { name: 'Max', kind: 'number', group: 'Data', default: '=100' },
    { name: 'ShowLabel', kind: 'boolean', group: 'Content', default: '=false' },
    { name: 'Thickness', kind: 'number', group: 'Style', default: '=8' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'TrackColor', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 280, height: 24 },
  primaryProp: 'Value',
  render: ProgressRender,
}

/* ------------------------------------------------------------------ CircularProgress */

function CircularProgressRender({ props }: ControlRenderProps) {
  const p = pct(props)
  const t = Math.min(30, Math.max(2, toNum(props.Thickness, 8)))
  const r = 50 - t / 2
  const c = 2 * Math.PI * r
  return (
    <div className="relative flex size-full items-center justify-center" style={{ containerType: 'size' }}>
      <svg viewBox="0 0 100 100" className="size-full" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth={t} style={{ stroke: toColor(props.TrackColor) ?? 'var(--muted)' }} />
        <circle
          cx="50" cy="50" r={r} fill="none" strokeWidth={t} strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p / 100)}
          transform="rotate(-90 50 50)"
          style={{ stroke: toColor(props.Color) ?? 'var(--primary)', transition: 'stroke-dashoffset 300ms' }}
        />
      </svg>
      {toBool(props.ShowLabel, true) && (
        <span className="absolute font-semibold tabular-nums" style={{ fontSize: '22cqmin' }}>
          {Math.round(p)}%
        </span>
      )}
    </div>
  )
}

export const CircularProgress: ControlType = {
  type: 'CircularProgress',
  label: 'Circular progress',
  icon: LoaderCircle,
  category: 'Feedback',
  props: [
    { name: 'Value', kind: 'number', group: 'Data', default: '=65' },
    { name: 'Max', kind: 'number', group: 'Data', default: '=100' },
    { name: 'ShowLabel', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'Thickness', kind: 'number', group: 'Style', default: '=8' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'TrackColor', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 96, height: 96 },
  primaryProp: 'Value',
  render: CircularProgressRender,
}

/* ------------------------------------------------------------------ Spinner */

function SpinnerRender({ props, mode }: ControlRenderProps) {
  const size = Math.max(8, toNum(props.Size, 28))
  const label = toText(props.Label)
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2" style={{ color: toColor(props.Color) ?? 'var(--primary)' }}>
      <span
        role="status"
        aria-label="Loading"
        className={cn('inline-block rounded-full border-current border-t-transparent', mode === 'run' && 'animate-spin')}
        style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 10)), borderStyle: 'solid' }}
      />
      {label !== '' && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  )
}

export const Spinner: ControlType = {
  type: 'Spinner',
  label: 'Spinner',
  icon: Loader,
  category: 'Feedback',
  props: [
    { name: 'Size', kind: 'number', group: 'Style', default: '=28' },
    { name: 'Label', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
  ],
  outputs: [],
  defaultSize: { width: 96, height: 64 },
  primaryProp: 'Size',
  render: SpinnerRender,
}

/* ------------------------------------------------------------------ Skeleton */

function SkeletonRender({ props, mode }: ControlRenderProps) {
  const kind = lc(props.Kind)
  const anim = toBool(props.Animate, true) && mode === 'run'
  const base = cn('bg-muted', anim && 'animate-pulse')
  const fill = toColor(props.Fill)
  if (kind === 'circle') return <div className={cn('size-full rounded-full', base)} style={{ background: fill }} />
  if (kind === 'text') {
    return (
      <div className="flex size-full flex-col justify-center gap-2">
        {[100, 92, 64].map((w, i) => (
          <div key={i} className={cn('h-3 rounded-full', base)} style={{ width: `${w}%`, background: fill }} />
        ))}
      </div>
    )
  }
  return <div className={cn('size-full', base)} style={{ borderRadius: toNum(props.Radius, 8), background: fill }} />
}

export const Skeleton: ControlType = {
  type: 'Skeleton',
  label: 'Skeleton',
  icon: Square,
  category: 'Feedback',
  props: [
    { name: 'Kind', kind: 'enum', group: 'Style', default: '="Rectangle"', options: ['"Rectangle"', '"Circle"', '"Text"'] },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=8' },
    { name: 'Animate', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 240, height: 80 },
  primaryProp: 'Kind',
  render: SkeletonRender,
}

/* ------------------------------------------------------------------ Alert */

type AlertKind = 'info' | 'success' | 'warning' | 'error'
function alertKind(v: string): AlertKind {
  const s = v.trim().toLowerCase()
  if (s === 'success') return 'success'
  if (s === 'warning' || s === 'warn') return 'warning'
  if (s === 'error' || s === 'destructive' || s === 'danger') return 'error'
  return 'info'
}
const ALERT_ACCENT: Record<AlertKind, string> = {
  info: 'var(--primary)',
  success: SUCCESS_COLOR,
  warning: WARNING_COLOR,
  error: 'var(--destructive)',
}
const ALERT_ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, error: OctagonAlert }

function AlertRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const dismissed = run && outputs.Dismissed === true
  const kind = alertKind(toText(props.Variant))
  const accent = ALERT_ACCENT[kind]
  const title = toText(props.Title)
  const text = toText(props.Text)
  const Fallback = ALERT_ICON[kind]
  if (dismissed) return null
  return (
    <div
      role="alert"
      className="box-border flex size-full items-start gap-3 overflow-hidden rounded-lg border px-4 py-3 text-sm"
      style={{
        borderColor: `color-mix(in oklch, ${accent} 35%, transparent)`,
        background: `color-mix(in oklch, ${accent} 9%, var(--background))`,
        color: 'var(--foreground)',
      }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: accent }}>
        <DynIcon name={props.Icon} fallback={Fallback} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {title !== '' && <div className="font-medium leading-snug">{title}</div>}
        {text !== '' && <div className={cn('text-muted-foreground', title !== '' && 'mt-0.5')}>{text}</div>}
      </div>
      {toBool(props.Dismissible, false) && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={run ? () => { setOutput('Dismissed', true); fire('OnDismiss') } : undefined}
          className="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export const Alert: ControlType = {
  type: 'Alert',
  label: 'Alert',
  icon: CircleX,
  category: 'Feedback',
  props: [
    { name: 'Title', kind: 'text', group: 'Content', default: '="Heads up"' },
    { name: 'Text', kind: 'text', group: 'Content', default: '="Something you should know about."' },
    { name: 'Variant', kind: 'enum', group: 'Style', default: '="Info"', options: ['"Info"', '"Success"', '"Warning"', '"Error"'] },
    { name: 'Icon', kind: 'icon', group: 'Content', default: '=""', simple: false },
    { name: 'Dismissible', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'OnDismiss', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Dismissed', initial: false }],
  defaultSize: { width: 420, height: 72 },
  primaryProp: 'Text',
  render: AlertRender,
}

/* ------------------------------------------------------------------ EmptyState */

function EmptyStateRender({ props, mode, fire }: ControlRenderProps) {
  const action = toText(props.ActionText)
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 overflow-hidden px-4 text-center">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <DynIcon name={props.Icon} fallback={Inbox} className="size-6" strokeWidth={1.5} />
      </span>
      <div className="min-w-0">
        <div className="text-base font-semibold">{toText(props.Title)}</div>
        {toText(props.Description) !== '' && <div className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{toText(props.Description)}</div>}
      </div>
      {action !== '' && (
        <Button size="sm" className={mode === 'design' ? 'pointer-events-none' : undefined} onClick={mode === 'run' ? () => fire('OnAction') : undefined}>
          {action}
        </Button>
      )}
    </div>
  )
}

export const EmptyState: ControlType = {
  type: 'EmptyState',
  label: 'Empty state',
  icon: Inbox,
  category: 'Feedback',
  props: [
    { name: 'Icon', kind: 'icon', group: 'Content', default: '="Inbox"' },
    { name: 'Title', kind: 'text', group: 'Content', default: '="Nothing here yet"' },
    { name: 'Description', kind: 'text', group: 'Content', default: '="Items you add will show up here."' },
    { name: 'ActionText', kind: 'text', group: 'Content', default: '=""' },
    { name: 'OnAction', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [],
  defaultSize: { width: 360, height: 220 },
  primaryProp: 'Title',
  render: EmptyStateRender,
}
