/**
 * A field of a step: a plain value (text with dynamic content, number, yes/no, date, choice, a row of a lookup) or a
 * formula, switchable. The formula editor follows the Studio's formula bar: suggestions while typing (functions,
 * Trigger / Steps / Variables members), the signature of the function at the caret, a syntax check as you type and the
 * server's check (POST /flows/validate) under the field with the same wording as the Studio; a table read shows where
 * it runs ("Runs on server" / "Can't run"). "Dynamic content" lists what the step can read, typed, and inserts it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Sparkles, TriangleAlert } from 'lucide-react'
import { fx } from '@/fx'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { platform } from '@/platform'
import { lookupSearchPlan } from '@/portal/cells'
import { stripLeadingEquals } from '@/studio/FormulaBar'
import { useDesigner } from './store'
import { useDesignerData, useTokens } from './context'
import { insertToken, type DynToken } from './dynamic'
import { literalFx, literalOf, type LiteralKind } from './literal'

export interface FxFieldProps {
  stepId: string
  /** the validator's field name (problems are matched on it) */
  field: string
  label?: string
  value: string | undefined
  onChange(v: string): void
  kind?: LiteralKind
  choices?: string[]
  lookupTable?: string
  placeholder?: string
  required?: boolean
  hint?: string
  multiline?: boolean
  /** start as a formula (conditions, lists ...) */
  formulaOnly?: boolean
  testId?: string
  readOnly?: boolean
}

const TYPE_TONE: Record<string, string> = {
  text: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', number: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', boolean: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  date: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', record: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300', table: 'bg-rose-500/15 text-rose-700 dark:text-rose-300', any: 'bg-muted text-muted-foreground',
}

/** problems of a step field (also nested ones: values.Amount for "values") */
export function useFieldProblems(stepId: string, field: string, exact = false) {
  const problems = useDesigner((s) => s.problems)
  return useMemo(() => problems.filter((p) => p.step === stepId && (p.field === field || (!exact && !!field && (p.field.startsWith(`${field}.`) || p.field.startsWith(`${field}[`))))), [problems, stepId, field, exact])
}

