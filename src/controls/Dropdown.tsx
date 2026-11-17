import { useEffect, useMemo } from 'react'
import { ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { displayModeProp, recordText, toDisplayMode, toRecords, toText } from './util'

function DropdownRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const texts = useMemo(() => items.map(recordText), [items])
  const textsKey = texts.join('\u0001')
  const def = toText(props.Default)
  const selectedText = outputs.SelectedText == null ? '' : toText(outputs.SelectedText)
  const placeholder = toText(props.Placeholder)

  // Default sync: apply Default when it changes, or when nothing is selected yet.
  useEffect(() => {
    if (def === '') return
    if (selectedText !== '' && selectedText === def) return
    const i = texts.indexOf(def)
    if (i < 0) return
    setOutput('Selected', items[i])
    setOutput('SelectedText', texts[i])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, textsKey])

  const selIndex = selectedText === '' ? -1 : texts.indexOf(selectedText)

  if (design) {
    return (
      <div className="pointer-events-none flex size-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs">
        <span className={'min-w-0 truncate ' + (selIndex < 0 ? 'text-muted-foreground' : '')}>
          {selIndex < 0 ? placeholder : texts[selIndex]}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </div>
    )
  }

  return (
    <Select
      value={selIndex >= 0 ? String(selIndex) : ''}
      disabled={dm !== 'Edit'}
      onValueChange={(v) => {
        const i = Number(v)
        if (!Number.isInteger(i) || i < 0 || i >= items.length) return
        setOutput('Selected', items[i])
        setOutput('SelectedText', texts[i])
        fire('OnChange')
      }}
    >
      <SelectTrigger className="h-full w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {texts.map((t, i) => (
          <SelectItem key={i} value={String(i)}>
            {t === '' ? ' ' : t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const Dropdown: ControlType = {
  type: 'Dropdown',
  label: 'Dropdown',
  icon: ChevronsUpDown,
  category: 'Input',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["One", "Two", "Three"]' },
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Select..."' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedText', initial: '' },
  ],
  defaultSize: { width: 240, height: 40 },
  primaryProp: 'Items',
  render: DropdownRender,
}
