import { LayoutList } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { cn } from '@/lib/utils'
import { toColor, toNum, toRecords } from './util'

function GalleryRender({ props, mode, outputs, setOutput, fire, renderTemplate }: ControlRenderProps) {
  const design = mode === 'design'
  const items = toRecords(props.Items)
  const rowH = Math.max(8, toNum(props.TemplateHeight, 64))
  const gap = Math.max(0, toNum(props.Gap, 8))
  const selectedIndex = typeof outputs.SelectedIndex === 'number' ? outputs.SelectedIndex : null

  // In design with no data, still show one blank template row so the maker can edit the template.
  const rows: FxRecord[] = design && items.length === 0 ? [{}] : items

  const select = (item: FxRecord, i: number) => {
    setOutput('Selected', item)
    setOutput('SelectedIndex', i + 1)
    fire('OnSelect')
  }

  return (
    <div
      className={cn('relative size-full', design ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden')}
      style={{ background: toColor(props.Fill) }}
    >
      {rows.length === 0 ? (
        <div className="flex size-full items-center justify-center text-sm text-muted-foreground">No items</div>
      ) : (
        rows.map((item, i) => {
          const selected = selectedIndex === i + 1
          return (
            <div
              key={i}
              data-gallery-row={i}
              className={cn(
                'relative w-full transition-colors',
                !design && 'cursor-pointer hover:bg-muted/50',
                selected && 'bg-primary/10 shadow-[inset_3px_0_0_0_var(--primary)] hover:bg-primary/10',
              )}
              style={{ height: rowH, marginBottom: i === rows.length - 1 ? 0 : gap }}
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
    { name: 'TemplateHeight', kind: 'number', group: 'Layout', default: '=64' },
    { name: 'Gap', kind: 'number', group: 'Layout', default: '=8' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.Transparent' },
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedIndex', initial: null },
  ],
  defaultSize: { width: 320, height: 320 },
  isContainer: true,
  primaryProp: 'Items',
  render: GalleryRender,
}