/** the problems of a field under it; exact: not those of nested fields (shown by their own fields) */
export function FieldError({ stepId, field, extra, exact }: { stepId: string; field: string; extra?: string | null; exact?: boolean }) {
  const probs = useFieldProblems(stepId, field, exact)
  if (!probs.length && !extra) return null
  return (
    <div className="grid gap-0.5" data-testid="field-problems">
      {extra && <p className="text-[11px] text-destructive" data-testid="formula-error">{extra}</p>}
      {probs.map((p, i) => <p key={i} className={cn('text-[11px]', p.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')} data-testid={p.severity === 'error' ? 'formula-error' : 'formula-warning'}>{p.message}</p>)}
    </div>
  )
}

/** the "dynamic content" list: grouped, searchable, typed */
export function DynamicContent({ stepId, onPick, trigger }: { stepId: string; onPick(t: DynToken): void; trigger?: React.ReactNode }) {
  const tokens = useTokens(stepId)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? tokens.filter((t) => `${t.group} ${t.label} ${t.insert}`.toLowerCase().includes(s)) : tokens
    const by = new Map<string, DynToken[]>()
    for (const t of list) by.set(t.group, [...(by.get(t.group) ?? []), t])
    return [...by.entries()]
  }, [tokens, q])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button type="button" className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-primary hover:bg-primary/10" data-testid="dynamic-content" title="Insert dynamic content">
            <Sparkles className="size-3.5" />Dynamic content
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="border-b border-border p-2">
          <input autoFocus className="h-7 w-full rounded border border-border bg-background px-2 text-xs" placeholder="Search dynamic content" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dynamic content" data-testid="dynamic-search" />
        </div>
        <div className="max-h-80 overflow-auto p-1" data-testid="dynamic-list">
          {!shown.length && <p className="p-2 text-xs text-muted-foreground">Nothing matches. Steps can read the trigger, earlier steps, variables and the loop they are in.</p>}
          {shown.map(([g, items]) => (
            <div key={g} className="mb-1">
              <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</div>
              {items.map((t) => (
                <button key={t.insert} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent" data-testid="dynamic-item" data-insert={t.insert} title={t.insert}
                  onClick={() => { onPick(t); setOpen(false); setQ('') }}>
                  <span className={cn('shrink-0 rounded px-1 text-[9px] font-medium uppercase', TYPE_TONE[t.type])}>{t.type}</span>
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {t.doc && <span className="max-w-[120px] truncate text-[10px] text-muted-foreground">{t.doc}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** a row of a lookup table, searched on the server */
function RowPicker({ table, value, onChange, testId }: { table: string; value: string; onChange(v: string): void; testId?: string }) {
  const t = platform.tables.get(table)
  const [text, setText] = useState('')
  const [items, setItems] = useState<{ id: string; label: string }[]>([])
  const [label, setLabel] = useState<string>('')
  useEffect(() => {
    if (!t) return
    let alive = true
    const h = setTimeout(() => {
      platform.tables.query(lookupSearchPlan(t, text)).then((st) => {
        if (!alive) return
        const rows = st.rows.map((r) => ({ id: String(r.__id ?? r.id), label: r[t.primaryColumn] === null || r[t.primaryColumn] === undefined ? '(blank)' : String(r[t.primaryColumn]) }))
        setItems(rows)
        const cur = rows.find((r) => r.id === value)
        if (cur) setLabel(cur.label)
      }).catch(() => setItems([]))
    }, 200)
    return () => { alive = false; clearTimeout(h) }
  }, [text, t, value])
  if (!t) return <input className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Row id" />
  return (
    <div className="grid gap-1">
      <input className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" value={text} placeholder={value ? `${label || value} (search to change)` : `Search ${t.displayName}`} onChange={(e) => setText(e.target.value)} data-testid={testId ? `${testId}-search` : undefined} aria-label={`Search ${t.displayName}`} />
      {text && (
        <ul className="max-h-40 overflow-auto rounded-md border border-border bg-popover py-1 text-sm">
          {items.map((it) => <li key={it.id}><button type="button" className={cn('w-full truncate px-2 py-1 text-left hover:bg-accent', it.id === value && 'font-medium')} onClick={() => { onChange(it.id); setLabel(it.label); setText('') }}>{it.label}</button></li>)}
          {!items.length && <li className="px-2 py-1 text-xs text-muted-foreground">No rows match.</li>}
        </ul>
      )}
    </div>
  )
}

interface Suggestion { label: string; insert: string; kind: string; detail?: string }

/** suggestions at the caret: members of Trigger/Steps/Variables/the loop item from the tokens, functions, roots */
function suggest(text: string, caret: number, tokens: DynToken[], tables: string[], force: boolean): { items: Suggestion[]; start: number } | null {
  const before = text.slice(0, caret)
  let quotes = 0
  for (const ch of before) if (ch === '"') quotes++
  if (quotes % 2) return null
  const m = /([A-Za-z_][A-Za-z0-9_.()']*)\.([A-Za-z0-9_]*)$/.exec(before)
  if (m) {
    const owner = m[1]
    const partial = m[2].toLowerCase()
    const seen = new Set<string>()
    const items: Suggestion[] = []
    for (const t of tokens) {
      if (!t.insert.startsWith(`${owner}.`)) continue
      const rest = t.insert.slice(owner.length + 1)
      const next = rest.split('.')[0]
      if (!next || seen.has(next) || !next.toLowerCase().startsWith(partial)) continue
      seen.add(next)
      items.push({ label: next, insert: next, kind: rest.includes('.') ? 'member' : t.type, detail: rest.includes('.') ? undefined : t.label })
    }
    return items.length ? { items: items.slice(0, 12), start: caret - m[2].length } : null
  }
  const w = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before)
  const partial = w ? w[1] : ''
  if (!partial && !force) return null
  const p = partial.toLowerCase()
  const all: Suggestion[] = []
  for (const r of ['Trigger', 'Steps', 'Variables', 'Flow', 'ThisItem']) all.push({ label: r, insert: r, kind: 'scope' })
  for (const t of tokens) if (!t.insert.includes('.') && !t.insert.includes('(')) all.push({ label: t.insert, insert: t.insert, kind: 'item' })
  for (const t of tables) all.push({ label: t, insert: t, kind: 'table' })
  for (const f of fx.functions()) if (f.kind !== 'behaviour') all.push({ label: f.name, insert: `${f.name}(`, kind: 'fn', detail: f.signature })
  const starts = all.filter((s) => s.label.toLowerCase().startsWith(p))
  const inc = all.filter((s) => !s.label.toLowerCase().startsWith(p) && s.label.toLowerCase().includes(p))
  const seen = new Set<string>()
  const items = [...starts, ...inc].filter((s) => (seen.has(s.kind + s.label) ? false : (seen.add(s.kind + s.label), true))).filter((s) => s.label !== partial).slice(0, 10)
  return items.length ? { items, start: caret - partial.length } : null
}

/** the formula editor (single line that grows while focused) */
export function FormulaInput({ stepId, value, onChange, placeholder, testId, readOnly, onSyntax }: { stepId: string; value: string; onChange(v: string): void; placeholder?: string; testId?: string; readOnly?: boolean; onSyntax?(msg: string | null): void }) {
  const tokens = useTokens(stepId)
  const data = useDesignerData()
  const tables = useMemo(() => data.tables.map((t) => t.name), [data.tables])
  const [text, setText] = useState(stripLeadingEquals(value ?? ''))
  const [focused, setFocused] = useState(false)
  const [sugg, setSugg] = useState<{ items: Suggestion[]; start: number; index: number } | null>(null)
  const [tip, setTip] = useState<{ signature: string; summary: string } | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const sent = useRef(value)
  useEffect(() => {
    if (value !== sent.current) { sent.current = value; setText(stripLeadingEquals(value ?? '')) }
  }, [value])
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 30), focused ? 160 : 30)}px`
  }, [text, focused])
  const commit = (t: string) => {
    setText(t)
    sent.current = t
    onChange(t)
    const d = t.trim() ? fx.check(`=${t}`) : []
    onSyntax?.(d.length ? d[0].message : null)
  }
  const refresh = (t: string, caret: number, force = false) => {
    const r = suggest(t, caret, tokens, tables, force)
    setSugg(r ? { ...r, index: 0 } : null)
    try {
      const s = fx.signatureAt(`=${t}`, caret + 1)
      setTip(s ? { signature: s.signature, summary: s.summary } : null)
    } catch { setTip(null) }
  }
  const accept = (s: Suggestion) => {
    if (!sugg) return
    const el = ta.current!
    const caret = el.selectionStart
    const t = text.slice(0, sugg.start) + s.insert + text.slice(caret)
    const pos = sugg.start + s.insert.length
    commit(t)
    setSugg(null)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos) })
  }
  const insert = (tok: string) => {
    const el = ta.current
    const caret = el && focused ? el.selectionStart : text.length
    const r = insertToken(text, caret, tok)
    commit(r.text)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(r.caret, r.caret) })
  }
  return (
    <div className="relative">
      <div className={cn('flex items-start rounded-md border bg-background', focused ? 'border-primary ring-2 ring-primary/20' : 'border-input')}>
        <span className="select-none pl-2 pr-1 font-serif text-[12px] italic leading-[28px] text-primary">fx</span>
        <textarea
          ref={ta} rows={1} spellCheck={false} autoComplete="off" value={text} readOnly={readOnly} placeholder={placeholder ?? 'Type a formula'}
          data-testid={testId ?? 'fx-input'}
          className="block min-h-[30px] w-full min-w-0 resize-none bg-transparent py-[6px] pr-2 font-mono text-[12px] leading-[18px] outline-none placeholder:text-muted-foreground/60"
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setSugg(null); setTip(null) }}
          onChange={(e) => { const t = stripLeadingEquals(e.target.value); commit(t); refresh(t, Math.max(0, e.target.selectionStart - (e.target.value.length - t.length))) }}
          onKeyDown={(e) => {
            if (sugg) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = sugg.items.length; setSugg({ ...sugg, index: (sugg.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n }); return }
              if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); accept(sugg.items[sugg.index]); return }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSugg(null); return }
            }
            if (e.key === ' ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); refresh(text, e.currentTarget.selectionStart, true); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
            e.stopPropagation()
          }}
        />
        {!readOnly && <span className="pr-1 pt-[3px]"><DynamicContent stepId={stepId} onPick={(t) => insert(t.insert)} trigger={<button type="button" className="rounded p-1 text-primary hover:bg-primary/10" title="Insert dynamic content" data-testid="dynamic-content"><Sparkles className="size-3.5" /></button>} /></span>}
      </div>
      {tip && focused && !sugg && (
        <div className="absolute left-0 top-full z-50 mt-1 max-w-[420px] rounded-md border border-border bg-popover px-2 py-1 text-popover-foreground shadow-lg" data-testid="call-tip">
          <div className="font-mono text-[11px]">{tip.signature}</div>
          {tip.summary && <div className="text-[10px] text-muted-foreground">{tip.summary}</div>}
        </div>
      )}
      {sugg && focused && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg" onMouseDown={(e) => e.preventDefault()}>
          {sugg.items.map((s, i) => (
            <button key={s.kind + s.label} type="button" data-testid="autocomplete-item" className={cn('flex w-full items-baseline gap-2 rounded px-2 py-0.5 text-left', i === sugg.index && 'bg-accent')} onMouseEnter={() => setSugg({ ...sugg, index: i })} onClick={() => accept(s)}>
              <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">{s.kind}</span>
              <span className="font-mono text-[11px] font-medium">{s.label}</span>
              {s.detail && <span className="min-w-0 truncate text-[10px] text-muted-foreground">{s.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** a text with dynamic content ({token}); rich: a small HTML editor for email bodies */
function TextWithTokens({ stepId, value, onChange, multiline, placeholder, testId, readOnly }: { stepId: string; value: string; onChange(v: string): void; multiline?: boolean; placeholder?: string; testId?: string; readOnly?: boolean }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const caretRef = useRef<number | null>(null)
  const insert = (tok: string) => {
    const el = ref.current
    const c = caretRef.current ?? value.length
    const next = value.slice(0, c) + `{${tok}}` + value.slice(c)
    onChange(next)
    const pos = c + tok.length + 2
    caretRef.current = pos
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos) })
  }
  const common = {
    ref, value, readOnly, placeholder, 'data-testid': testId ?? 'text-input',
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => { caretRef.current = e.target.selectionStart; onChange(e.target.value) },
    onSelect: (e: React.SyntheticEvent<HTMLInputElement & HTMLTextAreaElement>) => { caretRef.current = e.currentTarget.selectionStart },
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    className: 'w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20',
  }
  return (
    <div className="relative">
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} className={cn(common.className, 'h-8 pr-8')} />}
      {!readOnly && <span className={cn('absolute right-1', multiline ? 'bottom-1' : 'top-1')}><DynamicContent stepId={stepId} onPick={(t) => insert(t.insert)} trigger={<button type="button" className="rounded p-1 text-primary hover:bg-primary/10" title="Insert dynamic content" data-testid="dynamic-content"><Sparkles className="size-3.5" /></button>} /></span>}
    </div>
  )
}

/** the delegation chip of a formula that reads tables (like the Studio's formula bar) */
function DelegationChip({ stepId, field, value }: { stepId: string; field: string; value: string }) {
  const data = useDesignerData()
  const probs = useFieldProblems(stepId, field)
  const reads = useMemo(() => {
    const names = new Set(data.tables.map((t) => t.name))
    try { return fx.referencedNames(`=${stripLeadingEquals(value)}`).some((n) => names.has(n)) } catch { return false }
  }, [value, data.tables])
  if (!reads) return null
  const bad = probs.find((p) => p.severity === 'error' && /server|whole|push|delegat|can't run|cannot run|read every/i.test(p.message))
  return (
    <span data-testid="delegation-indicator" data-where={bad ? 'error' : 'server'} title={bad?.message ?? 'The table read runs on the server, as the run-as identity.'}
      className={cn('inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[10.5px] font-medium', bad ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')}>
      {bad ? <TriangleAlert className="size-3" /> : <Cloud className="size-3" />}{bad ? "Can't run" : 'Runs on server'}
    </span>
  )
}

export function FxField(p: FxFieldProps) {
  const kind = p.kind ?? 'text'
  const ro = useDesigner((s) => s.readOnly) || !!p.readOnly
  const lit = p.formulaOnly ? null : literalOf(kind, p.value)
  const [mode, setMode] = useState<'value' | 'formula'>(lit === null ? 'formula' : 'value')
  const [syntax, setSyntax] = useState<string | null>(null)
  const focusField = useDesigner((s) => s.focusField)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusField && focusField.step === p.stepId && (focusField.field === p.field || focusField.field.startsWith(`${p.field}.`))) {
      host.current?.scrollIntoView({ block: 'center' })
      host.current?.querySelector<HTMLElement>('textarea,input,select,button')?.focus()
    }
  }, [focusField, p.stepId, p.field])
  const switchMode = (m: 'value' | 'formula') => {
    if (m === 'value' && literalOf(kind, p.value) === null) {
      if (!confirm('This value is a formula. Switch to a plain value and clear it?')) return
      p.onChange('')
    }
    setMode(m)
  }
  const id = `fx-${p.stepId}-${p.field}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const current = literalOf(kind, p.value)
  return (
    <div ref={host} className="grid gap-1" data-field={p.field} data-testid={p.testId ? `${p.testId}-field` : undefined}>
      {(p.label || !p.formulaOnly) && (
        <div className="flex min-h-6 items-center gap-2">
          {p.label && <label htmlFor={id} className="text-xs font-medium">{p.label}{p.required ? <span className="text-destructive"> *</span> : null}</label>}
          <span className="ml-auto flex items-center gap-1">
            {mode === 'formula' && <DelegationChip stepId={p.stepId} field={p.field} value={p.value ?? ''} />}
            {!p.formulaOnly && !ro && (
              <span className="inline-flex rounded border border-border p-0.5 text-[10px]" role="group" aria-label="Value or formula">
                <button type="button" className={cn('rounded px-1.5', mode === 'value' && 'bg-accent font-medium')} onClick={() => switchMode('value')} data-testid="mode-value">Value</button>
                <button type="button" className={cn('rounded px-1.5 font-serif italic', mode === 'formula' && 'bg-accent font-medium')} onClick={() => switchMode('formula')} data-testid="mode-formula">fx</button>
              </span>
            )}
          </span>
        </div>
      )}
      <div id={id}>
        {mode === 'formula' ? (
          <FormulaInput stepId={p.stepId} value={p.value ?? ''} onChange={p.onChange} placeholder={p.placeholder} testId={p.testId} readOnly={ro} onSyntax={setSyntax} />
        ) : kind === 'number' ? (
          <input type="number" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={typeof current === 'string' ? current : ''} readOnly={ro} data-testid={p.testId ?? 'number-input'} onChange={(e) => p.onChange(literalFx('number', e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
        ) : kind === 'boolean' ? (
          <Switch checked={current === true} disabled={ro} onCheckedChange={(v) => p.onChange(literalFx('boolean', v))} data-testid={p.testId ?? 'boolean-input'} aria-label={p.label} />
        ) : kind === 'date' ? (
          <input type="date" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={typeof current === 'string' ? current : ''} readOnly={ro} data-testid={p.testId ?? 'date-input'} onChange={(e) => p.onChange(literalFx('date', e.target.value))} />
        ) : kind === 'choice' ? (
          <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={typeof current === 'string' ? current : ''} disabled={ro} data-testid={p.testId ?? 'choice-input'} onChange={(e) => p.onChange(literalFx('choice', e.target.value))}>
            <option value="">(blank)</option>
            {(p.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : kind === 'lookup' && p.lookupTable ? (
          <RowPicker table={p.lookupTable} value={typeof current === 'string' ? current : ''} onChange={(v) => p.onChange(literalFx('lookup', v))} testId={p.testId} />
        ) : (
          <TextWithTokens stepId={p.stepId} value={typeof current === 'string' ? current : ''} onChange={(t) => p.onChange(literalFx('text', t))} multiline={p.multiline} placeholder={p.placeholder} testId={p.testId} readOnly={ro} />
        )}
      </div>
      {p.hint && <p className="text-[11px] text-muted-foreground">{p.hint}</p>}
      <FieldError stepId={p.stepId} field={p.field} extra={syntax} />
    </div>
  )
}
