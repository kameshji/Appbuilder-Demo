import { useRef } from 'react'
import { ChevronDown, Menu } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { displayModeProp, toBool, toColor, toDisplayMode, toNum, toRecords, toText } from '../util'
import { Shell, itemText, resolveIcon, useFocusToken, variantOf, variantProp } from './shared'

function MenuButtonRender({ props, mode, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const items = toRecords(props.Items)
  const text = toText(props.Text)
  const Icon = resolveIcon(props.Icon)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const pick = (rec: FxRecord) => {
    if (design || dm !== 'Edit') return
    setOutput('SelectedItem', rec)
    fire('OnItemSelect')
  }
  return (
    <Shell design={design} rootRef={root}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={variantOf(props.Variant, 'outline')}
            disabled={dm !== 'Edit'}
            aria-label={text || 'Menu'}
            className="size-full min-w-0 px-3 py-0"
            style={{ fontSize: toNum(props.Size, 14), backgroundColor: toColor(props.Fill), color: toColor(props.Color) }}
          >
            {Icon && <Icon className="size-4" />}
            {text !== '' && <span className="truncate">{text}</span>}
            {toBool(props.ShowChevron, true) && <ChevronDown className="size-4 opacity-60" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {items.map((rec, i) => {
            const ItemIcon = resolveIcon(rec.Icon)
            const label = itemText(rec)
            if (label === '-' || toBool(rec.Separator, false)) return <DropdownMenuSeparator key={i} />
            return (
              <DropdownMenuItem key={i} disabled={toBool(rec.Disabled, false)} variant={toBool(rec.Destructive, false) ? 'destructive' : 'default'} onSelect={() => pick(rec)}>
                {ItemIcon && <ItemIcon className="size-4" />}
                <span className="truncate">{label}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </Shell>
  )
}

export const MenuButton: ControlType = {
  type: 'MenuButton',
  label: 'Menu button',
  icon: Menu,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Actions"' },
    { name: 'Icon', kind: 'icon', group: 'Content', default: '=""' },
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default: '=Table({Label: "Edit", Icon: "Pencil"}, {Label: "Duplicate", Icon: "Copy"}, {Label: "Delete", Icon: "Trash"})',
    },
    { name: 'OnItemSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    variantProp('Outline'),
    { name: 'ShowChevron', label: 'Show chevron', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'Size', label: 'Font size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    displayModeProp,
  ],
  outputs: [{ name: 'SelectedItem', initial: null }],
  defaultSize: { width: 140, height: 40 },
  primaryProp: 'Items',
  render: MenuButtonRender,
}
