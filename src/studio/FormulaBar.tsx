import { useEffect, useMemo, useRef, useState } from 'react'
import type { ControlNode, FxDiagnostic } from '@/contracts'
import { controls } from '@/controls'
import { fx } from '@/fx'
import { type Evaluator } from '@/runtime/evaluator'
import { evaluatorOf, useStore } from '@/runtime/store'
import { isTable, tableColumns, tableNames } from '@/runtime/data'
import { useUi } from '@/runtime/ui'
import { summarize, typeName } from '@/runtime/util'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { Cloud, Monitor, TriangleAlert } from 'lucide-react'

const GROUPS = ['Content', 'Data', 'Layout', 'Style', 'Behaviour'] as const

interface Suggestion { label: string; insert: string; kind: string; detail?: string; doc?: string }

function inString(before: string): boolean {
  let s = false
  for (const ch of before) if (ch === '"') s = !s
  return s
}

/** columns of a data source name: platform table, collection or named formula returning a table */
function columnsOf(name: string, ev: Evaluator): Suggestion[] {
  if (isTable(name)) return tableColumns(name).map((c) => ({ label: c.name, insert: c.name, kind: 'column', detail: c.type }))
  const coll = ev.rt.collections[name]
  const rows = coll ?? (ev.named.has(name) ? ev.evalNamed(name).value : null)
  if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && rows[0] !== null && !Array.isArray(rows[0])) {
    return Object.keys(rows[0] as object)
      .filter((k) => !k.startsWith('__'))
      .map((k) => ({ label: k, insert: k, kind: 'column' }))
  }
  return []
}

/** the bar already shows a leading "=", so one typed (or pasted) "=" after optional whitespace is dropped: "=Filter(...)" and "Filter(...)" are the same formula */
export function stripLeadingEquals(text: string): string {
  return text.replace(/^\s*=/, '')
}

/** innermost unclosed call before the caret: function name, first argument text, argument index */
export function callContext(text: string): { fn: string; first: string; arg: number } | null {
  let depth = 0
  let inStr = false
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '"') inStr = !inStr
    if (inStr) continue
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth === 0) {
        const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(0, i))
        if (!m) return null
        // split arguments at top level
        const inner = text.slice(i + 1)
        let d = 0
        let s2 = false
        let arg = 0
        let first = ''
        for (const c of inner) {
          if (c === '"') s2 = !s2
          if (!s2) {
            if (c === '(' || c === '[' || c === '{') d++
            else if (c === ')' || c === ']' || c === '}') d--
            else if (c === ',' && d === 0) {
              arg++
              continue
            }
          }
          if (arg === 0) first += c
        }
        return { fn: m[1], first: first.trim(), arg }
      }
      depth--
    }
  }
  return null
}

const ROW_FUNCS = new Set(['Filter', 'LookUp', 'Search', 'Sort', 'SortByColumns', 'AddColumns', 'DropColumns', 'ShowColumns', 'RenameColumns', 'CountIf', 'ForAll', 'Sum', 'Average', 'Min', 'Max', 'Concat', 'Distinct', 'RemoveIf', 'UpdateIf', 'GroupBy', 'StdevP', 'VarP', 'Patch', 'Remove', 'Collect', 'Choices'])

