import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { displayModeProp, recordText, toDisplayMode, toRecords, toText } from './util'
import { queryMeta } from './virtual'
import { cn } from '@/lib/utils'
import { useDevice } from '@/phone/env'
import { PickerSheet } from '@/phone/sheet-picker'
import { filterOptions } from '@/phone/touch-logic'
import { triggerClass } from './inputs/shared'
import { ComboBoxRender } from './inputs/ComboBox'

function DropdownRender(p: ControlRenderProps) {
  // server mode, Items from a large table: rows load lazily with a type-ahead search on the server
  if (queryMeta(p.props.Items)) return <ComboBoxRender {...p} props={{ ...p.props, SelectionMode: 'Single', Clearable: false, Size: 14 }} />
  return <PlainDropdown {...p} />
}

function PlainDropdown({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const texts = useMemo(() => items.map(recordText), [items])
  const textsKey = texts.join('\u0001')
  const def = toText(props.Default)
  const selectedText = outputs.SelectedText == null ? '' : toText(outputs.SelectedText)
  const placeholder = toText(props.Placeholder)
  // touch devices: the list opens as a bottom sheet with a search field (src/phone/sheet-picker.tsx)
  const touch = useDevice().touch
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

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

  if (touch) {
    const close = () => { setOpen(false); setSearch('') }
    return (
      <>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={dm !== 'Edit'}
          onClick={() => setOpen(true)}
          className={cn(triggerClass, 'h-full', selIndex < 0 && 'text-muted-foreground')}
        >
          <span className="min-w-0 truncate text-left">{selIndex < 0 ? placeholder : texts[selIndex]}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
        <PickerSheet
          open={open && dm === 'Edit'}
          onClose={close}
          label={placeholder || 'Select an item'}
          rows={filterOptions(texts, search).map((i) => ({ index: i, text: texts[i], selected: i === selIndex }))}
          search={search}
          onSearch={setSearch}
          onPick={(i) => {
            setOutput('Selected', items[i])
            setOutput('SelectedText', texts[i])
            fire('OnChange')
            close()
          }}
        />
      </>
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
    // type-ahead text when the items are a large server table (searched on the server)
    { name: 'SearchText', initial: '' },
  ],
  defaultSize: { width: 240, height: 40 },
  primaryProp: 'Items',
  render: DropdownRender,
}
