import { useEffect, useMemo, useRef, useState } from 'react'
import type { ControlNode, FxDiagnostic } from '@/contracts'
import { controls } from '@/controls'
import { fx } from '@/fx'
import { getEvaluator, type Evaluator } from '@/runtime/evaluator'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { summarize, typeName } from '@/runtime/util'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const GROUPS = ['Content', 'Data', 'Layout', 'Style', 'Behaviour'] as const

interface Suggestion { label: string; insert: string; kind: string; detail?: string; doc?: string }

function inString(before: string): boolean {
  let s = false
  for (const ch of before) if (ch === '"') s = !s
  return s
}

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
    else if (owner === 'ThisItem') {
      const row = ctx.rows[ctx.rows.length - 1]?.item ?? {}
      names = Object.keys(row).filter((k) => !k.startsWith('__')).map((k) => ({ label: k, insert: k, kind: 'field' }))
    } else {
      const target = owner === 'Self' ? node : owner === 'Parent' ? ev.byId.get(node.id)?.parent : ev.byName.get(owner)?.node
      if (target) {
        const metas = controls.propsOf(target.type).map((m) => ({ label: m.name, insert: m.name, kind: 'prop', detail: m.kind }))
        const outs = controls.get(target.type).outputs.map((o) => ({ label: o.name, insert: o.name, kind: 'output' }))
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
  for (const f of fx.functions()) all.push({ label: f.name, insert: f.name + '(', kind: f.kind === 'behaviour' ? 'action' : 'fn', detail: f.signature, doc: f.summary })
  for (const name of ev.byName.keys()) {
    const info = ev.byName.get(name)!
    all.push({ label: name, insert: name, kind: info.node.type === 'Screen' ? 'screen' : 'control', detail: info.node.type })
  }
  for (const c of Object.keys(ev.rt.collections)) all.push({ label: c, insert: c, kind: 'collection' })
  for (const v of Object.keys(ev.rt.vars)) all.push({ label: v, insert: v, kind: 'variable' })
  for (const v of Object.keys(ev.rt.context)) all.push({ label: v, insert: v, kind: 'context' })
  for (const e of Object.keys(fx.enums())) all.push({ label: e, insert: e, kind: 'enum' })
  all.push({ label: 'Self', insert: 'Self', kind: 'scope' }, { label: 'Parent', insert: 'Parent', kind: 'scope' })
  if (ctx.rows.length) all.push({ label: 'ThisItem', insert: 'ThisItem', kind: 'scope' })
  const items = rank(all, partial)
    .filter((i) => !(i.label === partial && i.kind !== 'fn' && i.kind !== 'action'))
    .slice(0, 10)
  return items.length ? { items, start: caret - partial.length } : null
}

const kindColor: Record<string, string> = {
  fn: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  action: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  control: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  screen: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
}

export function FormulaBar() {
  const selection = useStore((s) => s.selection)
  const app = useStore((s) => s.app)
  const rt = useStore((s) => s.runtime)
  const mode = useStore((s) => s.mode)
  const ev = getEvaluator(app, rt)
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

  const commit = (text: string) => {
    setDraft(text)
    const f = '=' + text
    const d = fx.check(f)
    if (d.length === 0) {
      setSyntaxErr(null)
      sent.current = f
      useStore.getState().setProp(node.id, prop, f, `formula:${node.id}:${prop}`)
    } else setSyntaxErr(d[0])
  }

  const refreshSuggestions = (text: string, caret: number, force = false) => {
    const r = suggestionsFor(text, caret, node, ev, force)
    setSugg(r ? { ...r, index: 0 } : null)
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
        <textarea
          ref={ta}
          data-testid="formula-input"
          spellCheck={false}
          autoComplete="off"
          wrap={focused ? 'soft' : 'off'}
          rows={1}
          value={draft}
          disabled={multi}
          placeholder={multi ? 'Multiple controls selected' : 'Type a formula'}
          className={cn(
            'min-w-0 flex-1 resize-none bg-transparent py-[3px] pr-2 font-mono text-[13px] leading-[18px] outline-none placeholder:text-muted-foreground/60',
            !focused && 'overflow-hidden whitespace-nowrap text-ellipsis',
          )}
          style={{ height: 26 }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setSugg(null)
            if (syntaxErr) {
              setDraft(body(stored))
              setSyntaxErr(null)
            }
          }}
          onChange={(e) => {
            commit(e.target.value)
            refreshSuggestions(e.target.value, e.target.selectionStart)
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
      {(message || chip) && !(focused && draft.includes('\n')) && (
        <div className="pointer-events-none absolute left-0 top-[31px] z-30 flex max-w-full items-center gap-1.5">
          {message ? (
            <span data-testid="formula-error" className="max-w-[640px] truncate rounded bg-destructive px-1.5 py-0.5 text-[11px] font-medium text-white shadow">
              {message}
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