function suggestionsFor(text: string, caret: number, node: ControlNode, ev: Evaluator, force: boolean): { items: Suggestion[]; start: number } | null {
  const before = text.slice(0, caret)
  if (inString(before)) return null
  const member = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before)
  const ctx = ev.designCtx(node)
  const rank = (items: Suggestion[], partial: string) => {
    const p = partial.toLowerCase()
    const starts = items.filter((i) => i.label.toLowerCase().startsWith(p))
    const inc = items.filter((i) => !i.label.toLowerCase().startsWith(p) && i.label.toLowerCase().includes(p))
    return [...starts, ...inc]
  }
  if (member) {
    const [, owner, partial] = member
    let names: Suggestion[] = []
    const enums = fx.enums()
    if (enums[owner]) names = enums[owner].map((m) => ({ label: m, insert: m, kind: 'enum' }))
    else if (owner === 'App') names = ['Width', 'Height', 'DesignWidth', 'DesignHeight', 'ActiveScreen', 'Name'].map((m) => ({ label: m, insert: m, kind: 'prop' }))
    else if (!ev.byName.has(owner) && columnsOf(owner, ev).length) names = columnsOf(owner, ev)
    else if (owner === 'ThisItem') {
      const row = ctx.rows[ctx.rows.length - 1]?.item ?? {}
      names = Object.keys(row).filter((k) => !k.startsWith('__')).map((k) => ({ label: k, insert: k, kind: 'field' }))
    } else {
      const target = owner === 'Self' ? node : owner === 'Parent' ? ev.byId.get(node.id)?.parent : ev.byName.get(owner)?.node
      if (target) {
        const metas = controls.propsOf(target.type).map((m) => ({ label: m.name, insert: m.name, kind: 'prop', detail: m.kind }))
        const outs = controls
          .get(target.type)
          .outputs.filter((o) => !o.name.startsWith('__'))
          .map((o) => ({ label: o.name, insert: o.name, kind: 'output' }))
        names = [...outs, ...metas]
      }
    }
    const items = rank(names, partial).slice(0, 12)
    return items.length ? { items, start: caret - partial.length } : null
  }
  const w = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before)
  const partial = w ? w[1] : ''
  if (!partial && !force) return null
  const all: Suggestion[] = []
  const call = callContext(before)
  if (call && call.arg >= 1 && ROW_FUNCS.has(call.fn) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(call.first)) all.push(...columnsOf(call.first, ev))
  for (const t of tableNames()) all.push({ label: t, insert: t, kind: 'table' })
  for (const n of ev.named.keys()) all.push({ label: n, insert: n, kind: 'named' })
  all.push({ label: 'App', insert: 'App', kind: 'scope' })
  for (const f of ev.engine.functions()) all.push({ label: f.name, insert: f.name + '(', kind: f.kind === 'behaviour' ? 'action' : 'fn', detail: f.signature, doc: f.summary })
  for (const name of ev.byName.keys()) {
    const info = ev.byName.get(name)!
    all.push({ label: name, insert: name, kind: info.node.type === 'Screen' ? 'screen' : 'component', detail: info.node.type })
  }
  for (const c of Object.keys(ev.rt.collections)) all.push({ label: c, insert: c, kind: 'collection' })
  for (const v of Object.keys(ev.rt.vars)) all.push({ label: v, insert: v, kind: 'variable' })
  const scr = ev.screenIdOf(node)
  for (const v of Object.keys((scr && ev.rt.context[scr]) || {})) all.push({ label: v, insert: v, kind: 'context' })
  for (const e of Object.keys(fx.enums())) all.push({ label: e, insert: e, kind: 'enum' })
  all.push({ label: 'Self', insert: 'Self', kind: 'scope' }, { label: 'Parent', insert: 'Parent', kind: 'scope' })
  if (ctx.rows.length) all.push({ label: 'ThisItem', insert: 'ThisItem', kind: 'scope' })
  const seen = new Set<string>()
  const items = rank(all, partial)
    .filter((i) => (seen.has(i.kind + i.label) ? false : (seen.add(i.kind + i.label), true)))
    .filter((i) => !(i.label === partial && i.kind !== 'fn' && i.kind !== 'action'))
    .slice(0, 10)
  return items.length ? { items, start: caret - partial.length } : null
}

const kindColor: Record<string, string> = {
  fn: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  action: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  component: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  screen: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  table: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  column: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  named: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
}

