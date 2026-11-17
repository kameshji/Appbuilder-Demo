import { useEffect, useRef, useState } from 'react'
import { Copy, Trash2, SlidersHorizontal } from 'lucide-react'
import type { ControlNode, FxValue, PropMeta } from '@/contracts'
import { controls } from '@/controls'
import { fx } from '@/fx'
import { getEvaluator, type Evaluator } from '@/runtime/evaluator'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { normFormula, parseBoolLiteral, parseNumberLiteral, parseTextLiteral, quote, round2 } from '@/runtime/util'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const GROUPS = ['Content', 'Data', 'Layout', 'Style', 'Behaviour'] as const

export function PropertiesPanel() {
  const selection = useStore((s) => s.selection)
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const mode = useStore((s) => s.mode)
  const ev = getEvaluator(app, rt)
  const node = selection.length === 1 ? ev.byId.get(selection[0])?.node : undefined

  return (
    <aside data-testid="properties-panel" className="flex w-[300px] shrink-0 flex-col border-l border-border bg-card">
      {mode !== 'design' ? null : node ? (
        <NodePanel key={node.id} node={node} ev={ev} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
          <SlidersHorizontal className="size-6 opacity-50" />
          <p className="text-xs">{selection.length > 1 ? `${selection.length} controls selected` : 'Nothing selected'}</p>
          {selection.length > 1 && (
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => useStore.getState().duplicate(selection)}>
                <Copy /> Duplicate
              </Button>
              <Button size="xs" variant="outline" onClick={() => useStore.getState().remove(selection)}>
                <Trash2 /> Delete
              </Button>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function NodePanel({ node, ev }: { node: ControlNode; ev: Evaluator }) {
  const def = controls.get(node.type)
  const Icon = def.icon
  const metas = controls.propsOf(node.type)
  const ctx = ev.designCtx(node)
  const nodeEval = ev.evalNode(node, ctx)
  const [tab, setTab] = useState('simple')
  const [search, setSearch] = useState('')
  const isScreen = node.type === 'Screen'

  return (
    <>
      <div className="border-b border-border px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <NameField node={node} />
            <div className="mt-0.5 text-[11px] text-muted-foreground">{def.label}</div>
          </div>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-3 mt-2 grid h-8 grid-cols-2">
          <TabsTrigger value="simple" className="text-xs">Simple</TabsTrigger>
          <TabsTrigger value="advanced" className="text-xs">Advanced</TabsTrigger>
        </TabsList>
        <TabsContent value="simple" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="space-y-4 px-3 py-3">
              {GROUPS.map((g) => {
                const list = metas.filter((m) => m.group === g && m.simple !== false)
                if (!list.length) return null
                const layoutNums = g === 'Layout' ? list.filter((m) => m.kind === 'number') : []
                const rest = list.filter((m) => !layoutNums.includes(m))
                return (
                  <section key={g}>
                    <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{g}</h4>
                    {layoutNums.length > 0 && (
                      <div className="mb-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
                        {layoutNums.map((m) => (
                          <SimpleRow key={m.name} node={node} meta={m} ev={ev} nodeEval={nodeEval.props} compact />
                        ))}
                      </div>
                    )}
                    <div className="space-y-2">
                      {rest.map((m) => (
                        <SimpleRow key={m.name} node={node} meta={m} ev={ev} nodeEval={nodeEval.props} />
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="advanced" className="flex min-h-0 flex-1 flex-col">
          <div className="px-3 pb-1 pt-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search properties" className="h-7 text-xs" />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2.5 px-3 py-2">
              {metas
                .filter((m) => m.name.toLowerCase().includes(search.toLowerCase()))
                .map((m) => (
                  <AdvancedRow
                    key={m.name}
                    label={m.name}
                    stored={node.props[m.name] ?? m.default}
                    error={nodeEval.errors[m.name]}
                    onCommit={(f) => useStore.getState().setProp(node.id, m.name, f, `adv:${node.id}:${m.name}`)}
                  />
                ))}
              {isScreen && 'OnStart'.toLowerCase().includes(search.toLowerCase()) && <AppPropRow />}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </>
  )
}

function AppPropRow() {
  const f = useStore((s) => s.app.appProps.OnStart ?? '=')
  return <AdvancedRow label="App.OnStart" stored={f} onCommit={(v) => useStore.getState().setAppProp('OnStart', v)} />
}

/* ------------------------------------------------------------------ name */

function NameField({ node }: { node: ControlNode }) {
  const [v, setV] = useState(node.name)
  const [err, setErr] = useState<string | null>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setV(node.name)
  }, [node.name])
  const commit = (): string | null => {
    if (v.trim() === node.name) {
      setErr(null)
      return null
    }
    const e = useStore.getState().rename(node.id, v)
    setErr(e)
    if (!e) setV(v.trim())
    return e
  }
  return (
    <>
      <input
        value={v}
        data-testid="name-input"
        spellCheck={false}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setV(e.target.value)
          setErr(null)
        }}
        onBlur={() => {
          focused.current = false
          if (commit()) setV(node.name)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setV(node.name)
            setErr(null)
            e.currentTarget.blur()
          }
        }}
        className={cn(
          'w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none hover:border-border focus:border-primary focus:bg-background',
          err && 'border-destructive',
        )}
      />
      {err && <div className="px-1 text-[11px] text-destructive">{err}</div>}
    </>
  )
}

/* ------------------------------------------------------------------ simple rows */

function FxPill({ node, meta, formula }: { node: ControlNode; meta: PropMeta; formula: string }) {
  return (
    <button
      type="button"
      title="Edit in formula bar"
      onClick={() => useUi.getState().focusFormula(node.type, meta.name)}
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-1.5 text-left hover:bg-primary/10"
    >
      <span className="shrink-0 rounded bg-primary px-1 font-serif text-[10px] italic leading-4 text-primary-foreground">fx</span>
      <span className="truncate font-mono text-[11px] text-foreground/80">{formula.replace(/^=/, '')}</span>
    </button>
  )
}

const PALETTE = [
  [24, 24, 27], [63, 63, 70], [113, 113, 122], [161, 161, 170], [228, 228, 231], [255, 255, 255],
  [79, 70, 229], [99, 102, 241], [37, 99, 235], [14, 165, 233], [20, 184, 166], [22, 163, 74],
  [234, 179, 8], [249, 115, 22], [239, 68, 68], [236, 72, 153], [168, 85, 247], [120, 53, 15],
]

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

function parseHex(s: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const isColorLiteral = (f: string) => /^=\s*(RGBA\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)|Color\.\w+)\s*$/i.test(f) || parseTextLiteral(f) !== null

function ColorEditor({ node, meta, formula, value }: { node: ControlNode; meta: PropMeta; formula: string; value: FxValue | undefined }) {
  const css = typeof value === 'string' && value ? value : 'transparent'
  const [hex, setHex] = useState('')
  const set = (f: string) => useStore.getState().setProp(node.id, meta.name, f)
  const label = formula.replace(/^=\s*/, '')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 w-full items-center gap-2 rounded-md border border-input bg-background px-1.5 text-left hover:bg-accent/50">
          <span
            className="size-4 shrink-0 rounded border border-border"
            style={{
              background: css,
              backgroundImage: css === 'transparent' || css.endsWith(', 0)') ? 'conic-gradient(#d4d4d8 25%, transparent 0 50%, #d4d4d8 0 75%, transparent 0)' : undefined,
              backgroundSize: '6px 6px',
            }}
          />
          <span className="truncate font-mono text-[11px] text-foreground/80">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[212px] p-2.5">
        <div className="grid grid-cols-6 gap-1.5">
          {PALETTE.map(([r, g, b]) => (
            <button
              key={`${r}${g}${b}`}
              type="button"
              title={rgbHex(r, g, b)}
              onClick={() => set(`=RGBA(${r}, ${g}, ${b}, 1)`)}
              className="size-6 rounded-md border border-border transition-transform hover:scale-110"
              style={{ background: `rgb(${r} ${g} ${b})` }}
            />
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <Input
            value={hex}
            placeholder="#4f46e5"
            spellCheck={false}
            onChange={(e) => {
              setHex(e.target.value)
              const c = parseHex(e.target.value)
              if (c) set(`=RGBA(${c[0]}, ${c[1]}, ${c[2]}, 1)`)
            }}
            className="h-7 font-mono text-xs"
          />
          <Button size="xs" variant="outline" onClick={() => set('=Color.Transparent')}>
            None
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function NumberEditor({ node, meta, formula, compact }: { node: ControlNode; meta: PropMeta; formula: string; compact?: boolean }) {
  const n = parseNumberLiteral(formula)
  const [text, setText] = useState(String(n ?? ''))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(n ?? ''))
  }, [n])
  const write = (v: number) => useStore.getState().setProp(node.id, meta.name, `=${round2(v)}`)
  const scrub = useRef<{ x: number; v: number } | null>(null)
  const input = (
    <Input
      type="text"
      inputMode="decimal"
      value={text}
      data-testid={`prop-${meta.name}`}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        setText(String(n ?? text))
      }}
      onChange={(e) => {
        setText(e.target.value)
        const v = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(v)) write(v)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const cur = Number(text) || 0
          const nv = cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
          setText(String(nv))
          write(nv)
        } else if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="h-7 text-xs tabular-nums"
    />
  )
  if (!compact) return input
  return (
    <label className="flex items-center gap-1.5">
      <span
        className="w-4 shrink-0 cursor-ew-resize select-none text-center text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
        title={`Drag to change ${meta.name}`}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub.current = { x: e.clientX, v: n ?? 0 }
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return
          const v = Math.round(scrub.current.v + (e.clientX - scrub.current.x) / 2)
          setText(String(v))
          write(v)
        }}
        onPointerUp={() => (scrub.current = null)}
      >
        {meta.name === 'Width' ? 'W' : meta.name === 'Height' ? 'H' : meta.name}
      </span>
      {input}
    </label>
  )
}

function SimpleRow({ node, meta, ev, nodeEval, compact }: { node: ControlNode; meta: PropMeta; ev: Evaluator; nodeEval: Record<string, FxValue>; compact?: boolean }) {
  void ev
  const formula = node.props[meta.name] ?? meta.default
  const set = (f: string) => useStore.getState().setProp(node.id, meta.name, f)
  let editor: React.ReactNode = null
  let inline = false

  switch (meta.kind) {
    case 'text': {
      const lit = parseTextLiteral(formula)
      editor = lit !== null ? <TextEditor value={lit} onChange={(v) => set(quote(v))} testId={`prop-${meta.name}`} /> : <FxPill node={node} meta={meta} formula={formula} />
      break
    }
    case 'number': {
      editor = parseNumberLiteral(formula) !== null ? <NumberEditor node={node} meta={meta} formula={formula} compact={compact} /> : <FxPill node={node} meta={meta} formula={formula} />
      break
    }
    case 'boolean': {
      const b = parseBoolLiteral(formula)
      if (b !== null) {
        inline = true
        editor = <Switch checked={b} onCheckedChange={(v) => set(`=${v}`)} />
      } else editor = <FxPill node={node} meta={meta} formula={formula} />
      break
    }
    case 'color':
      editor = isColorLiteral(formula) ? <ColorEditor node={node} meta={meta} formula={formula} value={nodeEval[meta.name]} /> : <FxPill node={node} meta={meta} formula={formula} />
      break
    case 'enum': {
      const cur = meta.options?.find((o) => normFormula(o) === normFormula(formula.replace(/^=/, '')))
      editor = cur ? (
        <Select value={cur} onValueChange={(v) => set(`=${v}`)}>
          <SelectTrigger size="sm" className="h-7 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {meta.options!.map((o) => (
              <SelectItem key={o} value={o}>
                {o.split('.').pop()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <FxPill node={node} meta={meta} formula={formula} />
      )
      break
    }
    default:
      editor = (
        <div className="space-y-1">
          <div className="line-clamp-2 break-all rounded-md border border-border bg-muted/50 px-1.5 py-1 font-mono text-[11px] text-foreground/80">{formula.replace(/^=/, '') || '(blank)'}</div>
          <button type="button" className="text-[11px] font-medium text-primary hover:underline" onClick={() => useUi.getState().focusFormula(node.type, meta.name)}>
            Edit in formula bar
          </button>
        </div>
      )
  }

  if (compact && meta.kind === 'number') return <div>{editor}</div>
  const label = meta.label ?? meta.name
  if (inline) {
    return (
      <div className="flex h-6 items-center justify-between">
        <span className="text-xs text-foreground/80">{label}</span>
        {editor}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-foreground/80">{label}</div>
      {editor}
    </div>
  )
}

function TextEditor({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const [v, setV] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setV(value)
  }, [value])
  return (
    <Input
      value={v}
      data-testid={testId}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        setV(e.target.value)
        onChange(e.target.value)
      }}
      className="h-7 text-xs"
    />
  )
}

/* ------------------------------------------------------------------ advanced rows */

function AdvancedRow({ label, stored, error, onCommit }: { label: string; stored: string; error?: string; onCommit: (f: string) => void }) {
  const body = (f: string) => (f.startsWith('=') ? f.slice(1) : f)
  const [v, setV] = useState(body(stored))
  const [syntax, setSyntax] = useState<string | null>(null)
  const focused = useRef(false)
  const sent = useRef(stored)
  useEffect(() => {
    if (stored !== sent.current || !focused.current) {
      sent.current = stored
      if (!focused.current || stored !== '=' + v) setV(body(stored))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored])
  const msg = syntax ?? error
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-foreground/80">{label}</span>
      </div>
      <div className={cn('flex h-7 items-center rounded-md border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20', msg ? 'border-destructive' : 'border-input')}>
        <span className="select-none pl-1.5 font-mono text-[11px] text-muted-foreground">=</span>
        <input
          value={v}
          spellCheck={false}
          data-testid={`adv-${label}`}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false
            if (syntax) {
              setV(body(stored))
              setSyntax(null)
            }
          }}
          onChange={(e) => {
            const text = e.target.value
            setV(text)
            const d = fx.check('=' + text)
            if (d.length === 0) {
              setSyntax(null)
              sent.current = '=' + text
              onCommit('=' + text)
            } else setSyntax(d[0].message)
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="h-full min-w-0 flex-1 bg-transparent px-1 font-mono text-[11px] outline-none"
        />
      </div>
      {msg && <div className="mt-0.5 text-[11px] leading-tight text-destructive">{msg}</div>}
    </div>
  )
}
