import { useState } from 'react'
import { ArrowLeftRight, Monitor, Ruler, Smartphone, Tablet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { DEFAULT_DESKTOP, DEFAULT_PHONE, DEFAULT_TABLET, SIZE_PRESETS, isPortrait, presetById, presetOf, type SizeGroup } from '@/runtime/sizes'
import { Segmented } from './kit'

type Choice = SizeGroup | 'Custom'
const DEFAULT_OF: Record<SizeGroup, string> = { Desktop: DEFAULT_DESKTOP, Phone: DEFAULT_PHONE, Tablet: DEFAULT_TABLET }

/** a small outline of the screen shape (landscape or portrait) */
function Shape({ w, h, active }: { w: number; h: number; active: boolean }) {
  const k = 18 / Math.max(w, h)
  return (
    <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
      <span className={cn('rounded-[2px] border', active ? 'border-primary bg-primary/15' : 'border-muted-foreground/50')} style={{ width: Math.max(6, w * k), height: Math.max(6, h * k) }} />
    </span>
  )
}

/**
 * Design size picker: Desktop / Phone / Tablet presets or a custom size (landscape or portrait).
 * Controlled; `onChange` may report a non-finite size while the custom fields are being typed (check with sizeError).
 */
export function SizePicker({ value, onChange, testId = 'size-picker' }: { value: { w: number; h: number }; onChange(v: { w: number; h: number }): void; testId?: string }) {
  const [choice, setChoice] = useState<Choice>(() => presetOf(value.w, value.h)?.group ?? 'Custom')
  const [cw, setCw] = useState(String(value.w))
  const [ch, setCh] = useState(String(value.h))
  const current = presetOf(value.w, value.h)

  const pick = (c: Choice) => {
    setChoice(c)
    if (c === 'Custom') {
      setCw(String(value.w))
      setCh(String(value.h))
      return
    }
    if (current?.group === c) return
    const p = presetById(DEFAULT_OF[c])!
    onChange({ w: p.w, h: p.h })
  }
  const custom = (w: string, h: string) => {
    setCw(w)
    setCh(h)
    onChange({ w: Math.round(Number(w)), h: Math.round(Number(h)) })
  }

  return (
    <div className="grid gap-2" data-testid={testId}>
      <Segmented
        label="Device"
        value={choice}
        onChange={pick}
        options={[
          { value: 'Desktop', label: <><Monitor className="size-3.5" /> Desktop</> },
          { value: 'Phone', label: <><Smartphone className="size-3.5" /> Phone</> },
          { value: 'Tablet', label: <><Tablet className="size-3.5" /> Tablet</> },
          { value: 'Custom', label: <><Ruler className="size-3.5" /> Custom</> },
        ]}
      />
      {choice !== 'Custom' ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${choice} sizes`}>
          {SIZE_PRESETS.filter((p) => p.group === choice).map((p) => {
            const on = current?.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`size-${p.id}`}
                onClick={() => onChange({ w: p.w, h: p.h })}
                className={cn(
                  'flex h-9 items-center gap-2 rounded-md border px-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                  on ? 'border-primary bg-primary/8 text-foreground' : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                <Shape w={p.w} h={p.h} active={on} />
                <span>
                  <span className="block font-medium leading-tight">{p.label}</span>
                  <span className="block tabular-nums leading-tight text-muted-foreground">{p.w} × {p.h}</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Width" type="number" className="h-8 w-24" value={cw} onChange={(e) => custom(e.target.value, ch)} data-testid="size-custom-w" />
          <span className="text-muted-foreground">×</span>
          <Input aria-label="Height" type="number" className="h-8 w-24" value={ch} onChange={(e) => custom(cw, e.target.value)} data-testid="size-custom-h" />
          <span className="text-xs text-muted-foreground">px</span>
          <button
            type="button"
            title="Swap width and height"
            aria-label="Swap width and height"
            onClick={() => custom(ch, cw)}
            className="grid size-8 place-items-center rounded-md border border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ArrowLeftRight className="size-3.5" />
          </button>
          {Number.isFinite(value.w) && Number.isFinite(value.h) && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Shape w={value.w} h={value.h} active /> {isPortrait(value.w, value.h) ? 'Portrait' : 'Landscape'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
