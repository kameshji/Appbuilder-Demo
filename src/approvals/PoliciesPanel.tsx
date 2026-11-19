/**
 * Approval policies (makers) and the approval settings (administrators) on the Approvals page (P1 package C). A policy is
 * a reusable definition: who decides and how (type, approvers, stages, threshold rules), the answers, due date,
 * reminders, escalation and the rules (self-approval, separation of duties, bulk answers). P1-E: approvers, stages,
 * threshold rules and answers are edited visually (DefinitionEditor.tsx); "Advanced" shows the same definition as JSON
 * for experts, in sync.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { usePlatform } from '@/platform'
import { APPROVAL_TYPE_DOCS, ESCALATION_DOCS, definitionProblems, type ApprovalDefinition, type ApprovalPolicy, type ApprovalSettings, type ApprovalType, type EscalationAction } from '@/platform/approvals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { errMsg, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { approvalsApi } from './api'
import { ApproverPicker, ResponsesEditor, RulesEditor, StagesEditor, useApproverDirectory } from './DefinitionEditor'

const blank = (): ApprovalPolicy => ({ id: '', name: '', definition: { type: 'single', approvers: ['manager'] } })

function PolicyEditor({ value, onSaved, onCancel }: { value: ApprovalPolicy; onSaved(): void; onCancel(): void }) {
  const { toast } = useToast()
  const dir = useApproverDirectory()
  const [p, setP] = useState<ApprovalPolicy>(value)
  const d = p.definition
  const [showJson, setShowJson] = useState(false)
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldNames, setFieldNames] = useState(() => [...new Set(['Amount', ...[...(d.stages ?? []).map((x) => x.condition ?? ''), ...(d.rules ?? []).map((x) => x.condition)].flatMap((c) => [...c.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1])).filter((n) => !['IsBlank', 'StartsWith'].includes(n))])].join(', '))
  const fields = fieldNames.split(',').map((x) => x.trim()).filter(Boolean)
  const set = (patch: Partial<ApprovalDefinition>) => {
    const next = { ...d, ...patch } as ApprovalDefinition & Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) if (v === undefined || (Array.isArray(v) && !v.length && k !== 'approvers')) delete next[k]
    setP({ ...p, definition: next })
  }
  const problems = definitionProblems(d)
  const save = async () => {
    setBusy(true)
    try {
      await approvalsApi.savePolicy({ ...p, ...(p.id ? {} : { id: undefined }), definition: d })
      toast('Policy saved.', 'success')
      onSaved()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3" data-testid="policy-editor">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">Name<Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} data-testid="policy-name" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">How they decide
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.type} onChange={(e) => {
            const t = e.target.value as ApprovalType
            set({ type: t, ...(t === 'sequential' && !d.stages?.length ? { stages: [{ name: 'Stage 1', approvers: d.approvers ?? [] }] } : {}), ...(t !== 'quorum' ? { quorum: undefined } : { quorum: d.quorum ?? 2 }) })
          }} data-testid="policy-type">
            {APPROVAL_TYPE_DOCS.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">Description<Input value={p.description ?? ''} onChange={(e) => setP({ ...p, description: e.target.value })} /></label>
      </div>
      {d.type !== 'sequential' && (
        <div className="flex flex-col gap-1 text-xs font-medium">Approvers
          <ApproverPicker value={d.approvers ?? []} onChange={(a) => set({ approvers: a })} dir={dir} testId="policy-approvers" />
        </div>
      )}
      {d.type === 'quorum' && <label className="flex w-fit flex-col gap-1 text-xs font-medium">How many must approve<Input type="number" min={1} className="w-24" value={d.quorum ?? ''} onChange={(e) => set({ quorum: e.target.value ? Number(e.target.value) : undefined })} data-testid="policy-quorum" /></label>}
      {d.type === 'sequential' && (
        <div className="flex flex-col gap-1 text-xs font-medium">Stages, one after another
          <StagesEditor stages={d.stages ?? []} onChange={(st) => set({ stages: st })} dir={dir} fields={fields} />
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs font-medium">Threshold rules <span className="font-normal text-muted-foreground">Each rule whose condition holds adds a stage after the others (e.g. when Amount is more than 50000, also ask the manager chain until the CEO).</span>
        <RulesEditor rules={d.rules ?? []} onChange={(r) => set({ rules: r })} dir={dir} fields={fields} />
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">Fields the conditions read <span className="font-normal text-muted-foreground">The fields a flow step or app declares, comma-separated (offered in the condition builders).</span>
        <Input className="h-8" value={fieldNames} onChange={(e) => setFieldNames(e.target.value)} data-testid="policy-fields" />
      </label>
      <div className="flex flex-col gap-1 text-xs font-medium">Answers
        <ResponsesEditor responses={d.responses} onChange={(r) => set({ responses: r })} />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium">Due in (hours)<Input type="number" min={0} step="any" value={d.dueMinutes ? d.dueMinutes / 60 : ''} onChange={(e) => set({ dueMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : undefined })} data-testid="policy-due" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">Remind after (hours)<Input type="number" min={0} step="any" value={d.reminders ? d.reminders.afterMinutes / 60 : ''} onChange={(e) => set({ reminders: e.target.value ? { ...(d.reminders ?? {}), afterMinutes: Math.round(Number(e.target.value) * 60) } : undefined })} data-testid="policy-remind" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">Then every (hours)<Input type="number" min={0} step="any" disabled={!d.reminders} value={d.reminders?.everyMinutes ? d.reminders.everyMinutes / 60 : ''} onChange={(e) => d.reminders && set({ reminders: { ...d.reminders, everyMinutes: e.target.value ? Math.max(5, Math.round(Number(e.target.value) * 60)) : undefined } })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">When overdue
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.escalation?.action ?? ''} onChange={(e) => set({ escalation: e.target.value ? { ...(d.escalation ?? {}), action: e.target.value as EscalationAction } : undefined })} data-testid="policy-escalation">
            <option value="">Nothing</option>
            {ESCALATION_DOCS.map((x) => <option key={x.action} value={x.action}>{ESCALATION_LABEL[x.action]}</option>)}
          </select>
        </label>
        {d.escalation && <label className="flex flex-col gap-1 text-xs font-medium">Escalate after the due date (hours)<Input type="number" min={0} step="any" value={d.escalation.afterMinutes ? d.escalation.afterMinutes / 60 : ''} onChange={(e) => set({ escalation: { ...d.escalation!, afterMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : undefined } })} /></label>}
        {d.escalation?.action === 'user' && <div className="flex flex-col gap-1 text-xs font-medium">Escalate to<ApproverPicker value={d.escalation.to ? [d.escalation.to] : []} onChange={(a) => set({ escalation: { ...d.escalation!, to: a[0] } })} dir={dir} single testId="policy-escalate-to" /></div>}
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        <label className="flex items-center gap-2"><Switch checked={!!d.requireCommentOnReject} onCheckedChange={(v) => set({ requireCommentOnReject: v || undefined })} />A comment is required to reject</label>
        <label className="flex items-center gap-2"><Switch checked={!!d.separationOfDuties} onCheckedChange={(v) => set({ separationOfDuties: v || undefined })} />Separation of duties: nobody approves two stages in a row</label>
        <label className="flex items-center gap-2"><Switch checked={!!d.allowSelfApproval} onCheckedChange={(v) => set({ allowSelfApproval: v || undefined })} />The requester may approve their own request</label>
        <label className="flex items-center gap-2"><Switch checked={d.allowBulk !== false} onCheckedChange={(v) => set({ allowBulk: v ? undefined : false })} />Approvers may answer several of these at once</label>
        {d.type === 'all' && <label className="flex items-center gap-2"><Switch checked={d.rejectOnFirst !== false} onCheckedChange={(v) => set({ rejectOnFirst: v ? undefined : false })} />The first rejection rejects at once</label>}
      </div>
      {problems.length > 0 && <ul className="list-disc pl-5 text-xs text-destructive" data-testid="policy-problems">{problems.map((x, i) => <li key={i}>{x.message}</li>)}</ul>}
      <div className="flex flex-col gap-1">
        <button type="button" className="w-fit text-xs text-primary hover:underline" onClick={() => { setShowJson((x) => !x); setJson(JSON.stringify(d, null, 2)); setJsonError('') }} data-testid="policy-json-toggle">{showJson ? 'Hide the definition (JSON)' : 'Advanced: the definition as JSON'}</button>
        {showJson && <>
          <Textarea className="min-h-32 font-mono text-[11px]" value={json} onChange={(e) => {
            setJson(e.target.value)
            try { const v = JSON.parse(e.target.value) as ApprovalDefinition; setP({ ...p, definition: v }); setJsonError('') } catch { setJsonError('Not valid JSON yet; the editor above keeps the last valid definition.') }
          }} data-testid="policy-advanced" />
          {jsonError && <span className="text-xs text-destructive">{jsonError}</span>}
        </>}
      </div>
      <div className="flex gap-2">
        <Button disabled={busy || !p.name.trim() || problems.length > 0} onClick={() => void save()} data-testid="policy-save">{busy ? <Loader2 className="animate-spin" /> : <Save />}Save</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

const ESCALATION_LABEL: Record<EscalationAction, string> = { manager: 'Ask the manager of whoever has not answered', user: 'Ask a named person', nextStage: 'Skip to the next stage', approve: 'Approve automatically', reject: 'Reject automatically', expire: 'Let it expire' }

function SettingsBox() {
  const { toast } = useToast()
  const roles = usePlatform((s) => s.roles)
  const [st, setSt] = useState<ApprovalSettings | null>(null)
  useEffect(() => { approvalsApi.settings().then((r) => setSt(r.settings)).catch((e) => toast(errMsg(e), 'error')) }, [toast])
  if (!st) return null
  const save = async (next: ApprovalSettings) => {
    try {
      setSt((await approvalsApi.saveSettings(next)).settings)
      toast('Approval settings saved.', 'success')
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3" data-testid="approval-settings">
      <div className="text-sm font-medium">Settings of this environment</div>
      <div className="text-xs text-muted-foreground">"Approvals: view": people with these roles see every approval request about records they can read (not only their own).</div>
      <div className="flex flex-wrap gap-3">
        {roles.filter((r) => !r.isAdmin).map((r) => (
          <label key={r.id} className="flex items-center gap-1.5 text-sm"><Checkbox checked={st.viewerRoles.includes(r.id)} onCheckedChange={(v) => void save({ ...st, viewerRoles: v ? [...st.viewerRoles, r.id] : st.viewerRoles.filter((x) => x !== r.id) })} />{r.name}</label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">Keep decided requests (days; 0: forever)<Input type="number" min={0} defaultValue={st.retentionDays} onBlur={(e) => void save({ ...st, retentionDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">Email answer links stay valid (hours)<Input type="number" min={1} max={720} defaultValue={st.linkHours} onBlur={(e) => void save({ ...st, linkHours: Math.max(1, Math.min(720, Math.round(Number(e.target.value) || 72))) })} /></label>
      </div>
    </div>
  )
}

export function PoliciesPanel() {
  const { toast } = useToast()
  const caps = useCaps()
  const [items, setItems] = useState<ApprovalPolicy[] | null>(null)
  const [editing, setEditing] = useState<ApprovalPolicy | null>(null)
  const load = useCallback(() => { approvalsApi.policies().then((r) => setItems(r.items)).catch((e) => toast(errMsg(e), 'error')) }, [toast])
  useEffect(() => load(), [load])
  return (
    <div className="flex flex-col gap-4" data-testid="approval-policies">
      {caps.isAdmin && <SettingsBox />}
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">Policies</div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(blank())} data-testid="policy-new"><Plus />New policy</Button>
      </div>
      {editing && <PolicyEditor key={editing.id || 'new'} value={editing} onSaved={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} />}
      {items === null ? <Loader2 className="size-4 animate-spin" /> : items.length === 0 ? <p className="text-sm text-muted-foreground">No policies yet. Flows and apps can also name approvers directly.</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm" data-testid="policy-row">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(p)}>
                <div className="font-medium">{p.name}</div>
                <div className="truncate text-xs text-muted-foreground">{APPROVAL_TYPE_DOCS.find((t) => t.type === p.definition.type)?.title}{p.definition.approvers?.length ? `: ${p.definition.approvers.join(', ')}` : ''}{p.definition.stages?.length ? `: ${p.definition.stages.length} stages` : ''}{p.definition.rules?.length ? ` + ${p.definition.rules.length} rules` : ''}{p.solutionId ? ' · from a solution' : ''}</div>
              </button>
              <Button variant="ghost" size="icon" aria-label={`Delete ${p.name}`} onClick={async () => { if (!window.confirm(`Delete the policy "${p.name}"? Open requests keep their copy.`)) return; try { await approvalsApi.deletePolicy(p.id); load() } catch (e) { toast(errMsg(e), 'error') } }}><Trash2 className="size-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
