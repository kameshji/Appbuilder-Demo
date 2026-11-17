import { ToggleLeft } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Switch } from '@/components/ui/switch'
import { displayModeProp, toBool, toDisplayMode, toText, useDefaultSync } from './util'

function ToggleRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toBool(props.Default)
  useDefaultSync(def, outputs.Value, false, (v) => setOutput('Value', v))
  const checked = outputs.Value == null ? def : toBool(outputs.Value)
  const text = toText(props.Text)
  return (
    <label
      className="flex size-full items-center gap-2 text-sm"
      style={{ pointerEvents: design ? 'none' : undefined, opacity: dm === 'Disabled' ? 0.5 : 1 }}
    >
      <Switch
        checked={checked}
        tabIndex={design ? -1 : undefined}
        disabled={dm === 'Disabled'}
        onCheckedChange={(c) => {
          if (design || dm !== 'Edit') return
          setOutput('Value', c)
          fire('OnChange')
        }}
      />
      {text !== '' && <span className="min-w-0 truncate select-none">{text}</span>}
    </label>
  )
}

export const Toggle: ControlType = {
  type: 'Toggle',
  label: 'Toggle',
  icon: ToggleLeft,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Toggle"' },
    { name: 'Default', kind: 'boolean', group: 'Content', default: '=false' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: false }],
  defaultSize: { width: 160, height: 28 },
  primaryProp: 'Default',
  render: ToggleRender,
}
