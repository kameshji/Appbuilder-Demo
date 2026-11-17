import { SquareDashed } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { borderStyle, toBool, toColor, toNum } from './util'

function ContainerRender({ props, mode, children }: ControlRenderProps) {
  return (
    <div
      className="relative box-border size-full"
      style={{
        background: toColor(props.Fill) ?? '#fff',
        borderRadius: toNum(props.Radius, 12),
        overflow: mode === 'design' ? 'visible' : 'hidden',
        boxShadow: toBool(props.Shadow, true)
          ? '0 1px 3px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)'
          : undefined,
        ...borderStyle(toColor(props.BorderColor), toNum(props.BorderWidth, 1)),
      }}
    >
      {children}
    </div>
  )
}

export const Container: ControlType = {
  type: 'Container',
  label: 'Container',
  icon: SquareDashed,
  category: 'Layout',
  props: [
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.White' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=12' },
    { name: 'BorderColor', kind: 'color', group: 'Style', default: '=RGBA(228, 228, 231, 1)' },
    { name: 'BorderWidth', kind: 'number', group: 'Style', default: '=1' },
    { name: 'Shadow', kind: 'boolean', group: 'Style', default: '=true' },
  ],
  outputs: [],
  defaultSize: { width: 320, height: 240 },
  isContainer: true,
  primaryProp: 'Fill',
  render: ContainerRender,
}
