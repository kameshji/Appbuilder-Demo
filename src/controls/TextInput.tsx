import { TextCursorInput } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Input } from '@/components/ui/input'
import { displayModeProp, toDisplayMode, toNum, toText, useDefaultSync } from './util'

function TextInputRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  return (
    <Input
      value={value}
      placeholder={toText(props.Placeholder)}
      tabIndex={design ? -1 : undefined}
      autoFocus={false}
      readOnly={design || dm === 'View'}
      disabled={dm === 'Disabled'}
      className="h-full w-full"
      style={{ fontSize: toNum(props.Size, 14), pointerEvents: design ? 'none' : undefined }}
      onChange={(e) => {
        if (design) return
        setOutput('Value', e.target.value)
        fire('OnChange')
      }}
    />
  )
}

export const TextInput: ControlType = {
  type: 'TextInput',
  label: 'Text input',
  icon: TextCursorInput,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Type here"' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }],
  defaultSize: { width: 240, height: 40 },
  primaryProp: 'Default',
  render: TextInputRender,
}
