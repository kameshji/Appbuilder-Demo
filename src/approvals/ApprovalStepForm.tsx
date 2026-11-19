/**
 * The configuration form of the flow step `approval` (P1 package C). Self-contained so the visual flow designer (package
 * B) can embed it: it edits the step's own fields (title, details, approvers or a policy, type, answers, fields shown
 * to approvers, due date, reminders, escalation, the record it is about) and reports every change with onChange.
 *
 *   <ApprovalStepForm value={step} onChange={setStep} context={{ tables, tokens, policies }} />
 *
 * Formula fields are plain text (the designer's expression editor may replace them later); `context.tokens` are dynamic
 * content tokens (e.g. "Trigger.Record.Title") offered as one-click inserts. Policies come in `context.policies` (names)
 * when the caller has them. P1-E: approvers, stages, threshold rules, answers and the escalation target are picked
 * visually (DefinitionEditor.tsx; people and teams come from the organisation directory); approvers stay a formula
 * when they come from the record (Trigger.Record.Manager).
 */
import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { APPROVAL_TYPE_DOCS, guessKind, type ApprovalStepConfig, type ApprovalType, type EscalationAction } from '@/platform/approvals'
import { ApproverPicker, ResponsesEditor, RulesEditor, StagesEditor, useApproverDirectory } from './DefinitionEditor'
import { formulaOfRefs, refsOfFormula } from './definitionKit'

export interface ApprovalStepFormContext {
  /** tables of the environment (for "about a record"), with their column names */
  tables?: { name: string; columns: string[] }[]
  /** dynamic content tokens such as "Trigger.Record.Title", "Steps.Get.Output.Amount" */
  tokens?: string[]
  /** names of the approval policies of the environment */
  policies?: string[]
}

export interface ApprovalStepFormProps {
  /** the step's approval fields (other step fields such as id, name, runAfter are passed through untouched) */
  value: ApprovalStepConfig & Record<string, unknown>
  onChange(next: ApprovalStepConfig & Record<string, unknown>): void
  context?: ApprovalStepFormContext
  readOnly?: boolean
}

const ESCALATIONS: { value: EscalationAction | ''; label: string }[] = [
  { value: '', label: 'No escalation' },
  { value: 'manager', label: 'Ask their manager' },
  { value: 'user', label: 'Ask a named person' },
  { value: 'nextStage', label: 'Skip to the next stage' },
  { value: 'approve', label: 'Approve automatically' },
  { value: 'reject', label: 'Reject automatically' },
  { value: 'expire', label: 'Let it expire' },
]

