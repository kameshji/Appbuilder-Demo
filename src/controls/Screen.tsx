import { Monitor } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { toColor } from './util'
import { LayoutBox, layoutProps } from './display/helpers'

function ScreenRender({ props, mode, children }: ControlRenderProps) {
  // The Screen always clips to the app frame (its overflow is hidden unless Scroll is on).
  return (
    <LayoutBox props={props} mode={mode === 'design' ? 'run' : mode} className="size-full" style={{ background: toColor(props.Fill) ?? '#fff' }}>
      {children}
    </LayoutBox>
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
    ...layoutProps({ layout: 'manual', gap: 16, padding: 0 }),
  ],
  outputs: [],
  defaultSize: { width: 1024, height: 640 },
  isContainer: true,
  primaryProp: 'Fill',
  render: ScreenRender,
}
