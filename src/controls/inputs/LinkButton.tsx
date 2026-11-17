import { useRef } from 'react'
import { Link } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { alignOf, displayModeProp, toBool, toColor, toDisplayMode, toNum, toText } from '../util'
import { Shell, useFocusToken } from './shared'

function LinkButtonRender({ props, mode, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const align = alignOf(props.Align)
  const underline = toBool(props.Underline, false)
  return (
    <Shell design={design} rootRef={root}>
      <Button
        type="button"
        variant="link"
        disabled={dm === 'Disabled'}
        className={'size-full min-w-0 px-1 ' + (underline ? 'underline' : '')}
        style={{
          fontSize: toNum(props.Size, 14),
          color: toColor(props.Color),
          justifyContent: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
          cursor: dm === 'View' ? 'default' : undefined,
        }}
        onClick={() => {
          if (design || dm !== 'Edit') return
          fire('OnSelect')
        }}
      >
        <span className="truncate">{toText(props.Text)}</span>
      </Button>
    </Shell>
  )
}

export const LinkButton: ControlType = {
  type: 'LinkButton',
  label: 'Link button',
  icon: Link,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Learn more"' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Underline', kind: 'boolean', group: 'Style', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    {
      name: 'Align',
      kind: 'enum',
      group: 'Style',
      default: '=Align.Left',
      options: ['Align.Left', 'Align.Center', 'Align.Right'],
    },
    displayModeProp,
  ],
  outputs: [],
  defaultSize: { width: 120, height: 32 },
  primaryProp: 'OnSelect',
  render: LinkButtonRender,
}
