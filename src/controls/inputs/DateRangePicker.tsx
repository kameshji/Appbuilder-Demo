import { useRef, useState } from 'react'
import { Calendar as CalendarIcon, CalendarRange } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toText } from '../util'
import { Shell, dateKey, formatDate, startOfDay, toDate, triggerClass, useDefaultApply, useFocusToken } from './shared'
import { useDevice } from '@/phone/env'
import { applyNativeRange, dateToNative, nativeToDate } from '@/phone/touch-logic'
import { NativeField } from './NativeDate'

function DateRangePickerRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const dStart = toDate(props.DefaultStart)
  const dEnd = toDate(props.DefaultEnd)
  const defStart = dStart ? startOfDay(dStart) : null
  const defEnd = dEnd ? startOfDay(dEnd) : null
  const blank = outputs.StartDate == null && outputs.EndDate == null
  const sync = useDefaultApply(dateKey(defStart) + '|' + dateKey(defEnd), blank, () => {
    setOutput('StartDate', defStart)
    setOutput('EndDate', defEnd)
  })
  const userBlank = sync.isUserBlank()
  const start = blank ? (userBlank ? null : defStart) : toDate(outputs.StartDate)
  const end = blank ? (userBlank ? null : defEnd) : toDate(outputs.EndDate)
  const [open, setOpen] = useState(false)
  const touch = useDevice().touch
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const fmt = toText(props.Format)
  const min = toDate(props.Min)
  const max = toDate(props.Max)
  const matchers = [...(min ? [{ before: startOfDay(min) }] : []), ...(max ? [{ after: startOfDay(max) }] : [])]
  const text = start ? `${formatDate(start, fmt)}${end ? ` - ${formatDate(end, fmt)}` : ''}` : ''

  const write = (s: Date | null, e: Date | null) => {
    sync.markBlank(s == null && e == null)
    setOutput('StartDate', s)
    setOutput('EndDate', e)
    fire('OnChange')
  }

  // touch devices: two native date fields (start and end), the phone's own date picker
  if (touch && !design && dm !== 'View') {
    const clearable = toBool(props.Clearable, true)
    const from = (which: 'start' | 'end') => (s: string) => {
      const d = nativeToDate(s, min, max)
      if (d === undefined) return
      const next = applyNativeRange(which, d, { start, end })
      write(next.start, next.end)
    }
    return (
      <Shell design={design} rootRef={root}>
        <div className="grid size-full grid-cols-2 gap-1.5">
          <NativeField kind="date" label="Start date" placeholder="Start" value={dateToNative(start)} min={min ? dateToNative(min) : undefined} max={max ? dateToNative(max) : undefined} disabled={dm === 'Disabled'} clearable={clearable} fontSize={toNum(props.Size, 14)} onValue={from('start')} />
          <NativeField kind="date" label="End date" placeholder="End" value={dateToNative(end)} min={dateToNative(start) || (min ? dateToNative(min) : undefined)} max={max ? dateToNative(max) : undefined} disabled={dm === 'Disabled'} clearable={clearable} fontSize={toNum(props.Size, 14)} onValue={from('end')} />
        </div>
      </Shell>
    )
  }
  return (
    <Shell design={design} rootRef={root}>
      <Popover open={open && editable} onOpenChange={(o) => editable && setOpen(o)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={dm === 'Disabled'}
            className={cn(triggerClass, 'justify-start')}
            style={{ fontSize: toNum(props.Size, 14) }}
          >
            <CalendarIcon className="size-4 shrink-0 opacity-60" />
            <span className={cn('min-w-0 flex-1 truncate text-left', text === '' && 'text-muted-foreground')}>
              {text === '' ? toText(props.Placeholder) : text}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={start ? ({ from: start, to: end ?? undefined } as DateRange) : undefined}
            defaultMonth={start ?? undefined}
            disabled={matchers.length > 0 ? matchers : undefined}
            onSelect={(r) => {
              if (!r || !r.from) { write(null, null); return }
              const from = startOfDay(r.from)
              const to = r.to ? startOfDay(r.to) : null
              write(from, to)
              if (to && from.getTime() !== to.getTime()) setOpen(false)
            }}
          />
          {toBool(props.Clearable, true) && (
            <div className="flex justify-end border-t border-border px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  write(null, null)
                  setOpen(false)
                }}
              >
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </Shell>
  )
}

export const DateRangePicker: ControlType = {
  type: 'DateRangePicker',
  label: 'Date range picker',
  icon: CalendarRange,
  category: 'Input',
  props: [
    { name: 'DefaultStart', label: 'Default start', kind: 'any', group: 'Content', default: '=Blank()' },
    { name: 'DefaultEnd', label: 'Default end', kind: 'any', group: 'Content', default: '=Blank()' },
    { name: 'Min', kind: 'any', group: 'Content', default: '=Blank()', simple: false },
    { name: 'Max', kind: 'any', group: 'Content', default: '=Blank()', simple: false },
    { name: 'Format', kind: 'text', group: 'Content', default: '="yyyy-mm-dd"' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Pick a date range"' },
    { name: 'Clearable', kind: 'boolean', group: 'Content', default: '=true', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [
    { name: 'StartDate', initial: null },
    { name: 'EndDate', initial: null },
  ],
  defaultSize: { width: 300, height: 40 },
  primaryProp: 'DefaultStart',
  render: DateRangePickerRender,
}
