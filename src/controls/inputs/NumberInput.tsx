import { useRef, useState } from 'react'
import { Hash } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Input } from '@/components/ui/input'
import { displayModeProp, toDisplayMode, toNum, toText } from '../util'
import { Shell, useDefaultApply, useFocusToken } from './shared'
import { clampNum, fmtNum, numOrNull, snap } from './numeric'
import { useDevice } from '@/phone/env'
import { allowsNegative, normalizeNumberText, numberInputMode, toggleSign } from '@/phone/touch-logic'

function NumberInputRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = numOrNull(props.Default)
  const min = numOrNull(props.Min)
  const max = numOrNull(props.Max)
  const step = Math.abs(toNum(props.Step, 1)) || 1
  const sync = useDefaultApply(String(def), outputs.Value == null, () => setOutput('Value', def))
  const stored = outputs.Value == null ? (sync.isUserBlank() ? null : def) : numOrNull(outputs.Value)
  const [draft, setDraft] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const touch = useDevice().touch
  // touch devices: digits-only pad for a bounded whole-number range, else the decimal pad; iOS pads have no minus key,
  // so a field that may be negative gets a sign button
  const signButton = touch && editable && allowsNegative(min)

  // typed text (a decimal comma from the phone keyboard counts as the point): store it and, when it is a number, commit it
  const typed = (raw: string) => {
    const t = normalizeNumberText(raw)
    if (t === null) return
    setDraft(t)
    if (t === '' || t === '-' || t === '.' || t === '-.') {
      if (t === '') commit(null)
      return
    }
    const n = Number(t)
    if (Number.isFinite(n)) commit(n)
  }

  const commit = (n: number | null) => {
    sync.markBlank(n == null)
    setOutput('Value', n)
    fire('OnChange')
  }

  return (
    <Shell design={design} rootRef={root} className="relative">
      {signButton && (
        <button
          type="button"
          aria-label="Change sign"
          data-testid="number-sign"
          data-touch-target=""
          className="absolute inset-y-0 left-1 z-10 my-auto flex size-8 items-center justify-center rounded text-base font-medium text-muted-foreground"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const cur = draft ?? fmtNum(stored)
            typed(toggleSign(cur))
          }}
        >
          ±
        </button>
      )}
      <Input
        type="text"
        inputMode={touch ? numberInputMode(min, max, step) : 'decimal'}
        enterKeyHint="done"
        autoComplete="off"
        value={draft ?? fmtNum(stored)}
        placeholder={toText(props.Placeholder)}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        className={signButton ? 'h-full w-full pl-9' : 'h-full w-full'}
        style={{ fontSize: toNum(props.Size, 14), textAlign: 'right' }}
        onChange={(e) => {
          if (!editable) return
          typed(e.target.value)
        }}
        onKeyDown={(e) => {
          if (!editable) return
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const base = stored ?? 0
            const next = clampNum(snap(base + (e.key === 'ArrowUp' ? step : -step), step), min, max)
            setDraft(null)
            commit(next)
          }
        }}
        onBlur={() => {
          if (!editable || draft === null) return
          setDraft(null)
          if (stored != null) {
            const c = clampNum(stored, min, max)
            if (c !== stored) commit(c)
          }
        }}
      />
    </Shell>
  )
}

export const NumberInput: ControlType = {
  type: 'NumberInput',
  label: 'Number input',
  icon: Hash,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Min', kind: 'number', group: 'Content', default: '=Blank()' },
    { name: 'Max', kind: 'number', group: 'Content', default: '=Blank()' },
    { name: 'Step', kind: 'number', group: 'Content', default: '=1' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="0"', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: null }],
  defaultSize: { width: 160, height: 40 },
  primaryProp: 'Default',
  render: NumberInputRender,
}
