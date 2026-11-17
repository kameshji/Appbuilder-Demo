import { useRef } from 'react'
import { PanelTop } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { displayModeProp, toColor, toDisplayMode, toNum } from '../util'
import { Shell, useFocusToken } from './shared'
import { useItemSelection } from './selection'

function SegmentedRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const sel = useItemSelection({ props, outputs, setOutput, multiple: false, withItems: false })
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const color = toColor(props.Color)
  const active = sel.selected[0] ?? -1
  const editable = !design && dm === 'Edit'
  const choose = (i: number) => {
    if (!editable || i === active) return
    sel.set([i])
    fire('OnChange')
  }
  return (
    <Shell design={design} rootRef={root}>
      <div
        role="radiogroup"
        className="flex size-full items-stretch gap-1 rounded-lg bg-muted p-1"
        style={{ opacity: dm === 'Disabled' ? 0.5 : 1, fontSize: toNum(props.Size, 14) }}
      >
        {sel.texts.map((t, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={i === active}
            disabled={dm === 'Disabled'}
            tabIndex={i === active || (active < 0 && i === 0) ? 0 : -1}
            className={
              'min-w-0 flex-1 truncate rounded-md px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ' +
              (i === active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
            }
            style={i === active && color ? { backgroundColor: color, color: '#fff' } : undefined}
            onClick={() => choose(i)}
            onKeyDown={(e) => {
              if (!editable) return
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                choose((i + 1) % sel.texts.length)
                ;(e.currentTarget.parentElement?.children[(i + 1) % sel.texts.length] as HTMLElement | undefined)?.focus()
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = (i - 1 + sel.texts.length) % sel.texts.length
                choose(n)
                ;(e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus()
              }
            }}
          >
            {t}
          </button>
        ))}
      </div>
    </Shell>
  )
}

export const SegmentedControl: ControlType = {
  type: 'SegmentedControl',
  label: 'Segmented control',
  icon: PanelTop,
  category: 'Input',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Day", "Week", "Month"]' },
    { name: 'Default', kind: 'text', group: 'Content', default: '="Day"' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    displayModeProp,
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
  ],
  defaultSize: { width: 280, height: 40 },
  primaryProp: 'Items',
  render: SegmentedRender,
}
