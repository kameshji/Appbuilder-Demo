import { Columns3, Grid3x3, Minus, Rows3, ScrollText, SquareDashed, SquareStack } from 'lucide-react'
import type { ControlRenderProps, ControlType, PropMeta } from '@/contracts'
import { cn } from '@/lib/utils'
import { borderStyle, toBool, toColor, toNum, toText } from '../util'
import { LayoutBox, layoutProps, orientationOf, type Layout } from './helpers'

/* ---- Row / Column / Grid: transparent layout containers ---- */

function FlowRender({ props, mode, children }: ControlRenderProps) {
  return (
    <LayoutBox
      props={props}
      mode={mode}
      className="size-full"
      style={{ background: toColor(props.Fill), borderRadius: toNum(props.Radius, 0) || undefined }}
    >
      {children}
    </LayoutBox>
  )
}

function flowControl(type: 'Row' | 'Column' | 'Grid', layout: Layout, icon: ControlType['icon'], size: { width: number; height: number }): ControlType {
  const props: PropMeta[] = [
    ...layoutProps({ layout, gap: 16, padding: 0 }),
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.Transparent' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=0', simple: false },
  ]
  return {
    type,
    label: type,
    icon,
    category: 'Layout',
    props,
    outputs: [],
    defaultSize: size,
    isContainer: true,
    primaryProp: 'Gap',
    render: FlowRender,
  }
}

export const Row = flowControl('Row', 'row', Rows3, { width: 480, height: 96 })
export const Column = flowControl('Column', 'column', Columns3, { width: 240, height: 320 })
export const Grid = flowControl('Grid', 'grid', Grid3x3, { width: 480, height: 320 })

/* ---- Card ---- */

function CardRender({ props, mode, children }: ControlRenderProps) {
  const design = mode === 'design'
  const title = toText(props.Title)
  const desc = toText(props.Description)
  const showHeader = toBool(props.ShowHeader, true) && (title !== '' || desc !== '')
  return (
    <div
      className="box-border flex size-full flex-col border bg-card text-card-foreground"
      style={{
        background: toColor(props.Fill),
        borderRadius: toNum(props.Radius, 12),
        overflow: design ? 'visible' : 'hidden',
        boxShadow: toBool(props.Shadow, true) ? '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)' : undefined,
        ...(toColor(props.BorderColor) ? borderStyle(toColor(props.BorderColor), toNum(props.BorderWidth, 1)) : {}),
      }}
    >
      {showHeader && (
        <div className="shrink-0 px-5 pt-5 pb-2">
          {title !== '' && <div className="text-base font-semibold leading-tight">{title}</div>}
          {desc !== '' && <div className="mt-1 text-sm text-muted-foreground">{desc}</div>}
        </div>
      )}
      <LayoutBox props={props} mode={mode} className="min-h-0 w-full flex-1">
        {children}
      </LayoutBox>
    </div>
  )
}

export const Card: ControlType = {
  type: 'Card',
  label: 'Card',
  icon: SquareStack,
  category: 'Layout',
  props: [
    { name: 'Title', kind: 'text', group: 'Content', default: '="Card title"' },
    { name: 'Description', kind: 'text', group: 'Content', default: '=""' },
    { name: 'ShowHeader', kind: 'boolean', group: 'Content', default: '=true' },
    ...layoutProps({ layout: 'manual', gap: 16, padding: 0 }),
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=12' },
    { name: 'BorderColor', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'BorderWidth', kind: 'number', group: 'Style', default: '=1', simple: false },
    { name: 'Shadow', kind: 'boolean', group: 'Style', default: '=true' },
  ],
  outputs: [],
  defaultSize: { width: 360, height: 240 },
  isContainer: true,
  primaryProp: 'Title',
  render: CardRender,
}

/* ---- ScrollArea ---- */

function ScrollAreaRender({ props, mode, children }: ControlRenderProps) {
  const design = mode === 'design'
  const showBar = toBool(props.ShowScrollbar, true)
  return (
    <LayoutBox
      props={props}
      mode={mode}
      className={cn('size-full', !showBar && '[&::-webkit-scrollbar]:hidden')}
      style={{
        background: toColor(props.Fill),
        overflow: design ? 'hidden' : 'auto',
        scrollbarWidth: showBar ? undefined : 'none',
      }}
    >
      {children}
    </LayoutBox>
  )
}

export const ScrollArea: ControlType = {
  type: 'ScrollArea',
  label: 'Scroll area',
  icon: ScrollText,
  category: 'Layout',
  props: [
    ...layoutProps({ layout: 'column', gap: 12, padding: 0 }),
    { name: 'ShowScrollbar', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.Transparent' },
  ],
  outputs: [],
  defaultSize: { width: 360, height: 280 },
  isContainer: true,
  primaryProp: 'LayoutMode',
  render: ScrollAreaRender,
}

/* ---- Divider ---- */

function DividerRender({ props }: ControlRenderProps) {
  const vertical = orientationOf(props.Orientation, 'horizontal') === 'vertical'
  const color = toColor(props.Color) ?? 'var(--border)'
  const t = Math.max(1, toNum(props.Thickness, 1))
  const label = toText(props.Label)
  if (vertical) {
    return (
      <div className="flex size-full justify-center">
        <div style={{ width: t, height: '100%', background: color }} />
      </div>
    )
  }
  return (
    <div className="flex size-full items-center gap-3">
      <div className="flex-1" style={{ height: t, background: color }} />
      {label !== '' && <span className="shrink-0 text-xs text-muted-foreground">{label}</span>}
      {label !== '' && <div className="flex-1" style={{ height: t, background: color }} />}
    </div>
  )
}

export const Divider: ControlType = {
  type: 'Divider',
  label: 'Divider',
  icon: Minus,
  category: 'Layout',
  props: [
    { name: 'Orientation', kind: 'enum', group: 'Style', default: '=Orientation.Horizontal', options: ['Orientation.Horizontal', 'Orientation.Vertical'] },
    { name: 'Label', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'Thickness', kind: 'number', group: 'Style', default: '=1' },
  ],
  outputs: [],
  defaultSize: { width: 320, height: 24 },
  primaryProp: 'Orientation',
  render: DividerRender,
}

/* ---- Spacer ---- */

function SpacerRender({ mode }: ControlRenderProps) {
  if (mode !== 'design') return <div className="size-full" />
  return (
    <div className="flex size-full items-center justify-center rounded border border-dashed border-muted-foreground/30 text-[10px] text-muted-foreground/60">
      Spacer
    </div>
  )
}

export const Spacer: ControlType = {
  type: 'Spacer',
  label: 'Spacer',
  icon: SquareDashed,
  category: 'Layout',
  props: [],
  outputs: [],
  defaultSize: { width: 80, height: 24 },
  primaryProp: 'Width',
  render: SpacerRender,
}
