import { useRef } from 'react'
import { TextAlignStart } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Textarea } from '@/components/ui/textarea'
import { displayModeProp, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { Shell, useFocusToken } from './shared'

function TextAreaRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const rows = Math.max(1, Math.round(toNum(props.Rows, 4)))
  const maxLen = Math.round(toNum(props.MaxLength, 0))
  return (
    <Shell design={design} rootRef={root}>
      <Textarea
        value={value}
        rows={rows}
        placeholder={toText(props.Placeholder)}
        maxLength={maxLen > 0 ? maxLen : undefined}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        className="size-full min-h-0 resize-none"
        style={{ fontSize: toNum(props.Size, 14) }}
        onChange={(e) => {
          if (design) return
          setOutput('Value', e.target.value)
          fire('OnChange')
        }}
      />
    </Shell>
  )
}

export const TextArea: ControlType = {
  type: 'TextArea',
  label: 'Text area',
  icon: TextAlignStart,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Type here"' },
    { name: 'Rows', kind: 'number', group: 'Content', default: '=4' },
    { name: 'MaxLength', kind: 'number', group: 'Content', default: '=0', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }],
  defaultSize: { width: 320, height: 120 },
  primaryProp: 'Default',
  render: TextAreaRender,
}
