import { useEffect, useRef, useState } from 'react'
import { Palette } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { Shell, triggerClass, useFocusToken } from './shared'

const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#4f46e5', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#78716c', '#52525b', '#18181b', '#71717a', '#a1a1aa', '#e4e4e7', '#ffffff',
]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** #rgb -> #rrggbb for the native colour input; anything else -> black. */
function nativeHex(v: string): string {
  const m = /^#([0-9a-f]{3})$/i.exec(v)
  if (m) return '#' + m[1].split('').map((c) => c + c).join('')
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7)
  return '#000000'
}

function ColorPickerRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState(value)
  useEffect(() => setHex(value), [value])
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const editable = !design && dm === 'Edit'
  const pick = (c: string) => {
    if (!editable) return
    setOutput('Value', c)
    fire('OnChange')
  }
  return (
    <Shell design={design} rootRef={root}>
      <Popover open={open && editable} onOpenChange={(o) => editable && setOpen(o)}>
        <PopoverTrigger asChild>
          <button type="button" disabled={dm === 'Disabled'} className={cn(triggerClass, 'justify-start')} style={{ fontSize: toNum(props.Size, 14) }}>
            <span
              className="size-5 shrink-0 rounded border border-border"
              style={{ background: value === '' ? 'repeating-conic-gradient(var(--muted) 0 25%, transparent 0 50%) 50% / 8px 8px' : value }}
            />
            {toBool(props.ShowHex, true) && (
              <span className={cn('min-w-0 flex-1 truncate text-left font-mono', value === '' && 'text-muted-foreground')}>{value === '' ? 'No colour' : value}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64">
          <div className="grid grid-cols-8 gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                className={cn(
                  'size-6 rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  value.toLowerCase() === c && 'ring-2 ring-ring ring-offset-1 ring-offset-popover',
                )}
                style={{ background: c }}
                onClick={() => pick(c)}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="color"
              aria-label="Custom colour"
              value={nativeHex(value)}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
              onChange={(e) => pick(e.target.value)}
            />
            <Input
              value={hex}
              placeholder="#4f46e5"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              onChange={(e) => {
                setHex(e.target.value)
                if (HEX.test(e.target.value.trim())) pick(e.target.value.trim())
              }}
              onBlur={() => setHex(value)}
            />
          </div>
        </PopoverContent>
      </Popover>
    </Shell>
  )
}

export const ColorPicker: ControlType = {
  type: 'ColorPicker',
  label: 'Color picker',
  icon: Palette,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'color', group: 'Content', default: '="#4f46e5"' },
    { name: 'ShowHex', label: 'Show hex code', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14', simple: false },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }],
  defaultSize: { width: 180, height: 40 },
  primaryProp: 'Default',
  render: ColorPickerRender,
}
