import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ListCollapse, PanelRight, PanelTop, AppWindow, X } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { toBool, toColor, toNum, toRecords, toText, recordText } from '../util'
import { DynIcon, LayoutBox, layoutProps, lc, pick, pickText, useSelection } from './helpers'
import { useDevice } from '@/phone/env'
import { SheetHandle, useSheetDrag } from '@/phone/sheet'
import { overlayPlacement } from '@/phone/touch-logic'
import { usePaneVisible } from '@/phone/touch-hooks'

/* ------------------------------------------------------------------ Tabs */

function TabsRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const items = toRecords(props.Items)
  const variant = ['pills', 'segmented'].includes(lc(props.Variant)) ? lc(props.Variant) : 'underline'
  const accent = toColor(props.Color) ?? 'var(--primary)'
  const { index, select } = useSelection(items, toText(props.Default), outputs, setOutput)

  const click = (i: number) => {
    if (design) return
    const changed = i !== index
    select(i)
    if (changed) fire('OnSelect')
  }

  const wrap =
    variant === 'segmented'
      ? 'items-center gap-1 rounded-lg bg-muted p-1'
      : variant === 'pills'
        ? 'items-center gap-1'
        : 'items-stretch gap-1 border-b'

  return (
    <div className={cn('flex size-full overflow-x-auto', wrap, design && 'pointer-events-none')} role="tablist">
      {items.map((rec, i) => {
        const active = i === index
        const icon = pick(rec, 'Icon')
        const disabled = toBool(pick(rec, 'Disabled'), false)
        return (
          <button
            key={i}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={disabled}
            onClick={() => click(i)}
            className={cn(
              'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-3.5 text-sm font-medium outline-none transition-colors disabled:opacity-50',
              variant === 'underline' && 'rounded-t-md hover:text-foreground',
              variant === 'underline' && (active ? 'text-foreground' : 'text-muted-foreground'),
              variant === 'pills' && 'h-9 rounded-md hover:bg-accent hover:text-accent-foreground',
              variant === 'pills' && !active && 'text-muted-foreground',
              variant === 'segmented' && 'h-full min-h-7 flex-1 rounded-md',
              variant === 'segmented' && (active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'),
            )}
            style={variant === 'pills' && active ? { background: accent, color: 'var(--primary-foreground)' } : undefined}
          >
            <DynIcon name={icon} className="size-4" />
            {recordText(rec)}
            {variant === 'underline' && active && (
              <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full" style={{ background: accent }} />
            )}
          </button>
        )
      })}
    </div>
  )
}