function Row({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

function NativeSelect<T extends string>({ id, value, onChange, options, disabled, testId }: { id?: string; value: T; onChange(v: T): void; options: { value: T; label: string }[]; disabled?: boolean; testId?: string }) {
  return (
    <select
      id={id} value={value} disabled={disabled} data-testid={testId}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/** a formula text field with one-click token inserts */
function FormulaField({ id, value, onChange, tokens, placeholder, multiline, disabled, testId }: { id: string; value: string; onChange(v: string): void; tokens: string[]; placeholder?: string; multiline?: boolean; disabled?: boolean; testId?: string }) {
  const [show, setShow] = useState(false)
  const insert = (t: string) => onChange(value ? `${value} & ${t}` : t)
  return (
    <div className="flex flex-col gap-1">
      {multiline
        ? <Textarea id={id} className="min-h-16 font-mono text-xs" value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        : <Input id={id} className="h-9 font-mono text-xs" value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId} />}
      {tokens.length > 0 && !disabled && (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className="text-[11px] text-primary underline-offset-2 hover:underline" onClick={() => setShow((s) => !s)}>{show ? 'Hide dynamic content' : 'Dynamic content'}</button>
          {show && tokens.slice(0, 40).map((t) => (
            <button key={t} type="button" onClick={() => insert(t)} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent">{t}</button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ApprovalStepForm({ value, onChange, context, readOnly }: ApprovalStepFormProps) {
  const tokens = context?.tokens ?? []
  const tables = context?.tables ?? []
  const policies = context?.policies ?? []
  const set = (patch: Partial<ApprovalStepConfig>) => {
    const next = { ...value, ...patch } as ApprovalStepConfig & Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete next[k]
    onChange(next)
  }
  const dir = useApproverDirectory()
  const approverRefs = refsOfFormula(value.approvers)
  const [approversAsFormula, setApproversAsFormula] = useState(approverRefs === null)
  const type: ApprovalType = value.type ?? 'single'
  const usesPolicy = !!value.policy
  const stages = value.stages ?? []
  const fields = useMemo(() => Object.entries(value.fields ?? {}), [value.fields])
  const fieldNames = useMemo(() => Object.keys(value.fields ?? {}), [value.fields])
  const esc = value.escalation
  const dueHours = value.dueMinutes ? String(Math.round((value.dueMinutes / 60) * 100) / 100) : ''

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="approval-step-form">
      <Row label="Title" hint="What to decide. A formula: text in quotes, joined with &." htmlFor="appr-title">
        <FormulaField id="appr-title" value={String(value.title ?? '')} onChange={(v) => set({ title: v })} tokens={tokens} placeholder={'"Purchase: " & Trigger.Record.Title'} disabled={readOnly} testId="appr-title" />
      </Row>
      <Row label="Details (optional)" hint="Shown to every approver, also those who cannot open the record." htmlFor="appr-details">
        <FormulaField id="appr-details" value={String(value.details ?? '')} onChange={(v) => set({ details: v })} tokens={tokens} multiline disabled={readOnly} testId="appr-details" />
      </Row>

      <Row label="Policy" hint="A reusable approval policy (approvers, stages, thresholds, reminders, escalation). Leave empty to define it here." htmlFor="appr-policy">
        {policies.length ? (
          <NativeSelect id="appr-policy" value={value.policy ?? ''} disabled={readOnly} testId="appr-policy" onChange={(v) => set({ policy: v || undefined })} options={[{ value: '', label: 'None: define it in this step' }, ...policies.map((p) => ({ value: p, label: p }))]} />
        ) : (
          <Input id="appr-policy" className="h-9" value={value.policy ?? ''} placeholder="Policy name (optional)" disabled={readOnly} onChange={(e) => set({ policy: e.target.value || undefined })} data-testid="appr-policy" />
        )}
      </Row>

      <Row label={usesPolicy ? 'Approvers (optional, overrides the policy)' : 'Approvers'} hint={approverRefs !== null && !approversAsFormula ? 'People, roles, teams, departments or the requester\'s manager chain. They keep working when people change jobs.' : 'A formula: emails or user ids, "role:Finance", "team:QA", "manager", "manager-chain:2", "department-head", or a table of people (for example Trigger.Record.Manager).'} htmlFor="appr-approvers">
        {approverRefs !== null && !approversAsFormula ? (
          <>
            <ApproverPicker value={approverRefs} onChange={(refs) => set({ approvers: formulaOfRefs(refs) || undefined })} dir={dir} readOnly={readOnly} testId="appr-approver-picker" />
            {!readOnly && <button type="button" className="w-fit text-[11px] text-primary hover:underline" onClick={() => setApproversAsFormula(true)} data-testid="appr-approvers-formula">Take them from the record or another step (formula)</button>}
          </>
        ) : (
          <>
            <FormulaField id="appr-approvers" value={String(value.approvers ?? '')} onChange={(v) => set({ approvers: v })} tokens={tokens} placeholder={'Trigger.Record.Manager'} disabled={readOnly} testId="appr-approvers" />
            {!readOnly && <button type="button" className="w-fit text-[11px] text-primary hover:underline" onClick={() => { if (approverRefs === null && value.approvers && !window.confirm('Replace the formula with people you pick?')) return; if (approverRefs === null) set({ approvers: undefined }); setApproversAsFormula(false) }} data-testid="appr-approvers-pick">Pick people, roles or managers instead</button>}
          </>
        )}
      </Row>

      {!usesPolicy && (
        <Row label="How they decide" htmlFor="appr-type" hint={APPROVAL_TYPE_DOCS.find((t) => t.type === type)?.summary}>
          <NativeSelect id="appr-type" value={type} disabled={readOnly} testId="appr-type" onChange={(v) => set({ type: v === 'single' ? undefined : v, ...(v === 'sequential' && !stages.length ? { stages: [{ name: 'Stage 1', approvers: approverRefs ?? [] }] } : {}) })} options={APPROVAL_TYPE_DOCS.map((t) => ({ value: t.type, label: t.title }))} />
        </Row>
      )}
      {!usesPolicy && type === 'quorum' && (
        <Row label="How many must approve" htmlFor="appr-quorum">
          <Input id="appr-quorum" type="number" min={1} className="h-9 w-28" value={value.quorum ?? ''} disabled={readOnly} onChange={(e) => set({ quorum: e.target.value ? Number(e.target.value) : undefined })} />
        </Row>
      )}
      {!usesPolicy && type === 'sequential' && (
        <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="appr-stages">
          <div className="text-xs font-medium">Stages, one after another</div>
          <StagesEditor stages={stages} onChange={(st) => set({ stages: st.length ? st : undefined })} dir={dir} fields={fieldNames} readOnly={readOnly} />
          <p className="text-[11px] text-muted-foreground">A stage's condition reads the fields shown to approvers (below), e.g. Amount is more than 10000. A stage's own due date counts from when it starts.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="appr-rules">
        <div className="text-xs font-medium">Threshold rules (optional)</div>
        <p className="text-[11px] text-muted-foreground">When a rule's condition on the fields holds, a stage is added after the others. {usesPolicy ? 'They come after the policy\'s own rules.' : ''}</p>
        <RulesEditor rules={value.rules ?? []} onChange={(r) => set({ rules: r.length ? r : undefined })} dir={dir} fields={fieldNames} readOnly={readOnly} />
      </div>

      <Row label="Answers" hint="What approvers can answer. 'Asks for more information' sends the request back to the requester; 'ends the request' is a custom outcome such as Rework.">
        <ResponsesEditor responses={value.responses ?? (value.options?.length ? value.options.map((l, i) => ({ label: l, kind: guessKind(l, i) })) : undefined)} onChange={(r) => set({ responses: r, options: undefined })} readOnly={readOnly} />
      </Row>

      <div className="flex flex-col gap-2 rounded-md border p-2">
        <div className="text-xs font-medium">Fields shown to approvers</div>
        <p className="text-[11px] text-muted-foreground">Approvers who cannot open the record still see these (and only these). Threshold rules of a policy read them, e.g. Amount.</p>
        {fields.map(([k, f], i) => (
          <div key={i} className="flex items-center gap-2">
            <Input className="h-8 w-32" value={k} placeholder="Label" disabled={readOnly} onChange={(e) => set({ fields: Object.fromEntries(fields.map(([kk, ff], j) => (j === i ? [e.target.value, ff] : [kk, ff]))) })} />
            <Input className="h-8 flex-1 font-mono text-xs" value={f} placeholder="Trigger.Record.Amount" disabled={readOnly} onChange={(e) => set({ fields: Object.fromEntries(fields.map(([kk, ff], j) => (j === i ? [kk, e.target.value] : [kk, ff]))) })} />
            {!readOnly && <Button variant="ghost" size="icon" className="size-8" aria-label="Remove field" onClick={() => { const n = Object.fromEntries(fields.filter((_, j) => j !== i)); set({ fields: Object.keys(n).length ? n : undefined }) }}><Trash2 className="size-3.5" /></Button>}
          </div>
        ))}
        {!readOnly && <Button variant="outline" size="sm" className="w-fit" onClick={() => set({ fields: { ...(value.fields ?? {}), [`Field${fields.length + 1}`]: '' } })}><Plus className="size-3.5" />Add field</Button>}
      </div>

      <Row label="About a record (optional)" hint="Links the request to a record: it shows on the record's timeline, and approvers who may read the record see it.">
        <div className="flex flex-wrap gap-2">
          {tables.length ? (
            <NativeSelect value={value.regarding?.table ?? ''} disabled={readOnly} onChange={(t) => set({ regarding: t ? { table: t, rowId: value.regarding?.rowId ?? 'Trigger.Record' } : undefined })} options={[{ value: '', label: 'No record' }, ...tables.map((t) => ({ value: t.name, label: t.name }))]} />
          ) : (
            <Input className="h-9 w-40" placeholder="Table" value={value.regarding?.table ?? ''} disabled={readOnly} onChange={(e) => set({ regarding: e.target.value ? { table: e.target.value, rowId: value.regarding?.rowId ?? 'Trigger.Record' } : undefined })} />
          )}
          {value.regarding && <Input className="h-9 flex-1 font-mono text-xs" placeholder="Trigger.Record" value={value.regarding.rowId} disabled={readOnly} onChange={(e) => set({ regarding: { table: value.regarding!.table, rowId: e.target.value } })} />}
        </div>
      </Row>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Row label="Due in (hours)" hint="Reminders and escalation count from here." htmlFor="appr-due">
          <Input id="appr-due" type="number" min={0} step="any" className="h-9" value={dueHours} disabled={readOnly} onChange={(e) => set({ dueMinutes: e.target.value ? Math.max(1, Math.round(Number(e.target.value) * 60)) : undefined })} data-testid="appr-due" />
        </Row>
        <Row label="Step timeout (hours)" hint="The flow stops waiting; runAfter timedOut handles it." htmlFor="appr-timeout">
          <Input id="appr-timeout" type="number" min={0} step="any" className="h-9" value={value.timeoutMinutes ? String(Math.round((value.timeoutMinutes / 60) * 100) / 100) : ''} disabled={readOnly} onChange={(e) => set({ timeoutMinutes: e.target.value ? Math.max(1, Math.round(Number(e.target.value) * 60)) : undefined })} />
        </Row>
        <Row label="Remind after (hours)" htmlFor="appr-remind">
          <Input id="appr-remind" type="number" min={0} step="any" className="h-9" value={value.reminders ? String(Math.round((value.reminders.afterMinutes / 60) * 100) / 100) : ''} disabled={readOnly} onChange={(e) => set({ reminders: e.target.value ? { ...(value.reminders ?? {}), afterMinutes: Math.max(1, Math.round(Number(e.target.value) * 60)) } : undefined })} />
        </Row>
        <Row label="Then every (hours)" htmlFor="appr-remind-every">
          <Input id="appr-remind-every" type="number" min={0} step="any" className="h-9" value={value.reminders?.everyMinutes ? String(Math.round((value.reminders.everyMinutes / 60) * 100) / 100) : ''} disabled={readOnly || !value.reminders} onChange={(e) => value.reminders && set({ reminders: { ...value.reminders, everyMinutes: e.target.value ? Math.max(5, Math.round(Number(e.target.value) * 60)) : undefined } })} />
        </Row>
        <Row label="When it is overdue" htmlFor="appr-esc">
          <NativeSelect id="appr-esc" value={esc?.action ?? ''} disabled={readOnly} testId="appr-escalation" onChange={(a) => set({ escalation: a ? { ...(esc ?? {}), action: a } : undefined })} options={ESCALATIONS} />
        </Row>
        {esc && (
          <Row label="Escalate after the due date (hours)" htmlFor="appr-esc-after">
            <Input id="appr-esc-after" type="number" min={0} step="any" className="h-9" value={esc.afterMinutes ? String(Math.round((esc.afterMinutes / 60) * 100) / 100) : ''} disabled={readOnly} onChange={(e) => set({ escalation: { ...esc, afterMinutes: e.target.value ? Math.max(0, Math.round(Number(e.target.value) * 60)) : undefined } })} />
          </Row>
        )}
        {esc?.action === 'user' && (
          <Row label="Escalate to">
            <ApproverPicker value={esc.to ? [esc.to] : []} onChange={(a) => set({ escalation: { ...esc, to: a[0] } })} dir={dir} readOnly={readOnly} single testId="appr-escalate-to" />
          </Row>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-xs"><Switch checked={!!value.requireCommentOnReject} disabled={readOnly} onCheckedChange={(v) => set({ requireCommentOnReject: v || undefined })} />A comment is required to reject</label>
        <label className="flex items-center gap-2 text-xs"><Switch checked={!!value.separationOfDuties} disabled={readOnly} onCheckedChange={(v) => set({ separationOfDuties: v || undefined })} />The same person cannot approve two stages in a row</label>
        <label className="flex items-center gap-2 text-xs"><Switch checked={!!value.allowSelfApproval} disabled={readOnly} onCheckedChange={(v) => set({ allowSelfApproval: v || undefined })} />The requester may approve their own request</label>
      </div>
    </div>
  )
}

export default ApprovalStepForm
