import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxValue } from '@/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toText } from '../util'
import { Shell, triggerClass, useDefaultApply, useFocusToken } from './shared'

export interface Hm { h: number; m: number }

export function parseTime(v: FxValue | undefined): Hm | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { h: v.getHours(), m: v.getMinutes() }
  const s = toText(v).trim()
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

const p2 = (n: number) => String(n).padStart(2, '0')
export const timeValue = (t: Hm | null) => (t ? `${p2(t.h)}:${p2(t.m)}` : '')
export function timeLabel(t: Hm | null, use24: boolean): string {
  if (!t) return ''
  if (use24) return timeValue(t)
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12
  return `${h12}:${p2(t.m)} ${t.h < 12 ? 'AM' : 'PM'}`
}

function Column({ items, active, onPick }: { items: { label: string; value: number }[]; active: number | null; onPick(v: number): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'center' })
  }, [])
  return (
    <div ref={ref} className="flex max-h-56 w-14 flex-col gap-0.5 overflow-y-auto p-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          data-active={active === it.value}
          className={cn(
            'rounded-md px-2 py-1.5 text-center text-sm tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
            active === it.value && 'bg-primary text-primary-foreground hover:bg-primary',
          )}
          onClick={() => onPick(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

function TimePickerRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const use24 = toBool(props.Use24Hour, true)
  const step = Math.min(30, Math.max(1, Math.round(toNum(props.MinuteStep, 5))))
  const def = parseTime(props.Default)
  const write = (t: Hm | null) => {
    setOutput('Value', timeValue(t))
    setOutput('Hour', t ? t.h : null)
    setOutput('Minute', t ? t.m : null)
  }
  const sync = useDefaultApply(timeValue(def), toText(outputs.Value) === '', () => write(def))
  const cur = toText(outputs.Value) === '' ? (sync.isUserBlank() ? null : def) : parseTime(outputs.Value)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const text = timeLabel(cur, use24)

  const commit = (t: Hm | null) => {
    if (!editable) return
    sync.markBlank(t == null)
    write(t)
    fire('OnChange')
  }
  const hourItems = use24
    ? Array.from({ length: 24 }, (_, h) => ({ label: p2(h), value: h }))
    : Array.from({ length: 12 }, (_, i) => ({ label: String(i === 0 ? 12 : i), value: i }))
  const minuteItems = Array.from({ length: Math.ceil(60 / step) }, (_, i) => ({ label: p2(i * step), value: i * step }))
  const pm = cur ? cur.h >= 12 : false
  const hourActive = cur ? (use24 ? cur.h : cur.h % 12) : null

  return (
    <Shell design={design} rootRef={root}>
      <Popover open={open && editable} onOpenChange={(o) => editable && setOpen(o)}>
        <PopoverTrigger asChild>
          <button type="button" disabled={dm === 'Disabled'} className={cn(triggerClass, 'justify-start')} style={{ fontSize: toNum(props.Size, 14) }}>
            <Clock className="size-4 shrink-0 opacity-60" />
            <span className={cn('min-w-0 flex-1 truncate text-left', text === '' && 'text-muted-foreground')}>{text === '' ? toText(props.Placeholder) : text}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-1">
          <div className="flex">
            <Column
              items={hourItems}
              active={hourActive}
              onPick={(v) => commit({ h: use24 ? v : (v % 12) + (pm ? 12 : 0), m: cur?.m ?? 0 })}
            />
            <div className="w-px bg-border" />
            <Column items={minuteItems} active={cur ? cur.m : null} onPick={(v) => commit({ h: cur?.h ?? 9, m: v })} />
            {!use24 && (
              <>
                <div className="w-px bg-border" />
                <Column
                  items={[{ label: 'AM', value: 0 }, { label: 'PM', value: 1 }]}
                  active={cur ? (pm ? 1 : 0) : null}
                  onPick={(v) => {
                    const base = cur ?? { h: 9, m: 0 }
                    commit({ h: (base.h % 12) + (v === 1 ? 12 : 0), m: base.m })
                  }}
                />
              </>
            )}
          </div>
          <div className="flex justify-between border-t border-border px-2 pb-1 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const n = new Date()
                commit({ h: n.getHours(), m: n.getMinutes() })
                setOpen(false)
              }}
            >
              Now
            </Button>
            {toBool(props.Clearable, true) && (
              <Button type="button" variant="ghost" size="xs" onClick={() => { commit(null); setOpen(false) }}>
                Clear
              </Button>
            )}
            <Button type="button" size="xs" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </Shell>
  )
}

export const TimePicker: ControlType = {
  type: 'TimePicker',
  label: 'Time picker',
  icon: Clock,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Pick a time"' },
    { name: 'Use24Hour', label: '24-hour clock', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'MinuteStep', label: 'Minute step', kind: 'number', group: 'Content', default: '=5', simple: false },
    { name: 'Clearable', kind: 'boolean', group: 'Content', default: '=true', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Value', initial: '' },
    { name: 'Hour', initial: null },
    { name: 'Minute', initial: null },
  ],
  defaultSize: { width: 200, height: 40 },
  primaryProp: 'Default',
  render: TimePickerRender,
}
