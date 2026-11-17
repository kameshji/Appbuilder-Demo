import { useRef, useState } from 'react'
import { Star } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { displayModeProp, toColor, toDisplayMode, toNum } from '../util'
import { Shell, themed, useDefaultApply, useFocusToken } from './shared'

function RatingRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const max = Math.min(20, Math.max(1, Math.round(toNum(props.Max, 5))))
  const def = Math.min(max, Math.max(0, Math.round(toNum(props.Default, 0))))
  useDefaultApply(String(def), outputs.Value == null, () => setOutput('Value', def))
  const value = Math.min(max, Math.max(0, outputs.Value == null ? def : Math.round(toNum(outputs.Value, def))))
  const [hover, setHover] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const shown = editable && hover != null ? hover : value
  const color = themed(toColor(props.Color), '--primary')
  const iconSize = toNum(props.Size, 24)
  const write = (n: number) => {
    if (!editable || n === value) return
    setOutput('Value', n)
    fire('OnChange')
  }
  const set = (n: number) => write(n === value ? 0 : n)
  return (
    <Shell design={design} rootRef={root}>
      <div
        role="radiogroup"
        aria-label="Rating"
        className="flex size-full items-center gap-1"
        style={{ opacity: dm === 'Disabled' ? 0.5 : 1 }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: max }, (_, i) => {
          const n = i + 1
          const on = n <= shown
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === value}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              disabled={dm === 'Disabled'}
              tabIndex={n === Math.max(1, value) ? 0 : -1}
              className="shrink-0 rounded-sm p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
              style={{ cursor: editable ? 'pointer' : 'default' }}
              onMouseEnter={() => editable && setHover(n)}
              onClick={() => set(n)}
              onKeyDown={(e) => {
                if (!editable) return
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); write(Math.min(max, value + 1)) }
                if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); write(Math.max(0, value - 1)) }
              }}
            >
              <Star
                style={{ width: iconSize, height: iconSize, color: on ? color : 'var(--muted-foreground)', fill: on ? color : 'transparent', opacity: on ? 1 : 0.5 }}
              />
            </button>
          )
        })}
      </div>
    </Shell>
  )
}

export const Rating: ControlType = {
  type: 'Rating',
  label: 'Rating',
  icon: Star,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'number', group: 'Content', default: '=0' },
    { name: 'Max', kind: 'number', group: 'Content', default: '=5' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', label: 'Star size', kind: 'number', group: 'Style', default: '=24' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: null }],
  defaultSize: { width: 180, height: 32 },
  primaryProp: 'Default',
  render: RatingRender,
}
