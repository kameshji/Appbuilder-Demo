import { useRef, useState } from 'react'
import { Hash } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Input } from '@/components/ui/input'
import { displayModeProp, toDisplayMode, toNum, toText } from '../util'
import { Shell, useDefaultApply, useFocusToken } from './shared'
import { clampNum, fmtNum, numOrNull, snap } from './numeric'

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

  const commit = (n: number | null) => {
    sync.markBlank(n == null)
    setOutput('Value', n)
    fire('OnChange')
  }

  return (
    <Shell design={design} rootRef={root}>
      <Input
        type="text"
        inputMode="decimal"
        value={draft ?? fmtNum(stored)}
        placeholder={toText(props.Placeholder)}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        className="h-full w-full"
        style={{ fontSize: toNum(props.Size, 14), textAlign: 'right' }}
        onChange={(e) => {
          if (!editable) return
          const t = e.target.value
          if (!/^-?\d*\.?\d*$/.test(t)) return
          setDraft(t)
          if (t === '' || t === '-' || t === '.' || t === '-.') {
            if (t === '') commit(null)
            return
          }
          const n = Number(t)
          if (Number.isFinite(n)) commit(n)
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
