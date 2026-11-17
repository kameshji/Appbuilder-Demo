import { useState } from 'react'
import { Calendar as CalendarIcon, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate, startOfDay, triggerClass } from './shared'

export interface DatePopoverProps {
  value: Date | null
  onChange(d: Date | null): void
  min?: Date | null
  max?: Date | null
  format?: string
  placeholder?: string
  disabled?: boolean
  /** shows the value but never opens */
  readOnly?: boolean
  clearable?: boolean
  fontSize?: number
  invalid?: boolean
  id?: string
  onBlur?(): void
}

/** Trigger button + calendar popover (single date). Shared by DatePicker and Form date fields. */
export function DatePopover(p: DatePopoverProps) {
  const [open, setOpen] = useState(false)
  const canOpen = !p.disabled && !p.readOnly
  const matchers = [
    ...(p.min ? [{ before: startOfDay(p.min) }] : []),
    ...(p.max ? [{ after: startOfDay(p.max) }] : []),
  ]
  const text = p.value ? formatDate(p.value, p.format ?? 'yyyy-mm-dd') : ''
  return (
    <div className="relative size-full">
      <Popover
        open={open && canOpen}
        onOpenChange={(o) => {
          if (!canOpen) return
          setOpen(o)
          if (!o) p.onBlur?.()
        }}
      >
        <PopoverTrigger asChild>
          <button
            id={p.id}
            type="button"
            disabled={p.disabled}
            aria-invalid={p.invalid || undefined}
            className={cn(triggerClass, 'justify-start', p.invalid && 'border-destructive', p.clearable && p.value && canOpen && 'pr-9')}
            style={{ fontSize: p.fontSize }}
          >
            <CalendarIcon className="size-4 shrink-0 opacity-60" />
            <span className={cn('min-w-0 flex-1 truncate text-left', text === '' && 'text-muted-foreground')}>{text === '' ? p.placeholder : text}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            selected={p.value ?? undefined}
            defaultMonth={p.value ?? undefined}
            disabled={matchers.length > 0 ? matchers : undefined}
            onSelect={(d) => {
              p.onChange(d ? startOfDay(d) : null)
              if (d) setOpen(false)
            }}
          />
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const t = startOfDay(new Date())
                if (p.min && t < startOfDay(p.min)) return
                if (p.max && t > startOfDay(p.max)) return
                p.onChange(t)
                setOpen(false)
              }}
            >
              Today
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                p.onChange(null)
                setOpen(false)
              }}
            >
              Clear
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {p.clearable && p.value && canOpen && (
        <button
          type="button"
          aria-label="Clear date"
          className="absolute inset-y-0 right-2 my-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={() => p.onChange(null)}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
