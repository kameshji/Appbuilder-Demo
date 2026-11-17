import { DayPicker, type ClassNames, type DayPickerProps } from 'react-day-picker'
import { cn } from '@/lib/utils'

// Written against react-day-picker v10 class keys (button_previous, month_caption, day_button, ...).
const navButton =
  'inline-flex size-7 items-center justify-center rounded-md border border-border bg-transparent p-0 text-muted-foreground opacity-80 transition-colors hover:bg-accent hover:text-accent-foreground hover:opacity-100 disabled:pointer-events-none disabled:opacity-40'

const dayButton =
  'inline-flex size-8 items-center justify-center rounded-md p-0 text-sm font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40'

const defaultClassNames: Partial<ClassNames> = {
  root: 'p-3',
  months: 'relative flex flex-col gap-4 sm:flex-row',
  month: 'flex w-full flex-col gap-4',
  nav: 'absolute inset-x-3 top-3 flex items-center justify-between',
  button_previous: navButton,
  button_next: navButton,
  month_caption: 'flex h-8 items-center justify-center px-8',
  caption_label: 'text-sm font-medium',
  dropdowns: 'flex items-center gap-1',
  dropdown_root: 'relative',
  dropdown: 'rounded-md border border-border bg-popover px-1.5 py-1 text-sm',
  month_grid: 'w-full border-collapse',
  weekdays: 'flex',
  weekday: 'w-8 text-center text-[0.8rem] font-normal text-muted-foreground',
  week: 'mt-2 flex w-full',
  day: 'relative p-0 text-center text-sm',
  day_button: dayButton,
  week_number_header: 'w-8',
  week_number: 'w-8 text-center text-xs text-muted-foreground',
  today: '[&>button]:bg-accent [&>button]:text-accent-foreground',
  selected:
    '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground',
  range_start: '[&>button]:bg-primary [&>button]:text-primary-foreground',
  range_end: '[&>button]:bg-primary [&>button]:text-primary-foreground',
  range_middle: '[&>button]:rounded-none [&>button]:bg-accent [&>button]:text-accent-foreground',
  outside: 'text-muted-foreground opacity-60',
  disabled: 'text-muted-foreground opacity-40',
  hidden: 'invisible',
  footer: 'mt-2 text-sm',
  chevron: 'size-4 fill-current',
}

function mergeClassNames(base: Partial<ClassNames>, extra?: Partial<ClassNames>): Partial<ClassNames> {
  if (!extra) return base
  const out: Partial<ClassNames> = { ...base }
  for (const key of Object.keys(extra) as (keyof ClassNames)[]) {
    out[key] = cn(base[key], extra[key])
  }
  return out
}

function Calendar({ className, classNames, showOutsideDays = true, ...props }: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(className)}
      classNames={mergeClassNames(defaultClassNames, classNames)}
      {...props}
    />
  )
}

export { Calendar }