export const Tabs: ControlType = {
  type: 'Tabs',
  label: 'Tabs',
  icon: PanelTop,
  category: 'Navigation',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Overview","Details","Activity"]' },
    { name: 'Default', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Variant', kind: 'enum', group: 'Style', default: '="Underline"', options: ['"Underline"', '"Pills"', '"Segmented"'] },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 420, height: 44 },
  primaryProp: 'Items',
  render: TabsRender,
}

/* ------------------------------------------------------------------ Dialog / Sheet */

const dialogShadow = '0 20px 50px -12px rgba(0,0,0,0.35)'

function PanelHeader({
  title,
  description,
  showClose,
  onClose,
  touch,
}: {
  title: string
  description: string
  showClose: boolean
  onClose: () => void
  touch?: boolean
}) {
  if (!title && !description && !showClose) return null
  return (
    <div className="flex shrink-0 items-start gap-3 px-5 pt-5 pb-2">
      <div className="min-w-0 flex-1">
        {title !== '' && <div className="text-lg font-semibold leading-tight">{title}</div>}
        {description !== '' && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      {showClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={cn('inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground', touch ? 'size-11 -m-2' : '-mr-1 size-7')}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
}

function OverlayRender({ kind, ...p }: ControlRenderProps & { kind: 'Dialog' | 'Sheet' }) {
  const { props, mode, children, fire } = p
  const design = mode === 'design'
  const open = toBool(props.Open, false)
  const title = toText(props.Title)
  const description = toText(props.Description)
  const showClose = toBool(props.ShowClose, true)
  const close = () => fire('OnClose')
  useEscape(!design && open, close)
  // touch devices at phone width: a Dialog and a left / right / bottom Sheet are bottom sheets (src/phone/sheet.tsx)
  const device = useDevice()
  const placement = overlayPlacement(kind, lc(props.Side), device.touch, device.screenWidth)
  const asSheet = !design && placement === 'bottom-sheet'
  const drag = useSheetDrag(close)
  const anchor = useRef<HTMLSpanElement>(null)
  const paneVisible = usePaneVisible(anchor)

  const body = (
    <>
      {asSheet && <SheetHandle handlers={drag.handlers} />}
      <PanelHeader title={title} description={description} showClose={showClose} onClose={close} touch={device.touch} />
      <LayoutBox props={props} mode={mode} className="min-h-0 w-full flex-1">
        {children}
      </LayoutBox>
    </>
  )
  const fill = toColor(props.Fill)

  if (design) {
    return (
      <div
        className="relative box-border flex size-full flex-col border bg-card text-card-foreground"
        style={{ background: fill, borderRadius: kind === 'Dialog' ? 12 : 0, boxShadow: dialogShadow, overflow: 'visible' }}
      >
        <span className="pointer-events-none absolute -bottom-2.5 right-3 z-10 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground">
          {kind}
        </span>
        {body}
      </div>
    )
  }
  if (!open) return null

  const W = Math.max(120, toNum(props.Width, kind === 'Dialog' ? 480 : 400))
  const H = Math.max(80, toNum(props.Height, kind === 'Dialog' ? 320 : 600))
  const side = lc(props.Side)

  let panelClass = ''
  let panelStyle: React.CSSProperties = {}
  let backdropClass = ''
  if (asSheet) {
    panelClass = 'ab-overlay-sheet ab-sheet-enter border-t'
    panelStyle = { height: `min(${H}px, calc(var(--vvh, 100dvh) - 16px))` }
  } else if (kind === 'Dialog') {
    backdropClass = 'flex items-center justify-center p-6'
    panelClass = 'relative flex max-h-full max-w-full flex-col rounded-xl'
    panelStyle = { width: W, height: H }
  } else if (side === 'left' || side === 'right') {
    panelClass = cn('absolute inset-y-0 flex flex-col max-w-full', side === 'left' ? 'left-0 border-r' : 'right-0 border-l')
    panelStyle = { width: W }
  } else {
    panelClass = cn('absolute inset-x-0 flex flex-col max-h-full', side === 'top' ? 'top-0 border-b' : 'bottom-0 border-t')
    panelStyle = { height: H }
  }

  // a bottom sheet is drawn on document.body: inside the app surface (scrolled, maybe scaled) `fixed` would not mean the screen
  // (only while its app tab is the one on screen: open apps stay mounted in hidden tab panels)
  const wrap = (el: React.ReactElement) => (asSheet && typeof document !== 'undefined' ? <><span ref={anchor} className="hidden" />{paneVisible && createPortal(el, document.body)}</> : el)
  return wrap(
    <div
      className={cn('fixed inset-0 z-[200] bg-black/50', backdropClass)}
      onClick={(e) => {
        if (e.target === e.currentTarget && toBool(props.CloseOnBackdrop, true)) close()
      }}
    >
      <div
        ref={drag.ref}
        role="dialog"
        aria-modal="true"
        aria-label={title || kind}
        data-overlay-placement={placement}
        className={cn('box-border border bg-card text-card-foreground', panelClass)}
        style={{ ...panelStyle, background: fill, boxShadow: dialogShadow }}
      >
        {body}
      </div>
    </div>
  )
}

const overlayBase = [
  { name: 'Open', kind: 'boolean', group: 'Behaviour', default: '=false' },
  { name: 'Title', kind: 'text', group: 'Content', default: '="Title"' },
  { name: 'Description', kind: 'text', group: 'Content', default: '=""' },
  { name: 'ShowClose', kind: 'boolean', group: 'Content', default: '=true' },
  { name: 'CloseOnBackdrop', kind: 'boolean', group: 'Behaviour', default: '=true', simple: false },
  { name: 'OnClose', kind: 'action', group: 'Behaviour', default: '=false' },
  { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()' },
] as const

export const Dialog: ControlType = {
  type: 'Dialog',
  label: 'Dialog',
  icon: AppWindow,
  category: 'Layout',
  props: [...overlayBase.map((p) => ({ ...p })), ...layoutProps({ layout: 'manual', gap: 16, padding: 0 })],
  outputs: [],
  defaultSize: { width: 480, height: 320 },
  isContainer: true,
  isOverlay: true,
  primaryProp: 'Open',
  render: (p) => <OverlayRender {...p} kind="Dialog" />,
}

export const Sheet: ControlType = {
  type: 'Sheet',
  label: 'Sheet',
  icon: PanelRight,
  category: 'Layout',
  props: [
    ...overlayBase.map((p) => ({ ...p })),
    { name: 'Side', kind: 'enum', group: 'Layout', default: '=Side.Right', options: ['Side.Left', 'Side.Right', 'Side.Top', 'Side.Bottom'] },
    ...layoutProps({ layout: 'manual', gap: 16, padding: 0 }),
  ],
  outputs: [],
  defaultSize: { width: 400, height: 600 },
  isContainer: true,
  isOverlay: true,
  primaryProp: 'Open',
  render: (p) => <OverlayRender {...p} kind="Sheet" />,
}

/* ------------------------------------------------------------------ Accordion */

const itemTitle = (r: FxRecord) => pickText(r, 'Title', 'Label', 'Name', 'Value') || recordText(r)

function AccordionRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const items = toRecords(props.Items)
  const multiple = toBool(props.AllowMultiple, false)
  const defOpen = Math.round(toNum(props.DefaultOpen, 1))
  const [open, setOpen] = useState<Set<number>>(() => new Set(defOpen > 0 ? [defOpen - 1] : []))

  const toggle = (i: number) => {
    const next = new Set(multiple ? open : [])
    const opening = !open.has(i)
    if (opening) next.add(i)
    else next.delete(i)
    setOpen(next)
    if (opening) {
      setOutput('Selected', items[i] ?? null)
      setOutput('SelectedIndex', i + 1)
      fire('OnSelect')
    } else if (!multiple) {
      setOutput('Selected', null)
      setOutput('SelectedIndex', null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex size-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No items
      </div>
    )
  }

  return (
    <div className={cn('size-full', design ? 'pointer-events-none overflow-hidden' : 'overflow-y-auto')}>
      <div className="divide-y rounded-lg border bg-card text-card-foreground">
        {items.map((rec, i) => {
          const isOpen = open.has(i)
          return (
            <div key={i}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(i)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 truncate">{itemTitle(rec)}</span>
                <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
              </button>
              {isOpen && (
                <div className="whitespace-pre-wrap px-4 pb-4 text-sm text-muted-foreground">
                  {pickText(rec, 'Content', 'Text', 'Body', 'Description')}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const Accordion: ControlType = {
  type: 'Accordion',
  label: 'Accordion',
  icon: ListCollapse,
  category: 'Layout',
  props: [
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default:
        '=Table({Title: "What is this?", Content: "A collapsible section. Bind Items to a table with Title and Content columns."}, {Title: "How do I change it?", Content: "Edit the Items formula."}, {Title: "Can several be open?", Content: "Yes, set AllowMultiple to true."})',
    },
    { name: 'AllowMultiple', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'DefaultOpen', kind: 'number', group: 'Behaviour', default: '=1' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 420, height: 200 },
  primaryProp: 'Items',
  render: AccordionRender,
}
