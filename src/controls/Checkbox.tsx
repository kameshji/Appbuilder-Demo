import { SquareCheck } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Checkbox as UiCheckbox } from '@/components/ui/checkbox'
import { displayModeProp, toBool, toDisplayMode, toText, useDefaultSync } from './util'

function CheckboxRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toBool(props.Default)
  useDefaultSync(def, outputs.Value, false, (v) => setOutput('Value', v))
  const checked = outputs.Value == null ? def : toBool(outputs.Value)
  const toggle = (next: boolean) => {
    if (design || dm !== 'Edit') return
    setOutput('Value', next)
    fire('OnChange')
  }
  return (
    <label
      className="flex size-full items-center gap-2 text-sm"
      style={{ pointerEvents: design ? 'none' : undefined, opacity: dm === 'Disabled' ? 0.5 : 1 }}
    >
      <UiCheckbox
        checked={checked}
        tabIndex={design ? -1 : undefined}
        disabled={dm === 'Disabled'}
        onCheckedChange={(c) => toggle(c === true)}
      />
      <span className="min-w-0 truncate select-none">{toText(props.Text)}</span>
    </label>
  )
}

export const Checkbox: ControlType = {
  type: 'Checkbox',
  label: 'Checkbox',
  icon: SquareCheck,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Option"' },
    { name: 'Default', kind: 'boolean', group: 'Content', default: '=false' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: false }],
  defaultSize: { width: 160, height: 24 },
  primaryProp: 'Text',
  render: CheckboxRender,
}
