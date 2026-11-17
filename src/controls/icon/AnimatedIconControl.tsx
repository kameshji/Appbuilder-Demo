import { useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import type { Interaction } from 'react-useanimations'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { toBool, toColor, toNum, toText } from '../util'
import { AppIcon } from './AppIcon'
import { parseAnimatedName } from './catalog'

const INTERACTIONS: Record<string, Interaction | undefined> = {
  default: undefined,
  loop: 'loop',
  hover: 'hover',
  hoverloop: 'hover-loop',
  hoverreplay: 'hover-replay',
  clickreplay: 'click-replay',
  clicktoggle: 'click-toggle',
}

/** Interaction chosen by the maker; undefined = the icon's own (Default / unknown text). */
export function interactionOf(v: unknown): Interaction | undefined {
  return INTERACTIONS[toText(v as never).trim().toLowerCase().replace(/[\s_-]+/g, '')]
}

function AnimatedIconRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const name = toText(props.Icon)
  const meta = parseAnimatedName(name)
  const interaction = interactionOf(props.Interaction)
  const effective = interaction ?? meta?.interaction
  const toggle = effective === 'click-toggle'
  const propActive = toBool(props.Active, false)
  // the Active output follows the Active property whenever it changes
  useEffect(() => {
    setOutput('Active', propActive)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propActive])
  const active = outputs.Active == null ? propActive : toBool(outputs.Active, propActive)
  const size = toNum(props.Size, 32)
  const fit = size <= 0
  return (
    <div
      className="flex size-full items-center justify-center"
      inert={design}
      style={{ color: toColor(props.Color) ?? 'var(--foreground)', pointerEvents: design ? 'none' : undefined, cursor: design ? undefined : 'pointer' }}
      onClick={
        design
          ? undefined
          : () => {
              if (toggle) setOutput('Active', !active)
              fire('OnSelect')
            }
      }
    >
      <AppIcon
        name={name}
        fallback={Sparkles}
        size={fit ? '100%' : size}
        fillColor={toColor(props.FillColor)}
        interaction={interaction}
        active={toggle ? active : undefined}
        speed={Math.max(0.1, toNum(props.Speed, 1))}
        autoplay={effective === 'loop' ? toBool(props.Autoplay, true) : undefined}
        aria-label={meta?.title}
      />
    </div>
  )
}

export const AnimatedIconControl: ControlType = {
  type: 'AnimatedIcon',
  label: 'Animated icon',
  icon: Sparkles,
  category: 'Media',
  props: [
    { name: 'Icon', kind: 'icon', group: 'Content', default: '=AnimatedIcon.Heart' },
    {
      name: 'Interaction',
      kind: 'enum',
      group: 'Behaviour',
      default: '="Default"',
      options: ['"Default"', '"Loop"', '"Hover"', '"HoverLoop"', '"HoverReplay"', '"ClickReplay"', '"ClickToggle"'],
    },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'FillColor', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Size', kind: 'number', group: 'Style', default: '=32' },
    { name: 'Speed', kind: 'number', group: 'Behaviour', default: '=1', simple: false },
    { name: 'Active', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Autoplay', kind: 'boolean', group: 'Behaviour', default: '=true', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Active', initial: false }],
  defaultSize: { width: 64, height: 64 },
  primaryProp: 'Icon',
  render: AnimatedIconRender,
}
