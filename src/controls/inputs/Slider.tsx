import { useRef, type CSSProperties } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Slider as UiSlider } from '@/components/ui/slider'
import { displayModeProp, toBool, toColor, toDisplayMode, toNum } from '../util'
import { Shell, useDefaultApply, useFocusToken } from './shared'
import { clampNum, snap } from './numeric'

export function sliderBounds(props: ControlRenderProps['props']) {
  const min = toNum(props.Min, 0)
  let max = toNum(props.Max, 100)
  if (max <= min) max = min + 1
  const step = Math.abs(toNum(props.Step, 1)) || 1
  return { min, max, step }
}

function SliderRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const { min, max, step } = sliderBounds(props)
  const def = clampNum(toNum(props.Default, min), min, max)
  useDefaultApply(String(def), outputs.Value == null, () => setOutput('Value', def))
  const value = clampNum(outputs.Value == null ? def : toNum(outputs.Value, def), min, max)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const color = toColor(props.Color)
  return (
    <Shell design={design} rootRef={root} style={color ? ({ '--primary': color } as CSSProperties) : undefined}>
      <div className="flex size-full items-center gap-3" style={{ fontSize: toNum(props.Size, 14) }}>
        <UiSlider
          min={min}
          max={max}
          step={step}
          value={[value]}
          disabled={dm !== 'Edit'}
          onValueChange={(v) => {
            if (design || dm !== 'Edit' || v.length === 0) return
            setOutput('Value', snap(v[0], step))
            fire('OnChange')
          }}
        />
        {toBool(props.ShowValue, true) && <span className="min-w-8 shrink-0 text-right font-medium tabular-nums">{value}</span>}
      </div>
    </Shell>
  )
}

export const Slider: ControlType = {
  type: 'Slider',
  label: 'Slider',
  icon: SlidersHorizontal,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'number', group: 'Content', default: '=50' },
    { name: 'Min', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Max', kind: 'number', group: 'Content', default: '=100' },
    { name: 'Step', kind: 'number', group: 'Content', default: '=1' },
    { name: 'ShowValue', label: 'Show value', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: null }],
  defaultSize: { width: 280, height: 32 },
  primaryProp: 'Default',
  render: SliderRender,
}
