/**
 * Approval policies (makers) and the approval settings (administrators) on the Approvals page (P1 package C). A policy is
 * a reusable definition: who decides and how (type, approvers, stages, threshold rules), the answers, due date,
 * reminders, escalation and the rules (self-approval, separation of duties, bulk answers). Stages, rules and answers are
 * edited as JSON under "Advanced" (the shape is in docs/guide/maker/approvals.md).
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { usePlatform } from '@/platform'
import { APPROVAL_TYPE_DOCS, ESCALATION_DOCS, type ApprovalDefinition, type ApprovalPolicy, type ApprovalSettings, type ApprovalType, type EscalationAction } from '@/platform/approvals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { errMsg, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { approvalsApi } from './api'

const blank = (): ApprovalPolicy => ({ id: '', name: '', definition: { type: 'single', approvers: ['manager'] } })

function PolicyEditor({ value, onSaved, onCancel }: { value: ApprovalPolicy; onSaved(): void; onCancel(): void }) {
  const { toast } = useToast()
  const [p, setP] = useState<ApprovalPolicy>(value)
  const d = p.definition
  const [advanced, setAdvanced] = useState(() => JSON.stringify({ stages: d.stages, rules: d.rules, responses: d.responses }, null, 2))
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ApprovalDefinition>) => setP({ ...p, definition: { ...d, ...patch } })
  const save = async () => {
    let extra: Partial<ApprovalDefinition> = {}
    try {
      extra = JSON.parse(advanced || '{}') as Partial<ApprovalDefinition>
    } catch {
      toast('Advanced is not valid JSON.', 'error')
      return
    }
    const def: ApprovalDefinition = { ...d }
    for (const k of ['stages', 'rules', 'responses'] as const) {
      if (extra[k] === undefined || (Array.isArray(extra[k]) && !(extra[k] as unknown[]).length)) delete def[k]
      else (def as unknown as Record<string, unknown>)[k] = extra[k]
    }
    setBusy(true)
    try {
      await approvalsApi.savePolicy({ ...p, ...(p.id ? {} : { id: undefined }), definition: def })
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
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.type} onChange={(e) => set({ type: e.target.value as ApprovalType })}>
            {APPROVAL_TYPE_DOCS.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">Description<Input value={p.description ?? ''} onChange={(e) => setP({ ...p, description: e.target.value })} /></label>
        {d.type !== 'sequential' && (
          <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">Approvers (one per line: email, role:Finance, team:QA, manager, manager-chain:2, department-head ...)
            <Textarea className="min-h-16 font-mono text-xs" value={(d.approvers ?? []).join('\n')} onChange={(e) => set({ approvers: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} data-testid="policy-approvers" />
          </label>
        )}
        {d.type === 'quorum' && <label className="flex flex-col gap-1 text-xs font-medium">How many must approve<Input type="number" min={1} value={d.quorum ?? ''} onChange={(e) => set({ quorum: e.target.value ? Number(e.target.value) : undefined })} /></label>}
        <label className="flex flex-col gap-1 text-xs font-medium">Due in (hours)<Input type="number" min={0} step="any" value={d.dueMinutes ? d.dueMinutes / 60 : ''} onChange={(e) => set({ dueMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : undefined })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">Remind after (hours)<Input type="number" min={0} step="any" value={d.reminders ? d.reminders.afterMinutes / 60 : ''} onChange={(e) => set({ reminders: e.target.value ? { ...(d.reminders ?? {}), afterMinutes: Math.round(Number(e.target.value) * 60) } : undefined })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium">When overdue
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={d.escalation?.action ?? ''} onChange={(e) => set({ escalation: e.target.value ? { ...(d.escalation ?? {}), action: e.target.value as EscalationAction } : undefined })}>
            <option value="">Nothing</option>
            {ESCALATION_DOCS.map((x) => <option key={x.action} value={x.action}>{x.action}: {x.summary}</option>)}
          </select>
        </label>
        {d.escalation?.action === 'user' && <label className="flex flex-col gap-1 text-xs font-medium">Escalate to (email)<Input value={d.escalation.to ?? ''} onChange={(e) => set({ escalation: { ...d.escalation!, to: e.target.value } })} /></label>}
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        <label className="flex items-center gap-2"><Switch checked={!!d.requireCommentOnReject} onCheckedChange={(v) => set({ requireCommentOnReject: v || undefined })} />A comment is required to reject</label>
        <label className="flex items-center gap-2"><Switch checked={!!d.separationOfDuties} onCheckedChange={(v) => set({ separationOfDuties: v || undefined })} />Separation of duties: nobody approves two stages in a row</label>
        <label className="flex items-center gap-2"><Switch checked={!!d.allowSelfApproval} onCheckedChange={(v) => set({ allowSelfApproval: v || undefined })} />The requester may approve their own request</label>
        <label className="flex items-center gap-2"><Switch checked={d.allowBulk !== false} onCheckedChange={(v) => set({ allowBulk: v ? undefined : false })} />Approvers may answer several of these at once</label>
        {d.type === 'all' && <label className="flex items-center gap-2"><Switch checked={d.rejectOnFirst !== false} onCheckedChange={(v) => set({ rejectOnFirst: v ? undefined : false })} />The first rejection rejects at once</label>}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">Advanced: stages, threshold rules, answers (JSON)
        <Textarea className="min-h-32 font-mono text-[11px]" value={advanced} onChange={(e) => setAdvanced(e.target.value)} data-testid="policy-advanced" />
        <span className="font-normal text-muted-foreground">{'stages: [{ "name": "Manager", "approvers": ["manager"] }, { "name": "Finance", "approvers": ["role:Finance"], "mode": "any", "condition": "Amount > 10000" }]; rules: [{ "condition": "Amount > 50000", "approvers": ["manager-chain-until-title:CEO"] }]; responses: [{ "label": "Approve", "kind": "approve" }, { "label": "Need more info", "kind": "info" }]'}</span>
      </label>
      <div className="flex gap-2">
        <Button disabled={busy || !p.name.trim()} onClick={() => void save()} data-testid="policy-save">{busy ? <Loader2 className="animate-spin" /> : <Save />}Save</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

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
