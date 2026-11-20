import { Calendar as CalendarIcon, Clock, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { triggerClass } from './shared'

/**
 * The phone's own date or time picker (P2-A follow-up): on touch devices the DatePicker, DateRangePicker, TimePicker and
 * the Form's date fields use `<input type="date">` / `<input type="time">`, which open the system wheel or calendar (the
 * best pickers a phone has; they also bring locale formats and accessibility). Values are exchanged as text and converted
 * by src/phone/touch-logic.ts, so the UI component's value contract (SelectedDate at local midnight, Value "HH:MM") does
 * not change. The field shows the device's date format (the Format property only applies to the desktop trigger); an
 * empty field shows the placeholder (iOS shows nothing for an empty date field); a clear button stays because iOS pickers
 * cannot clear.
 */
export function NativeField({
  kind,
  value,
  onValue,
  min,
  max,
  step,
  placeholder,
  disabled,
  invalid,
  id,
  fontSize,
  clearable,
  onBlur,
  label,
}: {
  kind: 'date' | 'time'
  /** yyyy-mm-dd or HH:MM, '' when empty */
  value: string
  onValue(v: string): void
  min?: string
  max?: string
  /** seconds (time fields): the minute step of the picker */
  step?: number
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  id?: string
  fontSize?: number
  clearable?: boolean
  onBlur?(): void
  label: string
}) {
  const Icon = kind === 'date' ? CalendarIcon : Clock
  const canClear = !!clearable && value !== '' && !disabled
  return (
    <div className="relative size-full min-w-0">
      <Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 opacity-60" />
      <input
        id={id}
        type={kind}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-native-field={kind}
        onChange={(e) => onValue(e.target.value)}
        onBlur={onBlur}
        className={cn(triggerClass, 'min-h-0 appearance-none justify-start pl-9 text-left [&::-webkit-date-and-time-value]:text-left [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:size-full [&::-webkit-calendar-picker-indicator]:opacity-0', value === '' && 'text-transparent', invalid && 'border-destructive', canClear && 'pr-10')}
        style={{ fontSize }}
      />
      {value === '' && placeholder && (
        <span className="pointer-events-none absolute left-9 top-1/2 max-w-[calc(100%-3rem)] -translate-y-1/2 truncate text-muted-foreground" style={{ fontSize }}>
          {placeholder}
        </span>
      )}
      {canClear && (
        <button
          type="button"
          aria-label={`Clear ${kind}`}
          data-touch-target=""
          className="absolute inset-y-0 right-3 z-10 my-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={() => onValue('')}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
