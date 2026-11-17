import { useRef, type CSSProperties } from 'react'
import { ToggleLeft } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { ToggleGroup as UiToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { displayModeProp, toColor, toDisplayMode } from '../util'
import { Shell, isMultiple, selectionModeProp, sizeOf, sizeProp, useFocusToken, variantOf, variantProp } from './shared'
import { useItemSelection } from './selection'

function ToggleGroupRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const multiple = isMultiple(props.SelectionMode)
  const sel = useItemSelection({ props, outputs, setOutput, multiple, withItems: true })
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const variant = variantOf(props.Variant, 'outline') === 'outline' ? 'outline' : 'default'
  const sz = sizeOf(props.Size)
  const color = toColor(props.Color)
  const common = {
    variant,
    size: sz === 'sm' ? 'sm' : sz === 'lg' ? 'lg' : 'default',
    disabled: dm === 'Disabled',
    className: 'h-full max-w-full flex-wrap',
  } as const
  const commit = (idx: number[]) => {
    if (design || dm !== 'Edit') return
    sel.set(idx)
    fire('OnChange')
  }
  const itemEls = sel.texts.map((t, i) => (
    <ToggleGroupItem key={i} value={String(i)} className="h-full px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
      <span className="truncate">{t}</span>
    </ToggleGroupItem>
  ))
  return (
    <Shell design={design} rootRef={root} style={color ? ({ '--primary': color } as CSSProperties) : undefined}>
      {multiple ? (
        <UiToggleGroup
          type="multiple"
          {...common}
          value={sel.selected.map(String)}
          onValueChange={(v: string[]) => commit(v.map(Number).filter((n) => Number.isInteger(n)))}
        >
          {itemEls}
        </UiToggleGroup>
      ) : (
        <UiToggleGroup
          type="single"
          {...common}
          value={sel.selected.length > 0 ? String(sel.selected[0]) : ''}
          onValueChange={(v: string) => commit(v === '' ? [] : [Number(v)])}
        >
          {itemEls}
        </UiToggleGroup>
      )}
    </Shell>
  )
}

export const ToggleGroup: ControlType = {
  type: 'ToggleGroup',
  label: 'Toggle group',
  icon: ToggleLeft,
  category: 'Input',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Left", "Center", "Right"]' },
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    selectionModeProp('Single'),
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    variantProp('Outline'),
    sizeProp('Medium'),
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedItems', initial: [] },
    { name: 'SelectedText', initial: '' },
  ],
  defaultSize: { width: 280, height: 40 },
  primaryProp: 'Items',
  render: ToggleGroupRender,
}
