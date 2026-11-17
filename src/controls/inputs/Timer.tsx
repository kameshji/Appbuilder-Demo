import { useCallback, useEffect, useRef, useState } from 'react'
import { Timer as TimerIcon } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { toBool, toNum } from '../util'
import { Shell } from './shared'

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const TICK_MS = 100

function TimerRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const duration = Math.max(1, toNum(props.Duration, 5000))
  const repeat = toBool(props.Repeat, false)
  const autoStart = toBool(props.AutoStart, false)
  const startProp = toBool(props.Start, false)
  const resetProp = toBool(props.Reset, false)
  const showText = toBool(props.ShowText, false)

  const [running, setRunning] = useState(false)
  const elapsed = useRef(0)
  const startedAt = useRef(0)
  const latest = useRef({ duration, repeat, fire, setOutput })
  useEffect(() => {
    latest.current = { duration, repeat, fire, setOutput }
  })

  const begin = useCallback((fromZero: boolean) => {
    if (fromZero) elapsed.current = 0
    startedAt.current = performance.now() - elapsed.current
    setRunning(true)
    latest.current.setOutput('Running', true)
    if (elapsed.current === 0) {
      latest.current.setOutput('Value', 0)
      latest.current.fire('OnTimerStart')
    }
  }, [])
  const halt = useCallback(() => {
    setRunning(false)
    latest.current.setOutput('Running', false)
  }, [])

  // Start / AutoStart / Reset handling (run mode only).
  const prevStart = useRef<boolean | null>(null)
  useEffect(() => {
    if (design) return
    const first = prevStart.current === null
    if (first) {
      prevStart.current = startProp
      if (startProp || autoStart) begin(true)
      return
    }
    if (startProp !== prevStart.current) {
      prevStart.current = startProp
      if (startProp) begin(elapsed.current >= latest.current.duration)
      else halt()
    }
  }, [design, startProp, autoStart, begin, halt])

  const prevReset = useRef(false)
  useEffect(() => {
    if (design) return
    if (resetProp && !prevReset.current) {
      elapsed.current = 0
      latest.current.setOutput('Value', 0)
      halt()
    }
    prevReset.current = resetProp
  }, [design, resetProp, halt])

  // Ticking.
  useEffect(() => {
    if (design || !running) return
    const id = setInterval(() => {
      const { duration: d, repeat: rep, fire: f, setOutput: so } = latest.current
      const e = performance.now() - startedAt.current
      if (e >= d) {
        f('OnTimerEnd')
        if (rep) {
          startedAt.current = performance.now()
          elapsed.current = 0
          so('Value', 0)
        } else {
          elapsed.current = d
          so('Value', d)
          setRunning(false)
          so('Running', false)
        }
        return
      }
      elapsed.current = e
      so('Value', Math.round(e))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [design, running])

  const value = outputs.Value == null ? 0 : toNum(outputs.Value, 0)

  if (design) {
    return (
      <Shell design className="flex items-center">
        <div className="flex h-full min-w-0 items-center gap-1.5 rounded-md border border-dashed border-border bg-muted/60 px-2 text-xs text-muted-foreground">
          <TimerIcon className="size-3.5 shrink-0" />
          <span className="truncate">Timer {(duration / 1000).toFixed(duration % 1000 === 0 ? 0 : 1)}s</span>
        </div>
      </Shell>
    )
  }
  if (!showText) return <Shell design={false} />
  return (
    <Shell design={false} className="flex items-center justify-center text-lg font-semibold tabular-nums">
      {clock(duration - value)}
    </Shell>
  )
}

export const Timer: ControlType = {
  type: 'Timer',
  label: 'Timer',
  icon: TimerIcon,
  category: 'Input',
  props: [
    { name: 'Duration', label: 'Duration (ms)', kind: 'number', group: 'Content', default: '=5000' },
    { name: 'Repeat', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'AutoStart', label: 'Auto start', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Start', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'Reset', kind: 'boolean', group: 'Behaviour', default: '=false', simple: false },
    { name: 'ShowText', label: 'Show remaining time', kind: 'boolean', group: 'Style', default: '=false' },
    { name: 'OnTimerStart', kind: 'action', group: 'Behaviour', default: '=false', simple: false },
    { name: 'OnTimerEnd', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [
    { name: 'Value', initial: 0 },
    { name: 'Running', initial: false },
  ],
  defaultSize: { width: 120, height: 32 },
  primaryProp: 'OnTimerEnd',
  render: TimerRender,
}
