import { Monitor } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { toColor } from './util'

function ScreenRender({ props, children }: ControlRenderProps) {
  return (
    <div className="relative size-full overflow-hidden" style={{ background: toColor(props.Fill) ?? '#fff' }}>
      {children}
    </div>
  )
}

export const Screen: ControlType = {
  type: 'Screen',
  label: 'Screen',
  icon: Monitor,
  category: 'Layout',
  props: [
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Color.White' },
    { name: 'OnVisible', kind: 'action', group: 'Behaviour', default: '=false', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 1024, height: 640 },
  isContainer: true,
  primaryProp: 'Fill',
  render: ScreenRender,
}
