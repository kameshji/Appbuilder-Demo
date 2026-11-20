/**
 * Picker in a bottom sheet (P2-A follow-up): the touch version of the Dropdown / ComboBox list. A search field on top
 * (it does not take the focus by itself, so the keyboard does not hide the list when the sheet opens), 44 px rows and,
 * for multiple selection, a Done button. The filtering is the caller's (it knows server-side search and DisplayField):
 * it passes the rows to show.
 */
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { BottomSheet } from './sheet'

export interface PickerRow {
  /** index in the caller's list (passed back to onPick) */
  index: number
  text: string
  selected: boolean
}

export function PickerSheet({
  open,
  onClose,
  label,
  rows,
  search,
  onSearch,
  onPick,
  multiple = false,
  emptyText = 'No results.',
  note,
  onNearEnd,
  searchPlaceholder = 'Search...',
}: {
  open: boolean
  onClose: () => void
  label: string
  rows: PickerRow[]
  search: string
  onSearch: (v: string) => void
  onPick: (index: number) => void
  multiple?: boolean
  emptyText?: ReactNode
  /** a line under the rows (loading more, counts) */
  note?: ReactNode
  /** the list was scrolled near its end (load more rows) */
  onNearEnd?: () => void
  searchPlaceholder?: string
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label={label}
      footer={multiple ? <Button type="button" className="h-11 w-full" onClick={onClose} data-testid="picker-sheet-done">Done</Button> : undefined}
    >
      <Command shouldFilter={false} className="min-h-0 flex-1 rounded-none bg-transparent" data-testid="picker-sheet">
        <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={onSearch} inputMode="search" enterKeyHint="search" />
        <CommandList
          className="max-h-none min-h-0 flex-1 overscroll-contain"
          onScroll={(e) => {
            const el = e.currentTarget
            if (onNearEnd && el.scrollTop + el.clientHeight > el.scrollHeight - 160) onNearEnd()
          }}
        >
          <CommandEmpty>{emptyText}</CommandEmpty>
          <CommandGroup>
            {rows.map((r) => (
              <CommandItem key={r.index} value={String(r.index)} onSelect={() => onPick(r.index)} className="min-h-11 gap-3 py-2.5 text-base" data-testid="picker-row">
                <Check className={cn('size-4', r.selected ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0 flex-1 truncate">{r.text === '' ? ' ' : r.text}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {note}
        </CommandList>
      </Command>
    </BottomSheet>
  )
}
