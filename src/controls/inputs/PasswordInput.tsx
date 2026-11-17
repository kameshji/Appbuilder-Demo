import { useRef, useState } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Input } from '@/components/ui/input'
import { displayModeProp, toBool, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { Shell, useFocusToken } from './shared'

function PasswordInputRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  const [shown, setShown] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const canReveal = toBool(props.ShowToggle, true)
  return (
    <Shell design={design} rootRef={root} className="relative">
      <Input
        type={shown && !design ? 'text' : 'password'}
        autoComplete="off"
        value={value}
        placeholder={toText(props.Placeholder)}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        className={'h-full w-full ' + (canReveal ? 'pr-10' : '')}
        style={{ fontSize: toNum(props.Size, 14) }}
        onChange={(e) => {
          if (design) return
          setOutput('Value', e.target.value)
          fire('OnChange')
        }}
      />
      {canReveal && (
        <button
          type="button"
          tabIndex={design ? -1 : undefined}
          disabled={dm === 'Disabled'}
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
    </Shell>
  )
}

export const PasswordInput: ControlType = {
  type: 'PasswordInput',
  label: 'Password input',
  icon: KeyRound,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Password"' },
    { name: 'ShowToggle', label: 'Show reveal button', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }],
  defaultSize: { width: 240, height: 40 },
  primaryProp: 'Default',
  render: PasswordInputRender,
}
