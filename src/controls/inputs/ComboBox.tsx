import { useEffect, useMemo, useRef, useState } from 'react'
import { queryMeta } from '../virtual'
import { Check, ChevronsUpDown, ListFilter, X } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toText } from '../util'
import { Shell, isMultiple, itemText, selectionModeProp, triggerClass, useFocusToken } from './shared'
import { useItemSelection } from './selection'

const MAX_VISIBLE = 200

export function ComboBoxRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const multiple = isMultiple(props.SelectionMode)
  const displayField = toText(props.DisplayField).trim()
  const searchFields = toText(props.SearchField).split(',').map((s) => s.trim()).filter((s) => s !== '')
  const sel = useItemSelection({ props, outputs, setOutput, multiple, field: displayField || undefined, withItems: true })
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  // server mode: a table's rows arrive page by page and the search runs on the server (type-ahead)
  const meta = queryMeta(props.Items)
  const searchOut = outputs.SearchText == null ? '' : toText(outputs.SearchText)
  const [typed, setTyped] = useState(searchOut)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { if (!timer.current) setTyped(searchOut) }, [searchOut])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const search = meta ? typed : searchOut
  const setSearch = (v: string) => {
    if (!meta) return setOutput('SearchText', v)
    setTyped(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setOutput('SearchText', v)
    }, 250)
  }
  const editable = !design && dm === 'Edit'
  const clearable = toBool(props.Clearable, true)
  const placeholder = toText(props.Placeholder)

  const visible = useMemo(() => {
    const q = meta ? '' : search.trim().toLowerCase()
    const out: number[] = []
    for (let i = 0; i < sel.items.length && (meta || out.length < MAX_VISIBLE); i++) {
      if (q === '') { out.push(i); continue }
      const rec = sel.items[i]
      const hay = searchFields.length > 0 ? searchFields.map((f) => toText(rec[f])).join(' ') : itemText(rec, displayField || undefined)
      if (hay.toLowerCase().includes(q)) out.push(i)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.items, search, displayField, searchFields.join(','), meta])

  // the label comes from the selected records themselves (they may not be among the rows loaded now)
  const label =
    sel.current.length === 0
      ? ''
      : multiple && sel.current.length > 2
        ? `${sel.current.length} selected`
        : sel.current.map((r) => itemText(r, displayField || undefined)).join(', ')

  const toggle = (i: number) => {
    if (!editable) return
    if (multiple) {
      sel.set(sel.selected.includes(i) ? sel.selected.filter((x) => x !== i) : [...sel.selected, i], true)
    } else {
      sel.set([i])
      setOpen(false)
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      setTyped('')
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
          if (!o) {
            if (timer.current) { clearTimeout(timer.current); timer.current = null }
            setTyped('')
            setOutput('SearchText', '')
          }
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
            <CommandInput placeholder="Search..." value={search} onValueChange={setSearch} />
            <CommandList
              onScroll={(e) => {
                const el = e.currentTarget
                if (meta?.hasMore && !meta.loadingMore && el.scrollTop + el.clientHeight > el.scrollHeight - 120) void meta.loadMore()
              }}
            >
              <CommandEmpty>{meta && (meta.refreshing || timer.current) ? 'Searching…' : 'No results.'}</CommandEmpty>
              <CommandGroup>
                {visible.map((i) => (
                  <CommandItem key={i} value={String(i)} onSelect={() => toggle(i)}>
                    <Check className={cn('size-4', sel.selected.includes(i) ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{sel.texts[i] === '' ? ' ' : sel.texts[i]}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {meta?.hasMore && <div className="px-2 py-1.5 text-xs text-muted-foreground">{meta.loadingMore ? 'Loading…' : `${sel.items.length.toLocaleString('en-US')} of ${(meta.count ?? 0).toLocaleString('en-US')}: scroll or type to narrow`}</div>}
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
