import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalendarDays, Film, Play, Volume2 } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { Calendar as DayCalendar } from '@/components/ui/calendar'
import { cn } from '@/lib/utils'
import { toBool, toRecords, toText } from '../util'
import { lc, pick, toDate } from './helpers'

/* ------------------------------------------------------------------ Video */

function fitCss(v: string): 'cover' | 'contain' | 'fill' {
  const s = lc(v)
  return s === 'cover' ? 'cover' : s === 'fill' ? 'fill' : 'contain'
}

function VideoRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const src = toText(props.Source).trim()
  const poster = toText(props.Poster).trim() || undefined
  if (mode === 'design' || src === '') {
    return (
      <div className="relative flex size-full items-center justify-center overflow-hidden rounded-lg bg-black text-white/70">
        {poster && <img src={poster} alt="" draggable={false} className="absolute inset-0 size-full object-cover opacity-70" />}
        <span className="relative flex size-14 items-center justify-center rounded-full bg-white/15 backdrop-blur">
          {src === '' ? <Film className="size-6" strokeWidth={1.5} /> : <Play className="size-6 fill-current" />}
        </span>
      </div>
    )
  }
  return (
    <video
      key={src}
      src={src}
      poster={poster}
      controls={toBool(props.Controls, true)}
      autoPlay={toBool(props.AutoPlay, false)}
      loop={toBool(props.Loop, false)}
      muted={toBool(props.Muted, false) || toBool(props.AutoPlay, false)}
      playsInline
      className="size-full rounded-lg bg-black"
      style={{ objectFit: fitCss(toText(props.Fit)) }}
      onPlay={() => setOutput('Playing', true)}
      onPause={() => setOutput('Playing', false)}
      onEnded={() => { setOutput('Playing', false); fire('OnEnd') }}
    />
  )
}

export const Video: ControlType = {
  type: 'Video',
  label: 'Video',
  icon: Film,
  category: 'Media',
  props: [
    { name: 'Source', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Poster', kind: 'text', group: 'Content', default: '=""', simple: false },
    { name: 'Controls', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'AutoPlay', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Loop', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Muted', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Fit', kind: 'enum', group: 'Style', default: '="Contain"', options: ['"Contain"', '"Cover"', '"Fill"'], simple: false },
    { name: 'OnEnd', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Playing', initial: false }],
  defaultSize: { width: 480, height: 270 },
  primaryProp: 'Source',
  render: VideoRender,
}

/* ------------------------------------------------------------------ Audio */

function AudioRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const src = toText(props.Source).trim()
  if (mode === 'design' || src === '') {
    return (
      <div className="flex size-full items-center gap-3 overflow-hidden rounded-full border bg-card px-4 text-sm text-muted-foreground">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Play className="size-3.5 fill-current" />
        </span>
        <span className="h-1 flex-1 rounded-full bg-muted" />
        <Volume2 className="size-4 shrink-0" />
      </div>
    )
  }
  return (
    <audio
      key={src}
      src={src}
      controls={toBool(props.Controls, true)}
      autoPlay={toBool(props.AutoPlay, false)}
      loop={toBool(props.Loop, false)}
      className="size-full"
      onPlay={() => setOutput('Playing', true)}
      onPause={() => setOutput('Playing', false)}
      onEnded={() => { setOutput('Playing', false); fire('OnEnd') }}
    />
  )
}

export const Audio: ControlType = {
  type: 'Audio',
  label: 'Audio',
  icon: Volume2,
  category: 'Media',
  props: [
    { name: 'Source', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Controls', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'AutoPlay', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Loop', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'OnEnd', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Playing', initial: false }],
  defaultSize: { width: 360, height: 48 },
  primaryProp: 'Source',
  render: AudioRender,
}

/* ------------------------------------------------------------------ Calendar */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Scales a fixed-size child to fit its wrapper (capped), so the calendar fills the control. */
function FitScale({ children }: { children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const o = outer.current
    const i = inner.current
    if (!o || !i) return
    const measure = () => {
      const nw = i.offsetWidth
      const nh = i.offsetHeight
      if (!nw || !nh || !o.clientWidth || !o.clientHeight) return
      setScale(Math.min(2.5, Math.max(0.4, Math.min(o.clientWidth / nw, o.clientHeight / nh))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(o)
    ro.observe(i)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={outer} className="flex size-full items-center justify-center overflow-hidden">
      <div ref={inner} style={{ transform: `scale(${scale})`, transformOrigin: 'center', flex: 'none' }}>
        {children}
      </div>
    </div>
  )
}

function CalendarRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const def = toDate(props.Default)
  const defKey = def ? dayKey(def) : ''
  const events: FxRecord[] = toRecords(props.Events)
  const selected = toDate(outputs.SelectedDate)

  const eventsOn = (d: Date | null): FxRecord[] =>
    d ? events.filter((e) => { const ed = toDate(pick(e, 'Date', 'Start', 'When')); return ed && dayKey(ed) === dayKey(d) }) : []

  const write = (d: Date | null) => {
    setOutput('SelectedDate', d)
    setOutput('SelectedEvents', eventsOn(d))
  }

  const prevDef = useRef<string | null>(null)
  const blank = outputs.SelectedDate == null
  useEffect(() => {
    if (prevDef.current !== defKey || (blank && def)) write(def)
    prevDef.current = defKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defKey, blank])

  const eventDates = events.map((e) => toDate(pick(e, 'Date', 'Start', 'When'))).filter((d): d is Date => !!d)

  return (
    <div className={cn('size-full', !run && 'pointer-events-none')}>
      <FitScale>
        <div className="rounded-lg border bg-card text-card-foreground">
          <DayCalendar
            mode="single"
            required
            selected={selected ?? undefined}
            defaultMonth={selected ?? def ?? undefined}
            onSelect={(d) => {
              write(d)
              fire('OnSelect')
            }}
            modifiers={{ hasEvent: eventDates }}
            modifiersClassNames={{
              hasEvent: '[&>button]:font-semibold [&>button]:underline [&>button]:decoration-primary [&>button]:decoration-2 [&>button]:underline-offset-4',
            }}
          />
        </div>
      </FitScale>
    </div>
  )
}

export const CalendarControl: ControlType = {
  type: 'Calendar',
  label: 'Calendar',
  icon: CalendarDays,
  category: 'Data',
  props: [
    { name: 'Default', kind: 'any', group: 'Data', default: '=Today()' },
    { name: 'Events', kind: 'table', group: 'Data', default: '=[]' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'SelectedDate', initial: null },
    { name: 'SelectedEvents', initial: [] },
  ],
  defaultSize: { width: 320, height: 340 },
  primaryProp: 'Default',
  render: CalendarRender,
}