export function FormulaBar() {
  const selection = useStore((s) => s.selection)
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const env = useStore((s) => s.env)
  const mode = useStore((s) => s.mode)
  const ev = evaluatorOf({ ...useStore.getState(), app, runtime: rt, env })
  const node = selection.length ? ev.byId.get(selection[0])?.node : undefined
  const lastProp = useUi((s) => (node ? s.lastProp[node.type] : undefined))

  if (!node || mode !== 'design') return <div className="h-10 shrink-0 border-b border-border bg-card" />
  const metas = controls.propsOf(node.type)
  const prop = metas.some((m) => m.name === lastProp) ? lastProp! : controls.get(node.type).primaryProp
  return (
    <div className="relative z-20 flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <Select value={prop} onValueChange={(v) => useUi.getState().setLastProp(node.type, v)}>
        <SelectTrigger size="sm" data-testid="prop-select" className="h-7 w-[180px] text-xs font-medium">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUPS.map((g) => {
            const list = metas.filter((m) => m.group === g)
            if (!list.length) return null
            return (
              <SelectGroup key={g}>
                <SelectLabel>{g}</SelectLabel>
                {list.map((m) => (
                  <SelectItem key={m.name} value={m.name}>
                    {m.label ?? m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          })}
        </SelectContent>
      </Select>
      <span className="select-none font-serif text-sm italic text-primary">fx</span>
      <FormulaEditor key={`${node.id}:${prop}`} node={node} prop={prop} ev={ev} multi={selection.length > 1} />
    </div>
  )
}

function FormulaEditor({ node, prop, ev, multi }: { node: ControlNode; prop: string; ev: Evaluator; multi: boolean }) {
  const meta = controls.propsOf(node.type).find((m) => m.name === prop)!
  const stored = node.props[prop] ?? meta.default
  const body = (f: string) => (f.startsWith('=') ? f.slice(1) : f)
  const [draft, setDraft] = useState(body(stored))
  const [syntaxErr, setSyntaxErr] = useState<FxDiagnostic | null>(null)
  const [focused, setFocused] = useState(false)
  const [sugg, setSugg] = useState<{ items: Suggestion[]; start: number; index: number } | null>(null)
  const [tip, setTip] = useState<{ name: string; signature: string; summary: string; argIndex: number } | null>(null)
  const sent = useRef(stored)
  const ta = useRef<HTMLTextAreaElement>(null)
  const focusToken = useUi((s) => s.focusToken)
  const firstToken = useRef(focusToken)

  // follow external changes (undo, properties panel) unless they are our own echo
  useEffect(() => {
    if (stored !== sent.current) {
      sent.current = stored
      setDraft(body(stored))
      setSyntaxErr(null)
    }
  }, [stored])

  useEffect(() => {
    if (focusToken !== firstToken.current) {
      firstToken.current = focusToken
      const el = ta.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
  }, [focusToken])

  // auto-grow while focused (max 6 lines)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    if (!focused) {
      el.style.height = '26px'
      return
    }
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 6 * 18 + 8) + 'px'
  }, [draft, focused])

  const commit = (raw: string) => {
    const text = stripLeadingEquals(raw)
    setDraft(text)
    const f = '=' + text
    const d = ev.engine.check(f)
    if (d.length === 0) {
      setSyntaxErr(null)
      sent.current = f
      useStore.getState().setProp(node.id, prop, f, `formula:${node.id}:${prop}`)
    } else setSyntaxErr(d[0])
  }

  const refreshSuggestions = (text: string, caret: number, force = false) => {
    const r = suggestionsFor(text, caret, node, ev, force)
    setSugg(r ? { ...r, index: 0 } : null)
    try {
      setTip(ev.engine.signatureAt('=' + text, caret + 1))
    } catch {
      setTip(null)
    }
  }

  const accept = (s: Suggestion) => {
    if (!sugg) return
    const el = ta.current!
    const caret = el.selectionStart
    const text = draft.slice(0, sugg.start) + s.insert + draft.slice(caret)
    const pos = sugg.start + s.insert.length
    commit(text)
    setSugg(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
      if (s.insert.endsWith('.')) refreshSuggestions(text, pos)
    })
  }

  const evalErr = ev.errorsOf(node)[prop]
  const isAction = meta.kind === 'action'
  const pe = !isAction ? ev.evalProp(node, prop, ev.designCtx(node)) : null
  const message = syntaxErr ? syntaxErr.message : evalErr

  const chip = useMemo(() => {
    if (!pe || message) return null
    return { type: typeName(pe.value), text: summarize(pe.value, 90) }
  }, [pe, message])

  // server mode: where a table formula runs, and the sub-expression that can't run on the server (wavy underline)
  const dlg = pe?.delegation
  const squiggle = useMemo(() => {
    if (!dlg || syntaxErr || draft !== body(stored)) return null
    const d = dlg.diagnostics.find((x) => x.severity === 'error') ?? dlg.diagnostics.find((x) => x.severity === 'warning')
    if (!d || d.end <= d.start) return null
    // diagnostics count the leading '=' (the bar shows the formula without it)
    return { start: Math.max(0, d.start - 1), end: Math.max(0, d.end - 1), error: d.severity === 'error', title: `${d.message}${d.suggestion ? `. ${d.suggestion}` : ''}` }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlg, syntaxErr, draft, stored])

  return (
    <div className="relative h-[26px] min-w-0 flex-1">
      <div
        className={cn(
          'absolute inset-x-0 top-0 flex items-start rounded-md border bg-background transition-shadow',
          focused ? 'z-40 border-primary shadow-lg ring-2 ring-primary/20' : 'border-input',
          message && 'border-destructive',
        )}
      >
        <span className="select-none pl-2 pr-1 font-mono text-[13px] leading-[24px] text-muted-foreground">=</span>
        <div className="relative min-w-0 flex-1">
        {squiggle && (
          <div
            aria-hidden
            data-testid="delegation-squiggle"
            className={cn(
              'pointer-events-none absolute inset-0 overflow-hidden py-[3px] pr-2 font-mono text-[13px] leading-[18px] text-transparent',
              focused ? 'whitespace-pre-wrap break-words' : 'whitespace-nowrap',
            )}
          >
            {draft.slice(0, squiggle.start)}
            <span className={cn('underline decoration-wavy decoration-[1.5px] underline-offset-[3px]', squiggle.error ? 'decoration-destructive' : 'decoration-amber-500')}>{draft.slice(squiggle.start, squiggle.end)}</span>
            {draft.slice(squiggle.end)}
          </div>
        )}
        <textarea
          ref={ta}
          data-testid="formula-input"
          spellCheck={false}
          autoComplete="off"
          wrap={focused ? 'soft' : 'off'}
          rows={1}
          value={draft}
          disabled={multi}
          placeholder={multi ? 'Multiple UI components selected' : 'Type a formula'}
          className={cn(
            'block w-full min-w-0 resize-none bg-transparent py-[3px] pr-2 font-mono text-[13px] leading-[18px] outline-none placeholder:text-muted-foreground/60',
            !focused && 'overflow-hidden whitespace-nowrap text-ellipsis',
          )}
          style={{ height: 26 }}
          title={squiggle?.title}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setSugg(null)
            setTip(null)
            if (syntaxErr) {
              setDraft(body(stored))
              setSyntaxErr(null)
            }
          }}
          onChange={(e) => {
            const text = stripLeadingEquals(e.target.value)
            commit(text)
            refreshSuggestions(text, Math.max(0, e.target.selectionStart - (e.target.value.length - text.length)))
          }}
          onClick={(e) => refreshSuggestions(draft, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (sugg) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = sugg.items.length
                setSugg({ ...sugg, index: (sugg.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
                return
              }
              if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault()
                accept(sugg.items[sugg.index])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setSugg(null)
                return
              }
            }
            if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              refreshSuggestions(draft, e.currentTarget.selectionStart, true)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.currentTarget.blur()
            }
          }}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refreshSuggestions(draft, e.currentTarget.selectionStart)
          }}
        />
        </div>
        {dlg && (
          <span
            data-testid="delegation-indicator"
            data-where={dlg.where}
            title={dlg.explain}
            className={cn(
              'mr-1 mt-[3px] flex h-[18px] shrink-0 select-none items-center gap-1 rounded px-1.5 text-[10.5px] font-medium',
              dlg.where === 'server' ? 'bg-primary/10 text-primary' : dlg.where === 'browser' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-destructive/10 text-destructive',
            )}
          >
            {dlg.where === 'server' ? <Cloud className="size-3" /> : dlg.where === 'browser' ? <Monitor className="size-3" /> : <TriangleAlert className="size-3" />}
            {dlg.where === 'server' ? 'Runs on server' : dlg.where === 'browser' ? 'Runs in browser' : "Can't run"}
          </span>
        )}
        {tip && focused && !sugg && (
          <div data-testid="call-tip" className="absolute left-0 top-full z-50 mt-1 max-w-[640px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-lg">
            <div className="font-mono text-xs">
              <SignatureText signature={tip.signature} argIndex={tip.argIndex} />
            </div>
            {tip.summary && <div className="mt-0.5 text-[11px] text-muted-foreground">{tip.summary}</div>}
          </div>
        )}
        {sugg && focused && (
          <div
            className="absolute left-0 top-full z-50 mt-1 max-h-64 w-[460px] max-w-[80vw] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            {sugg.items.map((s, i) => (
              <button
                key={s.kind + s.label}
                type="button"
                data-testid="autocomplete-item"
                onMouseEnter={() => setSugg({ ...sugg, index: i })}
                onClick={() => accept(s)}
                className={cn('flex w-full items-baseline gap-2 rounded px-2 py-1 text-left', i === sugg.index && 'bg-accent text-accent-foreground')}
              >
                <span className={cn('shrink-0 rounded px-1 text-[10px] font-medium uppercase tracking-wide', kindColor[s.kind] ?? 'bg-muted text-muted-foreground')}>{s.kind}</span>
                <span className="font-mono text-xs font-medium">{s.label}</span>
                {(s.detail || s.doc) && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{s.kind === 'fn' || s.kind === 'action' ? `${s.detail} — ${s.doc ?? ''}` : s.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {(message || chip || pe?.warning) && !(focused && draft.includes('\n')) && (
        <div className="pointer-events-none absolute left-0 top-[31px] z-30 flex max-w-full items-center gap-1.5">
          {message ? (
            <span data-testid="formula-error" className="max-w-[640px] truncate rounded bg-destructive px-1.5 py-0.5 text-[11px] font-medium text-white shadow">
              {message}
            </span>
          ) : pe?.warning ? (
            <span data-testid="formula-warning" className="max-w-[640px] truncate rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-medium text-white shadow">
              {pe.warning}
            </span>
          ) : (
            chip && (
              <span data-testid="formula-result" className="flex max-w-[640px] items-center gap-1.5 rounded border border-border bg-card px-1.5 py-0.5 text-[11px] shadow-sm">
                <span className="font-medium text-primary">{chip.type}</span>
                <span className="truncate font-mono text-muted-foreground">{chip.text}</span>
              </span>
            )
          )}
        </div>
      )}
    </div>
  )
}

/** signature with the current argument in bold: 'Filter(source, condition, ...)' */
function SignatureText({ signature, argIndex }: { signature: string; argIndex: number }) {
  const open = signature.indexOf('(')
  const close = signature.lastIndexOf(')')
  if (open < 0 || close < open) return <span>{signature}</span>
  const args = signature.slice(open + 1, close).split(',')
  const last = args.length - 1
  const idx = argIndex > last && /\.\.\.|\[/.test(args[last] ?? '') ? last : argIndex
  return (
    <span>
      <span className="font-semibold text-primary">{signature.slice(0, open)}</span>(
      {args.map((a, i) => (
        <span key={i}>
          {i > 0 && ','}
          <span className={i === idx ? 'rounded bg-primary/15 font-semibold text-foreground' : 'text-muted-foreground'}>{a}</span>
        </span>
      ))}
      ){signature.slice(close + 1)}
    </span>
  )
}
