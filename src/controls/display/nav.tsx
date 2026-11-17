import { useEffect } from 'react'
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal, PanelLeft, PanelTop, Route } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { recordText, toBool, toColor, toNum, toRecords, toText } from '../util'
import { DynIcon, boxStyle, orientationOf, pick, pickText, useSelection } from './helpers'

/* ------------------------------------------------------------------ Breadcrumb */

function BreadcrumbRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const items = toRecords(props.Items)
  const run = mode === 'run'
  return (
    <nav aria-label="Breadcrumb" className={cn('flex size-full items-center overflow-hidden', !run && 'pointer-events-none')}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
        {items.map((rec, i) => {
          const last = i === items.length - 1
          const text = recordText(rec)
          return (
            <li key={i} className="inline-flex items-center gap-1.5">
              {last ? (
                <span aria-current="page" className="font-medium text-foreground">{text}</span>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => { setOutput('Selected', rec); setOutput('SelectedText', text); setOutput('SelectedIndex', i + 1); fire('OnSelect') }}
                >
                  {text}
                </button>
              )}
              {!last && <ChevronRight className="size-3.5 text-muted-foreground/70" />}
            </li>
          )
        })}
        {items.length === 0 && <li className="text-muted-foreground">No path</li>}
      </ol>
    </nav>
  )
}

export const Breadcrumb: ControlType = {
  type: 'Breadcrumb',
  label: 'Breadcrumb',
  icon: ChevronsRight,
  category: 'Navigation',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Home","Library","Data"]' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 320, height: 28 },
  primaryProp: 'Items',
  render: BreadcrumbRender,
}

/* ------------------------------------------------------------------ Pagination */

type PageItem = number | 'gap-l' | 'gap-r'
function pageItems(page: number, count: number, siblings: number): PageItem[] {
  const total = siblings * 2 + 5
  if (count <= total) return Array.from({ length: count }, (_, i) => i + 1)
  const left = Math.max(page - siblings, 2)
  const right = Math.min(page + siblings, count - 1)
  const out: PageItem[] = [1]
  if (left > 2) out.push('gap-l')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < count - 1) out.push('gap-r')
  out.push(count)
  return out
}

function PaginationRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const total = Math.max(0, Math.round(toNum(props.Total, 0)))
  const size = Math.max(1, Math.round(toNum(props.PageSize, 10)))
  const count = Math.max(1, Math.ceil(total / size))
  const cur = typeof outputs.Page === 'number' ? outputs.Page : 1
  const page = Math.min(count, Math.max(1, Math.round(cur)))

  const write = (p: number) => {
    setOutput('Page', p)
    setOutput('Skip', (p - 1) * size)
  }
  useEffect(() => {
    if (cur !== page || outputs.Skip !== (page - 1) * size || outputs.PageCount !== count) {
      write(page)
      setOutput('PageCount', count)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, page, size, count, outputs.Skip, outputs.PageCount])

  const go = (p: number) => {
    const np = Math.min(count, Math.max(1, p))
    if (np === page) return
    write(np)
    fire('OnChange')
  }
  const edges = toBool(props.ShowEdges, true)
  const sib = Math.max(0, Math.round(toNum(props.Siblings, 1)))
  return (
    <div className={cn('flex size-full items-center justify-center gap-1', !run && 'pointer-events-none')}>
      {edges && (
        <Button variant="ghost" size="icon-sm" aria-label="First page" disabled={page <= 1} onClick={() => go(1)}>
          <ChevronsLeft />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>
        <ChevronLeft />
      </Button>
      {pageItems(page, count, sib).map((it, i) =>
        typeof it === 'number' ? (
          <Button
            key={i}
            size="icon-sm"
            variant={it === page ? 'default' : 'ghost'}
            aria-current={it === page ? 'page' : undefined}
            className="min-w-7 w-auto px-1.5 text-xs tabular-nums"
            onClick={() => go(it)}
          >
            {it}
          </Button>
        ) : (
          <span key={i} className="inline-flex size-7 items-center justify-center text-muted-foreground"><MoreHorizontal className="size-4" /></span>
        ),
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={page >= count} onClick={() => go(page + 1)}>
        <ChevronRight />
      </Button>
      {edges && (
        <Button variant="ghost" size="icon-sm" aria-label="Last page" disabled={page >= count} onClick={() => go(count)}>
          <ChevronsRight />
        </Button>
      )}
    </div>
  )
}

export const Pagination: ControlType = {
  type: 'Pagination',
  label: 'Pagination',
  icon: MoreHorizontal,
  category: 'Navigation',
  props: [
    { name: 'Total', kind: 'number', group: 'Data', default: '=100' },
    { name: 'PageSize', kind: 'number', group: 'Data', default: '=10' },
    { name: 'ShowEdges', kind: 'boolean', group: 'Style', default: '=true', simple: false },
    { name: 'Siblings', kind: 'number', group: 'Style', default: '=1', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Page', initial: 1 },
    { name: 'Skip', initial: 0 },
    { name: 'PageCount', initial: 1 },
  ],
  defaultSize: { width: 420, height: 36 },
  primaryProp: 'Total',
  render: PaginationRender,
}

/* ------------------------------------------------------------------ NavMenu */

function NavMenuRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const items = toRecords(props.Items)
  const { index, select } = useSelection(items, toText(props.Default), outputs, setOutput)
  const collapsible = toBool(props.Collapsible, false)
  const forced = toBool(props.Collapsed, false)
  const local = outputs.Collapsed === true
  const collapsed = forced || (collapsible && local)
  const title = toText(props.Title)

  useEffect(() => {
    if (forced !== (outputs.Collapsed === true) && !collapsible) setOutput('Collapsed', forced)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced, collapsible])

  const click = (i: number) => {
    select(i)
    setOutput('SelectedScreen', pickText(items[i] ?? {}, 'Screen'))
    fire('OnSelect')
  }

  return (
    <div
      className={cn('box-border flex size-full flex-col overflow-hidden border-r bg-card text-card-foreground', !run && 'pointer-events-none')}
      style={{ background: toColor(props.Fill) }}
    >
      {(title !== '' || collapsible) && (
        <div className={cn('flex shrink-0 items-center gap-2 px-3 pt-3 pb-1', collapsed && 'justify-center px-0')}>
          {!collapsed && title !== '' && <div className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</div>}
          {collapsible && (
            <Button variant="ghost" size="icon-sm" aria-label="Toggle sidebar" onClick={() => setOutput('Collapsed', !local)}>
              <PanelLeft />
            </Button>
          )}
        </div>
      )}
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {items.map((rec, i) => {
          const active = i === index
          const label = pickText(rec, 'Label', 'Title', 'Name', 'Text') || recordText(rec)
          const badge = pickText(rec, 'Badge', 'Count')
          return (
            <button
              key={i}
              type="button"
              title={collapsed ? label : undefined}
              onClick={() => click(i)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium outline-none transition-colors',
                collapsed && 'justify-center px-0',
                active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <DynIcon name={pick(rec, 'Icon')} className="size-4 shrink-0" />
              {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
              {!collapsed && badge !== '' && <span className="rounded-full bg-primary/10 px-1.5 text-[11px] text-primary">{badge}</span>}
            </button>
          )
        })}
        {items.length === 0 && <div className="px-2 py-3 text-sm text-muted-foreground">No items</div>}
      </nav>
    </div>
  )
}

export const NavMenu: ControlType = {
  type: 'NavMenu',
  label: 'Nav menu',
  icon: PanelLeft,
  category: 'Navigation',
  props: [
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default: '=Table({Label: "Home", Icon: "House", Screen: "Home"}, {Label: "Reports", Icon: "ChartColumn", Screen: "Reports"}, {Label: "Settings", Icon: "Settings", Screen: "Settings"})',
    },
    { name: 'Default', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Title', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Collapsible', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Collapsed', kind: 'boolean', group: 'Behaviour', default: '=false', simple: false },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
    { name: 'SelectedIndex', initial: null },
    { name: 'SelectedScreen', initial: '' },
    { name: 'Collapsed', initial: false },
  ],
  defaultSize: { width: 240, height: 480 },
  primaryProp: 'Items',
  render: NavMenuRender,
}

/* ------------------------------------------------------------------ TopBar */

function TopBarRender({ props, mode, setOutput, fire, children }: ControlRenderProps) {
  const run = mode === 'run'
  const items = toRecords(props.Items)
  const title = toText(props.Title)
  const sub = toText(props.Subtitle)
  const b = boxStyle({ ...props, LayoutMode: 'Layout.Manual', Padding: 0, Scroll: false }, mode, { overflowRun: 'hidden' })
  return (
    <div
      data-layout="manual"
      className="box-border size-full border-b bg-card text-card-foreground"
      style={{ ...b.style, background: toColor(props.Fill) }}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-3 px-5">
        <DynIcon name={props.Icon} className="size-5 text-primary" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-base font-semibold">{title}</div>
          {sub !== '' && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
        </div>
      </div>
      {items.length > 0 && (
        <div className={cn('absolute inset-y-0 right-0 flex items-center gap-1 px-3', !run && 'pointer-events-none')}>
          {items.map((rec, i) => (
            <Button
              key={i}
              variant="ghost"
              size="sm"
              onClick={() => { setOutput('Selected', rec); setOutput('SelectedText', recordText(rec)); fire('OnSelect') }}
            >
              <DynIcon name={pick(rec, 'Icon')} />
              {pickText(rec, 'Label', 'Title', 'Name') || recordText(rec)}
            </Button>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}

export const TopBar: ControlType = {
  type: 'TopBar',
  label: 'Top bar',
  icon: PanelTop,
  category: 'Navigation',
  props: [
    { name: 'Title', kind: 'text', group: 'Content', default: '="My app"' },
    { name: 'Subtitle', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Icon', kind: 'icon', group: 'Content', default: '="Menu"' },
    { name: 'Items', kind: 'table', group: 'Data', default: '=[]' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
  ],
  defaultSize: { width: 960, height: 56 },
  isContainer: true,
  primaryProp: 'Title',
  render: TopBarRender,
}

/* ------------------------------------------------------------------ Steps */

function StepsRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const items = toRecords(props.Items)
  const current = Math.round(toNum(props.Current, 1))
  const vertical = orientationOf(props.Orientation, 'horizontal') === 'vertical'
  const clickable = toBool(props.Clickable, false)
  const accent = toColor(props.Color) ?? 'var(--primary)'
  const click = (i: number, rec: (typeof items)[number]) => {
    setOutput('Selected', rec)
    setOutput('SelectedIndex', i + 1)
    fire('OnSelect')
  }
  return (
    <div className={cn('flex size-full overflow-hidden', vertical ? 'flex-col' : 'items-start', !run && 'pointer-events-none')}>
      {items.map((rec, i) => {
        const n = i + 1
        const done = n < current
        const active = n === current
        const last = i === items.length - 1
        const title = pickText(rec, 'Title', 'Label', 'Name') || recordText(rec)
        const desc = pickText(rec, 'Description', 'Text')
        const dot = (
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors"
            style={{
              borderColor: done || active ? accent : 'var(--border)',
              background: done ? accent : 'var(--background)',
              color: done ? 'var(--primary-foreground)' : active ? accent : 'var(--muted-foreground)',
            }}
          >
            {done ? <Check className="size-3.5" /> : n}
          </span>
        )
        const text = (
          <div className={cn('min-w-0', vertical ? 'pb-4' : 'mt-0')}>
            <div className={cn('truncate text-sm font-medium', !done && !active && 'text-muted-foreground')}>{title}</div>
            {desc !== '' && <div className="text-xs text-muted-foreground">{desc}</div>}
          </div>
        )
        const body = vertical ? (
          <div className="flex gap-3">
            <div className="flex flex-col items-center">
              {dot}
              {!last && <span className="my-1 w-0.5 flex-1 rounded-full" style={{ background: done ? accent : 'var(--border)' }} />}
            </div>
            {text}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {dot}
            {text}
          </div>
        )
        return (
          <div key={i} className={cn('flex min-w-0', vertical ? '' : 'flex-1 items-start')}>
            {clickable ? (
              <button type="button" className="min-w-0 text-left" onClick={() => click(i, rec)}>{body}</button>
            ) : (
              body
            )}
            {!vertical && !last && <span className="mx-2 mt-3.5 h-0.5 min-w-4 flex-1 rounded-full" style={{ background: done ? accent : 'var(--border)' }} />}
          </div>
        )
      })}
      {items.length === 0 && <div className="text-sm text-muted-foreground">No steps</div>}
    </div>
  )
}

export const Steps: ControlType = {
  type: 'Steps',
  label: 'Steps',
  icon: Route,
  category: 'Navigation',
  props: [
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default: '=Table({Title: "Details", Description: "Basic info"}, {Title: "Review", Description: "Check and confirm"}, {Title: "Done", Description: "All set"})',
    },
    { name: 'Current', kind: 'number', group: 'Data', default: '=2' },
    { name: 'Orientation', kind: 'enum', group: 'Style', default: '=Orientation.Horizontal', options: ['Orientation.Horizontal', 'Orientation.Vertical'] },
    { name: 'Clickable', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 560, height: 72 },
  primaryProp: 'Current',
  render: StepsRender,
}

