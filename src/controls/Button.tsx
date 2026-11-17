import { MousePointerClick } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button as UiButton } from '@/components/ui/button'
import { displayModeProp, toColor, toDisplayMode, toNum, toText } from './util'

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'
function variantOf(style: string): Variant {
  switch (style.trim().toLowerCase()) {
    case 'secondary': return 'secondary'
    case 'outline': return 'outline'
    case 'ghost': return 'ghost'
    case 'destructive': return 'destructive'
    default: return 'default'
  }
}

function ButtonRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const fill = toColor(props.Fill)
  const color = toColor(props.Color)
  return (
    <UiButton
      variant={variantOf(toText(props.Style))}
      tabIndex={design ? -1 : undefined}
      disabled={dm === 'Disabled'}
      className="size-full min-w-0 overflow-hidden px-3 py-0"
      style={{
        fontSize: toNum(props.Size, 14),
        borderRadius: toNum(props.Radius, 8),
        backgroundColor: fill,
        color,
        pointerEvents: design ? 'none' : undefined,
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
      <span className="truncate">{toText(props.Text)}</span>
    </UiButton>
  )
}

export const Button: ControlType = {
  type: 'Button',
  label: 'Button',
  icon: MousePointerClick,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Button"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    {
      name: 'Style',
      kind: 'enum',
      group: 'Style',
      default: '=ButtonStyle.Primary',
      options: [
        'ButtonStyle.Primary',
        'ButtonStyle.Secondary',
        'ButtonStyle.Outline',
        'ButtonStyle.Ghost',
        'ButtonStyle.Destructive',
      ],
    },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=8' },
    displayModeProp,
  ],
  outputs: [{ name: 'Pressed', initial: false }],
  defaultSize: { width: 120, height: 40 },
  primaryProp: 'OnSelect',
  render: ButtonRender,
}
