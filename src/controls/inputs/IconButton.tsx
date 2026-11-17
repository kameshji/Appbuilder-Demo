import { useRef } from 'react'
import { Plus, SquareMousePointer } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { displayModeProp, toColor, toDisplayMode, toText } from '../util'
import { Shell, resolveIcon, sizeOf, sizeProp, useFocusToken, variantOf, variantProp } from './shared'

const ICON_PX = { sm: 16, md: 20, lg: 26 } as const

function IconButtonRender({ props, mode, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const Icon = resolveIcon(props.Icon, Plus) ?? Plus
  const px = ICON_PX[sizeOf(props.Size)]
  const shape = toText(props.Shape).trim().toLowerCase()
  const radius = shape === 'circle' ? 9999 : shape === 'square' ? 0 : 8
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  return (
    <Shell design={design} rootRef={root}>
      <Button
        type="button"
        variant={variantOf(props.Variant)}
        disabled={dm === 'Disabled'}
        aria-label={toText(props.Tooltip) || toText(props.Icon) || 'Button'}
        className="size-full min-w-0 p-0"
        style={{
          borderRadius: radius,
          backgroundColor: toColor(props.Fill),
          color: toColor(props.Color),
          cursor: dm === 'View' ? 'default' : undefined,
        }}
        onPointerDown={() => { if (!design && dm === 'Edit') setOutput('Pressed', true) }}
        onPointerUp={() => { if (!design) setOutput('Pressed', false) }}
        onPointerLeave={() => { if (!design) setOutput('Pressed', false) }}
        onClick={() => {
          if (design || dm !== 'Edit') return
          fire('OnSelect')
        }}
      >
        <Icon style={{ width: px, height: px }} />
      </Button>
    </Shell>
  )
}

export const IconButton: ControlType = {
  type: 'IconButton',
  label: 'Icon button',
  icon: SquareMousePointer,
  category: 'Input',
  props: [
    { name: 'Icon', kind: 'icon', group: 'Content', default: '="Plus"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    variantProp('Default'),
    sizeProp('Medium'),
    {
      name: 'Shape',
      kind: 'enum',
      group: 'Style',
      default: '="Rounded"',
      options: ['"Rounded"', '"Circle"', '"Square"'],
    },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    displayModeProp,
  ],
  outputs: [{ name: 'Pressed', initial: false }],
  defaultSize: { width: 40, height: 40 },
  primaryProp: 'OnSelect',
  render: IconButtonRender,
}
