import { useRef, type CSSProperties } from 'react'
import { MoveHorizontal } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Slider as UiSlider } from '@/components/ui/slider'
import { displayModeProp, toBool, toColor, toDisplayMode, toNum } from '../util'
import { Shell, useDefaultApply, useFocusToken } from './shared'
import { clampNum, snap } from './numeric'
import { sliderBounds } from './Slider'

function RangeSliderRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const { min, max, step } = sliderBounds(props)
  const defLow = clampNum(toNum(props.DefaultLow, min), min, max)
  const defHigh = clampNum(toNum(props.DefaultHigh, max), defLow, max)
  const blank = outputs.Low == null || outputs.High == null
  useDefaultApply(`${defLow}|${defHigh}`, blank, () => {
    setOutput('Low', defLow)
    setOutput('High', defHigh)
  })
  const low = clampNum(outputs.Low == null ? defLow : toNum(outputs.Low, defLow), min, max)
  const high = clampNum(outputs.High == null ? defHigh : toNum(outputs.High, defHigh), low, max)
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
          minStepsBetweenThumbs={0}
          value={[low, high]}
          disabled={dm !== 'Edit'}
          onValueChange={(v) => {
            if (design || dm !== 'Edit' || v.length < 2) return
            setOutput('Low', snap(v[0], step))
            setOutput('High', snap(v[1], step))
            fire('OnChange')
          }}
        />
        {toBool(props.ShowValue, true) && (
          <span className="min-w-14 shrink-0 text-right font-medium tabular-nums">
            {low} - {high}
          </span>
        )}
      </div>
    </Shell>
  )
}

export const RangeSlider: ControlType = {
  type: 'RangeSlider',
  label: 'Range slider',
  icon: MoveHorizontal,
  category: 'Input',
  props: [
    { name: 'DefaultLow', label: 'Default low', kind: 'number', group: 'Content', default: '=25' },
    { name: 'DefaultHigh', label: 'Default high', kind: 'number', group: 'Content', default: '=75' },
    { name: 'Min', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Max', kind: 'number', group: 'Content', default: '=100' },
    { name: 'Step', kind: 'number', group: 'Content', default: '=1' },
    { name: 'ShowValue', label: 'Show values', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Low', initial: null },
    { name: 'High', initial: null },
  ],
  defaultSize: { width: 320, height: 32 },
  primaryProp: 'DefaultLow',
  render: RangeSliderRender,
}
