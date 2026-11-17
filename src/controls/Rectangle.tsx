import { Square } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { borderStyle, toColor, toNum } from './util'

function RectangleRender({ props }: ControlRenderProps) {
  return (
    <div
      className="box-border size-full"
      style={{
        background: toColor(props.Fill) ?? 'rgb(228,228,231)',
        borderRadius: toNum(props.Radius, 8),
        ...borderStyle(toColor(props.BorderColor), toNum(props.BorderWidth, 0)),
      }}
    />
  )
}

export const Rectangle: ControlType = {
  type: 'Rectangle',
  label: 'Rectangle',
  icon: Square,
  category: 'Display',
  props: [
    { name: 'Fill', kind: 'color', group: 'Style', default: '=RGBA(228, 228, 231, 1)' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=8' },
    { name: 'BorderColor', kind: 'color', group: 'Style', default: '=RGBA(161, 161, 170, 1)' },
    { name: 'BorderWidth', kind: 'number', group: 'Style', default: '=0' },
  ],
  outputs: [],
  defaultSize: { width: 160, height: 96 },
  primaryProp: 'Fill',
  render: RectangleRender,
}
