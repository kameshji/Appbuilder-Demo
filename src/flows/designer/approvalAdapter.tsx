/**
 * The approval step's configuration comes from package C (`ApprovalStepForm` in src/approvals/). This adapter finds it at
 * build time without a hard import, so the designer builds with or without that package: when it is there it is
 * rendered with the step, the tables and the dynamic content tokens; otherwise a placeholder edits the core fields
 * (title, details, approvers, type, answers, the record it is about) with the designer's own fields.
 */
import type { ComponentType } from 'react'
import type { Step } from '@/platform/flows'
import { FxField } from './FxField'
import { PeoplePicker, Labeled, inputCls } from './fields'
import { useDesignerData, useTokens } from './context'
import { useDesigner } from './store'

interface ExternalProps {
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  context?: { tables?: { name: string; columns: string[] }[]; tokens?: string[]; policies?: string[] }
  readOnly?: boolean
}

const found = import.meta.glob<{ ApprovalStepForm?: ComponentType<ExternalProps>; default?: ComponentType<ExternalProps> }>('../../approvals/ApprovalStepForm.tsx', { eager: true })
const External: ComponentType<ExternalProps> | null = Object.values(found).map((m) => m.ApprovalStepForm ?? m.default ?? null).find(Boolean) ?? null

export const hasApprovalForm = (): boolean => !!External

const FIELDS = ['title', 'details', 'approvers', 'type', 'options', 'regarding']

export function ApprovalConfig({ step, onChange }: { step: Step; onChange(s: Step): void }) {
  const data = useDesignerData()
  const tokens = useTokens(step.id)
  const ro = useDesigner((s) => s.readOnly)
  const a = step as Step & Record<string, unknown>
  if (External) {
    return (
      <div className="px-4 py-3" data-testid="approval-form-external">
        <External
          value={a} readOnly={ro}
          context={{ tables: data.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })), tokens: tokens.map((t) => t.insert) }}
          onChange={(next) => onChange({ ...a, ...next, id: step.id, name: step.name, kind: 'approval' } as unknown as Step)}
        />
      </div>
    )
  }
  const set = (k: string, v: unknown) => {
    const n = { ...a }
    if (v === '' || v === undefined) delete n[k]
    else n[k] = v
    onChange(n as Step)
  }
  const regarding = (a.regarding ?? null) as { table: string; rowId: string } | null
  return (
    <div className="grid gap-3 px-4 py-3" data-testid="approval-form-placeholder">
      <p className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-2 text-[11px] text-amber-800 dark:text-amber-300">
        The full approval settings (policies, stages, reminders, escalation) come with the approvals module. Here: the core fields. Other fields of this step are kept as they are: {Object.keys(a).filter((k) => !['id', 'name', 'kind', 'description', 'runAfter', 'retry', 'timeoutMinutes', ...FIELDS].includes(k)).join(', ') || 'none'}.
      </p>
      <FxField stepId={step.id} field="title" label="Title" required value={a.title as string} onChange={(v) => set('title', v)} testId="approval-title" />
      <FxField stepId={step.id} field="details" label="Details" value={a.details as string} onChange={(v) => set('details', v)} multiline testId="approval-details" />
      <PeoplePicker stepId={step.id} field="approvers" label="Approvers" required value={a.approvers as string} onChange={(v) => set('approvers', v)} testId="approval-approvers" />
      <Labeled label="Who must answer">
        <select className={inputCls} value={(a.type as string) ?? 'single'} disabled={ro} onChange={(e) => set('type', e.target.value === 'single' ? undefined : e.target.value)} data-testid="approval-type">
          <option value="single">One person (the first answer counts)</option>
          <option value="any">Anyone of them</option>
          <option value="all">Everyone</option>
          <option value="sequential">One after another</option>
        </select>
      </Labeled>
      <Labeled label="Answers" hint="Comma-separated; default Approve, Reject.">
        <input className={inputCls} value={((a.options as string[]) ?? []).join(', ')} readOnly={ro} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set('options', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).length ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : undefined)} data-testid="approval-options" />
      </Labeled>
      <Labeled label="About a record" hint="Shows the approval on the record's timeline.">
        <select className={inputCls} value={regarding?.table ?? ''} disabled={ro} onChange={(e) => set('regarding', e.target.value ? { table: e.target.value, rowId: regarding?.rowId ?? 'Trigger.Record' } : undefined)} data-testid="approval-regarding-table">
          <option value="">(none)</option>
          {data.tables.map((t) => <option key={t.id} value={t.name}>{t.displayName}</option>)}
        </select>
      </Labeled>
      {regarding && <FxField stepId={step.id} field="regarding.rowId" label="The row" value={regarding.rowId} onChange={(v) => set('regarding', { ...regarding, rowId: v })} formulaOnly />}
    </div>
  )
}
