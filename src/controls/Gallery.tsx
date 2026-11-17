import { useEffect, useRef } from 'react'
import { LayoutList } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { toBool, toColor, toNum, toRecords, toText } from './util'
import { lc, tableSignature } from './display/helpers'

type GLayout = 'vertical' | 'horizontal' | 'grid'
function layoutOf(v: unknown): GLayout {
  const s = lc(v as string)
  return s === 'horizontal' ? 'horizontal' : s === 'grid' ? 'grid' : 'vertical'
}

function GalleryRender({ props, mode, outputs, setOutput, fire, renderTemplate }: ControlRenderProps) {
  const design = mode === 'design'
  const items = toRecords(props.Items)
  const layout = layoutOf(props.Layout)
  const rowH = Math.max(8, toNum(props.TemplateHeight, 64))
  const rowW = Math.max(8, toNum(props.TemplateWidth, 240))
  const gap = Math.max(0, toNum(props.Gap, 8))
  const columns = Math.max(1, Math.round(toNum(props.Columns, 3)))
  const showBar = toBool(props.ShowScrollbar, true)
  const selectable = toBool(props.Selectable, true)
  const emptyText = toText(props.EmptyText)
  const selectedIndex = typeof outputs.SelectedIndex === 'number' ? outputs.SelectedIndex : null

  // In design with no data, still show one blank template row so the maker can edit the template.
  const rows: FxRecord[] = design && items.length === 0 ? [{}] : items

  // AllItems / VisibleCount outputs; written only when the content really changed (avoids loops).
  const sig = tableSignature(items)
  const lastSig = useRef<string | null>(null)
  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig
      setOutput('AllItems', items)
    }
    if (outputs.VisibleCount !== items.length) setOutput('VisibleCount', items.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, outputs.VisibleCount])

  const select = (item: FxRecord, i: number) => {
    if (!selectable) return
    setOutput('Selected', item)
    setOutput('SelectedIndex', i + 1)
    fire('OnSelect')
  }

  const containerStyle: React.CSSProperties = { background: toColor(props.Fill) }
  if (layout === 'vertical') {
    Object.assign(containerStyle, { display: 'flex', flexDirection: 'column', gap })
  } else if (layout === 'horizontal') {
    Object.assign(containerStyle, { display: 'flex', flexDirection: 'row', gap, alignItems: 'flex-start' })
  } else {
    Object.assign(containerStyle, {
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap,
      alignContent: 'start',
    })
  }
  if (!showBar) containerStyle.scrollbarWidth = 'none'

  const overflow = design
    ? 'overflow-hidden'
    : layout === 'horizontal'
      ? 'overflow-x-auto overflow-y-hidden'
      : 'overflow-y-auto overflow-x-hidden'

  return (
    <div
      data-gallery-layout={layout}
      className={cn('relative box-border size-full', overflow, !showBar && '[&::-webkit-scrollbar]:hidden')}
      style={containerStyle}
    >
      {rows.length === 0 ? (
        <div
          className="flex size-full items-center justify-center text-sm text-muted-foreground"
          style={layout === 'grid' ? { gridColumn: '1 / -1' } : undefined}
        >
          {emptyText}
        </div>
      ) : (
        rows.map((item, i) => {
          const selected = selectable && selectedIndex === i + 1
          return (
            <div
              key={i}
              data-gallery-row={i}
              className={cn(
                'relative transition-colors',
                layout === 'horizontal' && 'shrink-0',
                layout === 'vertical' && 'w-full shrink-0',
                !design && selectable && 'cursor-pointer hover:bg-muted/50',
                selected && 'bg-primary/10 shadow-[inset_3px_0_0_0_var(--primary)] hover:bg-primary/10',
              )}
              style={{ height: rowH, width: layout === 'horizontal' ? rowW : undefined }}
              onClick={design ? undefined : () => select(item, i)}
            >
              {renderTemplate ? renderTemplate(item, i) : null}
            </div>
          )
        })
      )}
    </div>
  )
}

export const Gallery: ControlType = {
  type: 'Gallery',
  label: 'Gallery',
  icon: LayoutList,
  category: 'Data',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=[]' },
    { name: 'Layout', kind: 'enum', group: 'Layout', default: '="Vertical"', options: ['"Vertical"', '"Horizontal"', '"Grid"'] },
    { name: 'Columns', kind: 'number', group: 'Layout', default: '=3' },
    { name: 'TemplateHeight', kind: 'number', group: 'Layout', default: '=64' },
    { name: 'TemplateWidth', kind: 'number', group: 'Layout', default: '=240' },
    { name: 'Gap', kind: 'number', group: 'Layout', default: '=8' },
    { name: 'ShowScrollbar', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'Selectable', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'EmptyText', kind: 'text', group: 'Content', default: '="No items"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.Transparent' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedIndex', initial: null },
    { name: 'AllItems', initial: [] },
    { name: 'VisibleCount', initial: 0 },
  ],
  defaultSize: { width: 320, height: 320 },
  isContainer: true,
  isTemplate: true,
  primaryProp: 'Items',
  render: GalleryRender,
}
