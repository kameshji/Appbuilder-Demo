import { useRef } from 'react'
import { ChevronDown, SquareSplitHorizontal } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { displayModeProp, toBool, toColor, toDisplayMode, toNum, toRecords, toText } from '../util'
import { Shell, itemText, resolveIcon, useFocusToken, variantOf, variantProp } from './shared'

function SplitButtonRender({ props, mode, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const items = toRecords(props.Items)
  const variant = variantOf(props.Variant)
  const fill = toColor(props.Fill)
  const color = toColor(props.Color)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const style = { fontSize: toNum(props.Size, 14), backgroundColor: fill, color }
  const pick = (rec: FxRecord) => {
    if (design || dm !== 'Edit') return
    setOutput('SelectedItem', rec)
    fire('OnItemSelect')
  }
  return (
    <Shell design={design} rootRef={root}>
      <div className="flex size-full items-stretch">
        <Button
          type="button"
          variant={variant}
          disabled={dm === 'Disabled'}
          className="h-full min-w-0 flex-1 rounded-r-none px-3 py-0"
          style={style}
          onClick={() => {
            if (design || dm !== 'Edit') return
            fire('OnSelect')
          }}
        >
          <span className="truncate">{toText(props.Text)}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              disabled={dm !== 'Edit' || items.length === 0}
              aria-label="More options"
              className="h-full w-9 shrink-0 rounded-l-none border-l border-l-background/30 px-0 py-0"
              style={style}
            >
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {items.map((rec, i) => {
              const Icon = resolveIcon(rec.Icon)
              return (
                <DropdownMenuItem key={i} disabled={toBool(rec.Disabled, false)} onSelect={() => pick(rec)}>
                  {Icon && <Icon className="size-4" />}
                  <span className="truncate">{itemText(rec)}</span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Shell>
  )
}

export const SplitButton: ControlType = {
  type: 'SplitButton',
  label: 'Split button',
  icon: SquareSplitHorizontal,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Save"' },
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Save as draft", "Save and close", "Save as template"]' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnItemSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    variantProp('Default'),
    { name: 'Size', label: 'Font size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Fill', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()', simple: false },
    displayModeProp,
  ],
  outputs: [{ name: 'SelectedItem', initial: null }],
  defaultSize: { width: 150, height: 40 },
  primaryProp: 'OnSelect',
  render: SplitButtonRender,
}
