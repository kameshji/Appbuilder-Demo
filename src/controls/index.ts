import type { ControlRegistryApi, ControlType, PropMeta } from '@/contracts'
import { Screen } from './Screen'
import { Label } from './Label'
import { Button } from './Button'
import { TextInput } from './TextInput'
import { Checkbox } from './Checkbox'
import { Toggle } from './Toggle'
import { Dropdown } from './Dropdown'
import { Image } from './Image'
import { Rectangle } from './Rectangle'
import { Container } from './Container'
import { Gallery } from './Gallery'
import { commonProps } from './util'
import { inputControls } from './sets/inputs'
import { displayControls } from './sets/display'
import { PrintButton } from './inputs/PrintButton'

/** Insert-pane order (Screen is not insertable). */
const insertable: ControlType[] = [Label, Button, TextInput, Checkbox, Toggle, Dropdown, Image, Rectangle, Container, Gallery, ...inputControls, PrintButton, ...displayControls]
const byType = new Map<string, ControlType>([[Screen.type, Screen], ...insertable.map((c): [string, ControlType] => [c.type, c])])

const propsCache = new Map<string, PropMeta[]>()

function get(type: string): ControlType {
  const c = byType.get(type)
  if (!c) throw new Error(`Unknown UI component type: ${type}`)
  return c
}

export const controls: ControlRegistryApi = {
  get,
  list: () => insertable.slice(),
  propsOf(type: string): PropMeta[] {
    const cached = propsCache.get(type)
    if (cached) return cached
    const c = get(type)
    const list =
      type === 'Screen' ? c.props.slice() : [...c.props, ...commonProps(c.defaultSize.width, c.defaultSize.height)]
    propsCache.set(type, list)
    return list
  },
}
