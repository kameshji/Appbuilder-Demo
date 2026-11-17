import { useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, ListFilter, X } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toText } from '../util'
import { Shell, isMultiple, itemText, selectionModeProp, triggerClass, useFocusToken } from './shared'
import { useItemSelection } from './selection'

const MAX_VISIBLE = 200

function ComboBoxRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const multiple = isMultiple(props.SelectionMode)
  const displayField = toText(props.DisplayField).trim()
  const searchFields = toText(props.SearchField).split(',').map((s) => s.trim()).filter((s) => s !== '')
  const sel = useItemSelection({ props, outputs, setOutput, multiple, field: displayField || undefined, withItems: true })
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const search = outputs.SearchText == null ? '' : toText(outputs.SearchText)
  const editable = !design && dm === 'Edit'
  const clearable = toBool(props.Clearable, true)
  const placeholder = toText(props.Placeholder)

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: number[] = []
    for (let i = 0; i < sel.items.length && out.length < MAX_VISIBLE; i++) {
      if (q === '') { out.push(i); continue }
      const rec = sel.items[i]
      const hay = searchFields.length > 0 ? searchFields.map((f) => toText(rec[f])).join(' ') : itemText(rec, displayField || undefined)
      if (hay.toLowerCase().includes(q)) out.push(i)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.items, search, displayField, searchFields.join(',')])

  const label =
    sel.selected.length === 0
      ? ''
      : multiple && sel.selected.length > 2
        ? `${sel.selected.length} selected`
        : sel.selected.map((i) => sel.texts[i]).join(', ')

  const toggle = (i: number) => {
    if (!editable) return
    if (multiple) {
      sel.set(sel.selected.includes(i) ? sel.selected.filter((x) => x !== i) : [...sel.selected, i])
    } else {
      sel.set([i])
      setOpen(false)
      setOutput('SearchText', '')
    }
    fire('OnChange')
  }

  return (
    <Shell design={design} rootRef={root} className="relative">
      <Popover
        open={open && editable}
        onOpenChange={(o) => {
          if (!editable) return
          setOpen(o)
          if (!o) setOutput('SearchText', '')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            disabled={dm === 'Disabled'}
            className={cn(triggerClass, clearable && label !== '' && dm === 'Edit' && 'pr-14')}
            style={{ fontSize: toNum(props.Size, 14) }}
          >
            <span className={cn('min-w-0 truncate text-left', label === '' && 'text-muted-foreground')}>{label === '' ? placeholder : label}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search..." value={search} onValueChange={(v) => setOutput('SearchText', v)} />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup>
                {visible.map((i) => (
                  <CommandItem key={i} value={String(i)} onSelect={() => toggle(i)}>
                    <Check className={cn('size-4', sel.selected.includes(i) ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{sel.texts[i] === '' ? ' ' : sel.texts[i]}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearable && label !== '' && dm === 'Edit' && (
        <button
          type="button"
          aria-label="Clear selection"
          tabIndex={design ? -1 : undefined}
          className="absolute inset-y-0 right-8 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (!editable) return
            sel.set([])
            fire('OnChange')
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </Shell>
  )
}

export const ComboBox: ControlType = {
  type: 'ComboBox',
  label: 'Combo box',
  icon: ListFilter,
  category: 'Input',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=["Apple", "Banana", "Cherry", "Mango", "Orange"]' },
    { name: 'DisplayField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'SearchField', kind: 'text', group: 'Data', default: '=""', simple: false },
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Select..."' },
    selectionModeProp('Single'),
    { name: 'Clearable', kind: 'boolean', group: 'Content', default: '=true', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Selected', initial: null },
    { name: 'SelectedItems', initial: [] },
    { name: 'SelectedText', initial: '' },
    { name: 'SearchText', initial: '' },
  ],
  defaultSize: { width: 260, height: 40 },
  primaryProp: 'Items',
  render: ComboBoxRender,
}
