import { Type } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { alignOf, alignProp, fontWeightOf, toColor, toNum, toText } from './util'

function LabelRender({ props }: ControlRenderProps) {
  const align = alignOf(props.Align)
  return (
    <div
      className="flex size-full select-none overflow-hidden whitespace-pre-wrap break-words leading-snug"
      style={{
        fontSize: toNum(props.Size, 14),
        color: toColor(props.Color) ?? 'rgb(24,24,27)',
        fontWeight: fontWeightOf(props.FontWeight),
        textAlign: align,
        background: toColor(props.Fill),
        alignItems: 'center',
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      <span className="max-h-full min-w-0">{toText(props.Text)}</span>
    </div>
  )
}

export const Label: ControlType = {
  type: 'Label',
  label: 'Label',
  icon: Type,
  category: 'Display',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Label"' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=RGBA(24, 24, 27, 1)' },
    {
      name: 'FontWeight',
      kind: 'enum',
      group: 'Style',
      default: '=FontWeight.Normal',
      options: ['FontWeight.Normal', 'FontWeight.Semibold', 'FontWeight.Bold'],
    },
    alignProp,
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.Transparent' },
  ],
  outputs: [],
  defaultSize: { width: 200, height: 32 },
  primaryProp: 'Text',
  render: LabelRender,
}
