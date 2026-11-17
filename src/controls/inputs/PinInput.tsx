import { useEffect, useRef } from 'react'
import { Grip } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { displayModeProp, toBool, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { Shell, useFocusToken } from './shared'

function PinInputRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const length = Math.min(12, Math.max(1, Math.round(toNum(props.Length, 4))))
  const numeric = toBool(props.Numeric, true)
  const mask = toBool(props.Mask, false)
  const clean = (s: string) => (numeric ? s.replace(/\D/g, '') : s.replace(/\s/g, '')).slice(0, length)
  const def = clean(toText(props.Default))
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = clean(outputs.Value == null ? def : toText(outputs.Value))
  const root = useRef<HTMLDivElement>(null)
  const cells = useRef<(HTMLInputElement | null)[]>([])
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const complete = value.length === length
  useEffect(() => {
    if (outputs.Complete !== complete) setOutput('Complete', complete)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, outputs.Complete])

  const write = (next: string) => {
    if (next === value) return
    setOutput('Value', next)
    fire('OnChange')
    if (next.length === length) fire('OnComplete')
  }
  const focusAt = (i: number) => cells.current[Math.max(0, Math.min(length - 1, i))]?.focus()

  return (
    <Shell design={design} rootRef={root}>
      <div className="flex size-full items-center gap-2" style={{ opacity: dm === 'Disabled' ? 0.5 : 1 }}>
        {Array.from({ length }, (_, i) => (
          <input
            key={i}
            ref={(el) => { cells.current[i] = el }}
            type={mask ? 'password' : 'text'}
            inputMode={numeric ? 'numeric' : 'text'}
            autoComplete="off"
            maxLength={1}
            value={value[i] ?? ''}
            readOnly={!editable}
            disabled={dm === 'Disabled'}
            aria-label={`Digit ${i + 1}`}
            className="h-full min-w-0 flex-1 rounded-md border border-input bg-transparent text-center text-base font-medium shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            onChange={(e) => {
              if (!editable) return
              const ch = clean(e.target.value).slice(-1)
              const chars = value.split('')
              if (ch === '') {
                chars.splice(i, 1)
                write(chars.join(''))
                return
              }
              chars[i] = ch
              write(chars.join('').slice(0, length))
              focusAt(i + 1)
            }}
            onKeyDown={(e) => {
              if (!editable) return
              if (e.key === 'Backspace' && !(value[i] ?? '')) { e.preventDefault(); focusAt(i - 1) }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(i - 1) }
              else if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(i + 1) }
            }}
            onPaste={(e) => {
              if (!editable) return
              e.preventDefault()
              const pasted = clean(e.clipboardData.getData('text'))
              if (pasted === '') return
              write((value.slice(0, i) + pasted).slice(0, length))
              focusAt(Math.min(i + pasted.length, length - 1))
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        ))}
      </div>
    </Shell>
  )
}

export const PinInput: ControlType = {
  type: 'PinInput',
  label: 'PIN input',
  icon: Grip,
  category: 'Input',
  props: [
    { name: 'Length', kind: 'number', group: 'Content', default: '=4' },
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Numeric', label: 'Digits only', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'Mask', label: 'Mask characters', kind: 'boolean', group: 'Content', default: '=false' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnComplete', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Value', initial: '' },
    { name: 'Complete', initial: false },
  ],
  defaultSize: { width: 220, height: 48 },
  primaryProp: 'OnComplete',
  render: PinInputRender,
}
