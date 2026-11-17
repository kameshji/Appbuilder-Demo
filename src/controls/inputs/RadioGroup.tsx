import { useRef, type CSSProperties } from 'react'
import { CircleDot } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { RadioGroup as UiRadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { displayModeProp, toColor, toDisplayMode, toNum } from '../util'
import { Shell, isVertical, orientationProp, useFocusToken } from './shared'
import { useItemSelection } from './selection'

function RadioGroupRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const sel = useItemSelection({ props, outputs, setOutput, multiple: false, withItems: false })
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const vertical = isVertical(props.Orientation)
  const color = toColor(props.Color)
  const fontSize = toNum(props.Size, 14)
  const value = sel.selected.length > 0 ? String(sel.selected[0]) : ''
  const uid = useRef(Math.random().toString(36).slice(2, 8)).current
  return (
    <Shell design={design} rootRef={root} style={color ? ({ '--primary': color } as CSSProperties) : undefined} className="overflow-auto">
      <UiRadioGroup
        value={value}
        orientation={vertical ? 'vertical' : 'horizontal'}
        disabled={dm === 'Disabled'}
        className={vertical ? 'grid gap-2' : 'flex flex-wrap gap-x-5 gap-y-2'}
        onValueChange={(v) => {
          if (design || dm !== 'Edit') return
          const i = Number(v)
          if (!Number.isInteger(i)) return
          sel.set([i])
          fire('OnChange')
        }}
      >
        {sel.texts.map((t, i) => (
          <div key={i} className="flex items-center gap-2" style={{ fontSize }}>
            <RadioGroupItem value={String(i)} id={`${uid}-${i}`} />
            <label htmlFor={`${uid}-${i}`} className="min-w-0 truncate leading-none select-none">
              {t}
            </label>
          </div>
        ))}
      </UiRadioGroup>
    </Shell>
  )
}

export const RadioGroup: ControlType = {
  type: 'RadioGroup',
  label: 'Radio group',
  icon: CircleDot,
  category: 'Input',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Option 1", "Option 2", "Option 3"]' },
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    orientationProp('Vertical'),
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
  ],
  defaultSize: { width: 220, height: 104 },
  primaryProp: 'Items',
  render: RadioGroupRender,
}
