import { useRef } from 'react'
import { Minus, Plus, PlusSquare } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { displayModeProp, toDisplayMode, toNum } from '../util'
import { Shell, useDefaultApply, useFocusToken } from './shared'
import { clampNum, numOrNull, snap } from './numeric'

function StepperRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const min = numOrNull(props.Min)
  const max = numOrNull(props.Max)
  const step = Math.abs(toNum(props.Step, 1)) || 1
  const def = clampNum(toNum(props.Default, 0), min, max)
  useDefaultApply(String(def), outputs.Value == null, () => setOutput('Value', def))
  const value = outputs.Value == null ? def : toNum(outputs.Value, def)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const set = (n: number) => {
    const next = clampNum(snap(n, step), min, max)
    if (next === value) return
    setOutput('Value', next)
    fire('OnChange')
  }
  return (
    <Shell design={design} rootRef={root}>
      <div
        className="flex size-full items-center overflow-hidden rounded-md border border-input bg-transparent shadow-xs"
        style={{ opacity: dm === 'Disabled' ? 0.5 : 1 }}
      >
        <Button
          type="button"
          variant="ghost"
          aria-label="Decrease"
          disabled={dm === 'Disabled' || !editable || (min != null && value <= min)}
          className="h-full w-10 shrink-0 rounded-none px-0"
          onClick={() => set(value - step)}
        >
          <Minus className="size-4" />
        </Button>
        <div
          className="flex min-w-0 flex-1 items-center justify-center truncate px-2 text-sm font-medium tabular-nums"
          role="spinbutton"
          aria-valuenow={value}
          aria-valuemin={min ?? undefined}
          aria-valuemax={max ?? undefined}
          tabIndex={design ? -1 : 0}
          onKeyDown={(e) => {
            if (!editable) return
            if (e.key === 'ArrowUp') { e.preventDefault(); set(value + step) }
            if (e.key === 'ArrowDown') { e.preventDefault(); set(value - step) }
          }}
        >
          {value}
        </div>
        <Button
          type="button"
          variant="ghost"
          aria-label="Increase"
          disabled={dm === 'Disabled' || !editable || (max != null && value >= max)}
          className="h-full w-10 shrink-0 rounded-none px-0"
          onClick={() => set(value + step)}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </Shell>
  )
}

export const Stepper: ControlType = {
  type: 'Stepper',
  label: 'Stepper',
  icon: PlusSquare,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Min', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Max', kind: 'number', group: 'Content', default: '=100' },
    { name: 'Step', kind: 'number', group: 'Content', default: '=1' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: null }],
  defaultSize: { width: 140, height: 40 },
  primaryProp: 'Default',
  render: StepperRender,
}
