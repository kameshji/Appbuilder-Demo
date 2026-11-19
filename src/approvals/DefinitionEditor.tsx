/**
 * The visual editor of approval definitions (P1-E), used by the policy editor and the flow step form: approver pickers
 * (person, role, team, department, department head, manager, manager chain), stages (add, reorder, approvers, any / all
 * / quorum, a condition, a due date per stage), threshold rules (a condition builder over the request's fields) and
 * answers (label, kind, comment required). No JSON needed for anything in docs/guide/maker/approvals.md.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { ApprovalRule, ApprovalStageDef, ResponseKind, ResponseOption, StageMode } from '@/platform/approvals'
import { parseApproverRef } from '@/platform/approvals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { COND_OPS, PICK_KINDS, compileFieldCondition, move, parseFieldCondition, refFor, refLabel, type ApproverDirectory, type FieldCondition, type PickKind } from './definitionKit'

const SELECT = 'h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

/** people and teams (the organisation directory), roles and departments of the environment */
export function useApproverDirectory(): ApproverDirectory {
  const roles = usePlatform((s) => s.roles)
  const departments = usePlatform((s) => s.departments)
  const [dir, setDir] = useState<{ people: ApproverDirectory['people']; teams: ApproverDirectory['teams'] }>({ people: [], teams: [] })
  useEffect(() => {
    let alive = true
    platform.org.directory().then((d) => { if (alive) setDir({ people: d.users, teams: d.teams }) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return useMemo(() => ({ people: dir.people, teams: dir.teams, roles: roles.map((r) => ({ id: r.id, name: r.name })), departments: (departments ?? []).map((d) => ({ id: d.id, code: d.code, name: d.name })) }), [dir, roles, departments])
}

/** chips of references and an "add" row: pick a kind, then who */
export function ApproverPicker({ value, onChange, dir, readOnly, testId = 'approver-picker', single }: { value: string[]; onChange(next: string[]): void; dir: ApproverDirectory; readOnly?: boolean; testId?: string; single?: boolean }) {
  const [kind, setKind] = useState<PickKind>('person')
  const [v, setV] = useState('')
  const ref = refFor(kind, v)
  const chainIn = value.some((r) => parseApproverRef(r)?.kind === 'managerChain')
  const isChain = kind === 'managerChain' || kind === 'chainTitle' || kind === 'chainRole'
  const add = () => {
    if (!ref || value.includes(ref)) return
    onChange(single ? [ref] : [...value, ref])
    setV('')
  }
  const listId = `${testId}-people`
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap gap-1">
        {value.length === 0 && <span className="text-xs text-muted-foreground">Nobody yet.</span>}
        {value.map((r) => (
          <span key={r} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs" data-testid="approver-chip" title={r}>
            {refLabel(r, dir)}
            {!readOnly && <button type="button" aria-label={`Remove ${refLabel(r, dir)}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((x) => x !== r))}><X className="size-3" /></button>}
          </span>
        ))}
      </div>
      {!readOnly && (!single || value.length === 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select className={SELECT} aria-label="Who" value={kind} onChange={(e) => { setKind(e.target.value as PickKind); setV('') }} data-testid={`${testId}-kind`}>
            {PICK_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          {kind === 'person' && (<>
            <Input className="h-8 w-56" list={listId} placeholder="Name or email" value={v} onChange={(e) => {
              const t = e.target.value
              const hit = dir.people.find((p) => `${p.name} (${p.email})` === t)
              setV(hit ? hit.email : t)
            }} data-testid={`${testId}-person`} />
            <datalist id={listId}>{dir.people.map((p) => <option key={p.id} value={`${p.name} (${p.email})`} />)}</datalist>
          </>)}
          {(kind === 'role' || kind === 'chainRole') && (
            <select className={SELECT} aria-label="Role" value={v} onChange={(e) => setV(e.target.value)} data-testid={`${testId}-role`}>
              <option value="">Choose a role</option>
              {dir.roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
            </select>
          )}
          {kind === 'team' && (
            <select className={SELECT} aria-label="Team" value={v} onChange={(e) => setV(e.target.value)} data-testid={`${testId}-team`}>
              <option value="">Choose a team</option>
              {dir.teams.map((t) => <option key={t.id} value={t.code}>{t.name} ({t.code})</option>)}
            </select>
          )}
          {(kind === 'department' || kind === 'departmentHead') && (
            dir.departments.length
              ? <select className={SELECT} aria-label="Department" value={v} onChange={(e) => setV(e.target.value)} data-testid={`${testId}-department`}>
                  <option value="">{kind === 'departmentHead' ? 'The requester\'s department' : 'Choose a department'}</option>
                  {dir.departments.map((d) => <option key={d.id} value={d.code}>{d.name} ({d.code})</option>)}
                </select>
              : <Input className="h-8 w-40" placeholder={kind === 'departmentHead' ? 'Code (empty: the requester\'s)' : 'Department code'} value={v} onChange={(e) => setV(e.target.value)} />
          )}
          {(kind === 'manager' || kind === 'managerChain') && (
            <select className={SELECT} aria-label="Levels" value={v || (kind === 'manager' ? '1' : '2')} onChange={(e) => setV(e.target.value)} data-testid={`${testId}-levels`}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{kind === 'manager' ? (n === 1 ? 'Direct manager' : `${n} levels up`) : `${n} level${n === 1 ? '' : 's'}`}</option>)}
            </select>
          )}
          {kind === 'chainTitle' && <Input className="h-8 w-40" placeholder="Job title, e.g. CEO" value={v} onChange={(e) => setV(e.target.value)} data-testid={`${testId}-title`} />}
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={!ref || (isChain && value.length > 0) || (chainIn && !single)} onClick={add} data-testid={`${testId}-add`}><Plus className="size-3.5" />Add</Button>
          <span className="w-full text-[11px] text-muted-foreground">{isChain && value.length > 0 ? 'A manager chain must be the only approver of its stage: remove the others first.' : chainIn ? 'A manager chain is the only approver of its stage.' : PICK_KINDS.find((k) => k.kind === kind)?.hint}</span>
        </div>
      )}
    </div>
  )
}

/** rules on the request's fields joined by and / or; a formula field when the condition has another shape */
export function FieldConditionEditor({ value, onChange, fields, readOnly, testId = 'field-condition' }: { value: string | undefined; onChange(fx: string | undefined): void; fields: string[]; readOnly?: boolean; testId?: string }) {
  const parsed = useMemo(() => parseFieldCondition(value, fields), [value, fields])
  const [asFormula, setAsFormula] = useState(parsed === null)
  if (asFormula || parsed === null) {
    return (
      <div className="flex flex-col gap-1" data-testid={testId}>
        <Input className="h-8 font-mono text-xs" placeholder="Amount > 10000" value={value ?? ''} disabled={readOnly} onChange={(e) => onChange(e.target.value || undefined)} data-testid={`${testId}-formula`} />
        {parsed !== null && !readOnly && <button type="button" className="w-fit text-[11px] text-primary hover:underline" onClick={() => setAsFormula(false)}>Use the condition builder</button>}
        {parsed === null && <span className="text-[11px] text-muted-foreground">This condition is a formula the builder cannot show.</span>}
      </div>
    )
  }
  const c: FieldCondition = parsed
  const emit = (next: FieldCondition) => onChange(compileFieldCondition(next) || undefined)
  const fieldList = `${testId}-fields`
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {c.rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5" data-testid={`${testId}-rule`}>
          {i > 0 ? (
            <select className={`${SELECT} w-16`} aria-label="And or" value={c.join} disabled={readOnly} onChange={(e) => emit({ ...c, join: e.target.value as 'and' | 'or' })}><option value="and">and</option><option value="or">or</option></select>
          ) : <span className="w-16 text-xs text-muted-foreground">When</span>}
          <Input className="h-8 w-32" list={fieldList} placeholder="Field, e.g. Amount" value={r.field} disabled={readOnly} onChange={(e) => emit({ ...c, rules: c.rules.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} data-testid={`${testId}-field`} />
          <select className={SELECT} aria-label="Comparison" value={r.op} disabled={readOnly} onChange={(e) => emit({ ...c, rules: c.rules.map((x, j) => (j === i ? { ...x, op: e.target.value as FieldCondition['rules'][number]['op'] } : x)) })} data-testid={`${testId}-op`}>
            {COND_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          {!COND_OPS.find((o) => o.op === r.op)?.noValue && <Input className="h-8 w-28" placeholder="10000" value={r.value} disabled={readOnly} onChange={(e) => emit({ ...c, rules: c.rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} data-testid={`${testId}-value`} />}
          {!readOnly && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Remove condition" onClick={() => emit({ ...c, rules: c.rules.filter((_, j) => j !== i) })}><X className="size-3.5" /></Button>}
        </div>
      ))}
      <datalist id={fieldList}>{fields.map((f) => <option key={f} value={f} />)}</datalist>
      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="h-7 w-fit text-xs" onClick={() => onChange(compileFieldCondition({ ...c, rules: [...c.rules, { field: fields[0] ?? 'Amount', op: 'gt', value: '0' }] }))} data-testid={`${testId}-add`}><Plus className="size-3" />Condition</Button>
          <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setAsFormula(true)}>Edit as a formula</button>
        </div>
      )}
    </div>
  )
}

function ModeFields({ mode, quorum, onChange, readOnly, count }: { mode: StageMode | undefined; quorum: number | undefined; onChange(p: { mode?: StageMode; quorum?: number }): void; readOnly?: boolean; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <select className={SELECT} aria-label="How they decide" value={mode ?? 'any'} disabled={readOnly} onChange={(e) => { const m = e.target.value as StageMode; onChange({ mode: m === 'any' ? undefined : m, quorum: m === 'quorum' ? (quorum ?? Math.max(1, Math.min(2, count))) : undefined }) }} data-testid="stage-mode">
        <option value="any">First to respond</option><option value="all">Everyone must approve</option><option value="quorum">Quorum (N of them)</option>
      </select>
      {mode === 'quorum' && <Input type="number" min={1} className="h-8 w-16" aria-label="How many must approve" value={quorum ?? ''} disabled={readOnly} onChange={(e) => onChange({ mode, quorum: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} data-testid="stage-quorum" />}
    </div>
  )
}

const hoursOf = (m: number | undefined) => (m ? String(Math.round((m / 60) * 100) / 100) : '')
const minutesOf = (h: string) => (h.trim() ? Math.max(1, Math.round(Number(h) * 60)) : undefined)

/** sequential stages: add, reorder, remove; approvers, mode, condition, due per stage */
export function StagesEditor({ stages, onChange, dir, fields, readOnly }: { stages: ApprovalStageDef[]; onChange(next: ApprovalStageDef[]): void; dir: ApproverDirectory; fields: string[]; readOnly?: boolean }) {
  const setAt = (i: number, patch: Partial<ApprovalStageDef>) => onChange(stages.map((s, j) => {
    if (j !== i) return s
    const n = { ...s, ...patch } as ApprovalStageDef & Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete n[k]
    return n
  }))
  return (
    <div className="flex flex-col gap-2" data-testid="stages-editor">
      {stages.map((s, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-2" data-testid="stage-card">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">{i + 1}.</span>
            <Input className="h-8 w-40" placeholder={`Stage ${i + 1}`} aria-label="Stage name" value={s.name ?? ''} disabled={readOnly} onChange={(e) => setAt(i, { name: e.target.value || undefined })} data-testid="stage-name" />
            <ModeFields mode={s.mode} quorum={s.quorum} readOnly={readOnly} count={s.approvers.length} onChange={(p) => setAt(i, p)} />
            {!readOnly && <div className="ml-auto flex">
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Move up" disabled={i === 0} onClick={() => onChange(move(stages, i, i - 1))} data-testid="stage-up"><ArrowUp className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Move down" disabled={i === stages.length - 1} onClick={() => onChange(move(stages, i, i + 1))} data-testid="stage-down"><ArrowDown className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Remove stage" onClick={() => onChange(stages.filter((_, j) => j !== i))} data-testid="stage-remove"><Trash2 className="size-3.5" /></Button>
            </div>}
          </div>
          <ApproverPicker value={s.approvers} onChange={(a) => setAt(i, { approvers: a })} dir={dir} readOnly={readOnly} testId={`stage-${i}-approvers`} />
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-64 flex-1 flex-col gap-1"><span className="text-[11px] font-medium">Only when (optional)</span><FieldConditionEditor value={s.condition} onChange={(c) => setAt(i, { condition: c })} fields={fields} readOnly={readOnly} testId={`stage-${i}-condition`} /></div>
            <label className="flex flex-col gap-1 text-[11px] font-medium">Due in (hours, optional)<Input type="number" min={0} step="any" className="h-8 w-24" value={hoursOf(s.dueMinutes)} disabled={readOnly} onChange={(e) => setAt(i, { dueMinutes: minutesOf(e.target.value) })} data-testid="stage-due" /></label>
          </div>
        </div>
      ))}
      {!readOnly && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...stages, { approvers: [] }])} data-testid="stage-add"><Plus className="size-3.5" />Add stage</Button>}
    </div>
  )
}

/** threshold rules: when a condition on the fields holds, a stage is added after the others */
export function RulesEditor({ rules, onChange, dir, fields, readOnly }: { rules: ApprovalRule[]; onChange(next: ApprovalRule[]): void; dir: ApproverDirectory; fields: string[]; readOnly?: boolean }) {
  const setAt = (i: number, patch: Partial<ApprovalRule>) => onChange(rules.map((r, j) => {
    if (j !== i) return r
    const n = { ...r, ...patch } as ApprovalRule & Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) if (v === undefined || (v === '' && k !== 'condition')) delete n[k]
    return n
  }))
  return (
    <div className="flex flex-col gap-2" data-testid="rules-editor">
      {rules.map((r, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-2" data-testid="rule-card">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input className="h-8 w-40" placeholder={`Rule ${i + 1}`} aria-label="Rule name" value={r.name ?? ''} disabled={readOnly} onChange={(e) => setAt(i, { name: e.target.value || undefined })} data-testid="rule-name" />
            <ModeFields mode={r.mode} quorum={r.quorum} readOnly={readOnly} count={r.approvers.length} onChange={(p) => setAt(i, p)} />
            {!readOnly && <div className="ml-auto flex">
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Move up" disabled={i === 0} onClick={() => onChange(move(rules, i, i - 1))}><ArrowUp className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => onChange(move(rules, i, i + 1))}><ArrowDown className="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))} data-testid="rule-remove"><Trash2 className="size-3.5" /></Button>
            </div>}
          </div>
          <FieldConditionEditor value={r.condition} onChange={(c) => setAt(i, { condition: c ?? '' })} fields={fields} readOnly={readOnly} testId={`rule-${i}-condition`} />
          <span className="text-[11px] font-medium">then also ask</span>
          <ApproverPicker value={r.approvers} onChange={(a) => setAt(i, { approvers: a })} dir={dir} readOnly={readOnly} testId={`rule-${i}-approvers`} />
          <label className="flex w-fit flex-col gap-1 text-[11px] font-medium">Due in (hours, optional)<Input type="number" min={0} step="any" className="h-8 w-24" value={hoursOf(r.dueMinutes)} disabled={readOnly} onChange={(e) => setAt(i, { dueMinutes: minutesOf(e.target.value) })} /></label>
        </div>
      ))}
      {!readOnly && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...rules, { condition: compileFieldCondition({ join: 'and', rules: [{ field: fields.includes('Amount') ? 'Amount' : fields[0] ?? 'Amount', op: 'gt', value: '50000' }] }), approvers: [] }])} data-testid="rule-add"><Plus className="size-3.5" />Add a threshold rule</Button>}
    </div>
  )
}

const KINDS: { kind: ResponseKind; label: string }[] = [
  { kind: 'approve', label: 'approves' }, { kind: 'reject', label: 'rejects' }, { kind: 'info', label: 'asks the requester for more information' }, { kind: 'other', label: 'ends the request with this answer' },
]
export const DEFAULT_RESPONSES: ResponseOption[] = [{ label: 'Approve', kind: 'approve' }, { label: 'Reject', kind: 'reject' }]

/** answers: label, what it does, a comment required */
export function ResponsesEditor({ responses, onChange, readOnly }: { responses: ResponseOption[] | undefined; onChange(next: ResponseOption[] | undefined): void; readOnly?: boolean }) {
  const list = responses?.length ? responses : DEFAULT_RESPONSES
  const emit = (next: ResponseOption[]) => onChange(JSON.stringify(next) === JSON.stringify(DEFAULT_RESPONSES) ? undefined : next)
  return (
    <div className="flex flex-col gap-1.5" data-testid="responses-editor">
      {list.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5" data-testid="response-row">
          <Input className="h-8 w-40" aria-label="Answer" value={r.label} disabled={readOnly} onChange={(e) => emit(list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} data-testid="response-label" />
          <select className={SELECT} aria-label="What it does" value={r.kind} disabled={readOnly} onChange={(e) => emit(list.map((x, j) => (j === i ? { ...x, kind: e.target.value as ResponseKind } : x)))} data-testid="response-kind">
            {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs"><Switch checked={!!r.requireComment} disabled={readOnly} onCheckedChange={(v) => emit(list.map((x, j) => (j === i ? { ...x, ...(v ? { requireComment: true } : { requireComment: undefined }) } : x)).map((x) => { const y = { ...x }; if (!y.requireComment) delete y.requireComment; return y }))} data-testid="response-comment" />comment required</label>
          {!readOnly && <>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Move up" disabled={i === 0} onClick={() => emit(move(list, i, i - 1))}><ArrowUp className="size-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Remove answer" disabled={list.length <= 1} onClick={() => emit(list.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
          </>}
        </div>
      ))}
      {!readOnly && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => emit([...list, { label: list.some((x) => x.kind === 'info') ? 'Rework' : 'Need more info', kind: list.some((x) => x.kind === 'info') ? 'other' : 'info' }])} data-testid="response-add"><Plus className="size-3.5" />Add an answer</Button>}
      {!list.some((r) => r.kind === 'approve') && <span className="text-[11px] text-destructive">At least one answer must approve.</span>}
    </div>
  )
}
