/**
 * The "Approvals" panel UI component (P1 package C): the approval requests about one record that the signed-in user may
 * see (status, who is asked or who decided), with the answer buttons when the request waits for them and "Request
 * approval" (with a policy or approvers set on the component). Server mode; a sample in the Studio and in demo mode.
 * Outputs: Count (requests shown), Pending (open ones), LastOutcome (the newest decided request's outcome).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, ExternalLink, Loader2, Plus } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { usePlatform } from '@/platform'
import type { ApprovalDetail, ApprovalRequestInfo, ResponseOption } from '@/platform/approvals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { toBool, toText } from '@/controls/util'
import { recordIdOf } from '@/controls/display/people'
import { approvalsApi } from './api'
import { StatusBadge } from './StatusBadge'

const SAMPLE: ApprovalRequestInfo[] = [
  { id: 's1', title: 'Purchase: 20 laptops', details: '', fields: {}, requestedBy: null, requestedByName: 'Raj Patel', type: 'single', status: 'pending', currentStage: 0, source: 'flow', createdOn: new Date(Date.now() - 3600_000).toISOString(), responses: [{ label: 'Approve', kind: 'approve' }, { label: 'Reject', kind: 'reject' }], allowBulk: true, requireCommentOnReject: false, canDecide: true },
  { id: 's2', title: 'Price change', details: '', fields: {}, requestedBy: null, requestedByName: 'Asha Rao', type: 'single', status: 'approved', outcome: 'Approve', currentStage: 0, source: 'app', createdOn: new Date(Date.now() - 86_400_000).toISOString(), responses: [], allowBulk: true, requireCommentOnReject: false },
]

function Row({ r, run, onDone }: { r: ApprovalRequestInfo; run: boolean; onDone(): void }) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [who, setWho] = useState<string>('')
  useEffect(() => {
    if (!run) return
    approvalsApi.get(r.id).then((x: { request: ApprovalDetail }) => {
      const d = x.request
      const pending = d.assignments.filter((a) => a.status === 'pending').map((a) => a.userName ?? a.userId)
      const decided = d.assignments.filter((a) => a.status === 'responded').map((a) => `${a.userName ?? a.userId}: ${a.response}`)
      setWho(pending.length && (d.status === 'pending' || d.status === 'info') ? `Waiting for ${pending.join(', ')}` : decided.join('; '))
    }).catch(() => setWho(''))
  }, [r.id, r.status, run])
  const answer = async (o: ResponseOption) => {
    if ((o.requireComment || o.kind === 'info') && !comment.trim()) {
      setError(`A comment is required with "${o.label}".`)
      return
    }
    setBusy(true)
    setError('')
    try {
      await approvalsApi.respond(r.id, o.label, comment.trim() || undefined)
      setComment('')
      onDone()
      window.dispatchEvent(new CustomEvent('appbuilder:approvals-changed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2 last:border-0" data-testid="approvals-panel-row">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{r.title}</span>
        <StatusBadge status={r.status} outcome={r.outcome} />
        {run && <a href={`#u-approvals?id=${encodeURIComponent(r.id)}`} aria-label="Open in Approvals" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
      </div>
      <div className="text-xs text-muted-foreground">{r.requestedByName ? `From ${r.requestedByName}` : ''}{who ? ` · ${who}` : ''}</div>
      {r.canDecide && (
        <div className="flex flex-col gap-1.5">
          <Input className="h-8 text-xs" placeholder="Comment" value={comment} disabled={!run} onChange={(e) => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            {r.responses.map((o) => (
              <Button key={o.label} size="sm" disabled={!run || busy} variant={o.kind === 'approve' || o.kind === 'reject' ? 'default' : 'outline'} data-testid={`approvals-panel-${o.label}`}
                className={cn(o.kind === 'approve' && 'bg-emerald-600 text-white hover:bg-emerald-700', o.kind === 'reject' && 'bg-rose-600 text-white hover:bg-rose-700')} onClick={() => void answer(o)}>
                {o.label}
              </Button>
            ))}
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </li>
  )
}

function ApprovalsPanelRender({ props, mode, setOutput }: ControlRenderProps) {
  const platformMode = usePlatform((s) => s.mode)
  const run = mode === 'run' && platformMode === 'server'
  const rowId = recordIdOf(props.Record)
  const table = toText(props.Table)
  const [items, setItems] = useState<ApprovalRequestInfo[] | null>(null)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const [title, setTitle] = useState('')
  const load = useCallback(() => {
    if (!run || !rowId) return
    // the table is optional: the server finds the record's table from its id
    const go = table ? approvalsApi.forRecord(table, rowId) : approvalsApi.list({ view: 'involved', regarding: rowId, status: '' })
    go.then((r) => { setItems(r.items); setError('') }).catch((e) => {
      setItems([])
      // a record that was just added may not be stored yet: no error, the next reload shows it
      if ((e as { status?: number }).status === 404) setError('')
      else setError(e instanceof Error ? e.message : String(e))
    })
  }, [run, rowId, table])
  useEffect(() => load(), [load])
  useEffect(() => {
    if (!run) return
    const t = setInterval(load, 30_000)
    // a RequestApproval in this app (or an answer here) changed something: reload
    const on = () => load()
    window.addEventListener('appbuilder:approvals-changed', on)
    return () => { clearInterval(t); window.removeEventListener('appbuilder:approvals-changed', on) }
  }, [run, load])
  const list = useMemo(() => (run ? items ?? [] : SAMPLE), [run, items])
  useEffect(() => {
    if (!run) return
    setOutput('Count', list.length)
    setOutput('Pending', list.filter((x) => x.status === 'pending' || x.status === 'info').length)
    setOutput('LastOutcome', list.find((x) => x.outcome)?.outcome ?? '')
  }, [run, list, setOutput])
  const policy = toText(props.Policy).trim()
  const approvers = toText(props.Approvers).trim()
  const canAsk = toBool(props.ShowRequest, true) && (!!policy || !!approvers)
  const ask = async () => {
    if (!title.trim()) return
    try {
      await approvalsApi.create({ ...(policy ? { policy } : { approvers }), title: title.trim(), regarding: { ...(table ? { table } : {}), rowId }, source: 'app' })
      setTitle('')
      setAsking(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground" data-testid="approvals-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ClipboardCheck className="size-4 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{toText(props.Title) || 'Approvals'}</span>
        {canAsk && <Button size="sm" variant="ghost" className="ml-auto h-7" disabled={!run || !rowId} onClick={() => setAsking((x) => !x)} data-testid="approvals-panel-request"><Plus className="size-3.5" />Request approval</Button>}
      </div>
      {asking && (
        <div className="flex gap-2 border-b p-2">
          <Input className="h-8" placeholder="What should be approved?" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void ask()} />
          <Button size="sm" disabled={!title.trim()} onClick={() => void ask()}>Ask</Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {run && !rowId ? <div className="p-4 text-center text-sm text-muted-foreground">Choose a record to see its approvals.</div>
          : run && items === null ? <div className="flex justify-center p-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
            : error ? <div className="p-3 text-xs text-destructive">{error}</div>
              : list.length === 0 ? <div className="p-4 text-center text-sm text-muted-foreground">No approvals for this record.</div>
                : <ul>{list.map((r) => <Row key={r.id} r={r} run={run} onDone={load} />)}</ul>}
      </div>
    </div>
  )
}

export const ApprovalsPanel: ControlType = {
  type: 'ApprovalsPanel',
  label: 'Approvals panel',
  icon: ClipboardCheck,
  category: 'Data',
  props: [
    { name: 'Record', kind: 'record', group: 'Data', default: '=Blank()' },
    { name: 'Table', kind: 'text', group: 'Data', default: '=""', simple: false },
    { name: 'Title', kind: 'text', group: 'Content', default: '="Approvals"' },
    { name: 'Policy', kind: 'text', group: 'Behaviour', default: '=""' },
    { name: 'Approvers', kind: 'text', group: 'Behaviour', default: '=""' },
    { name: 'ShowRequest', label: 'Show "Request approval"', kind: 'boolean', group: 'Behaviour', default: '=true' },
  ],
  outputs: [{ name: 'Count', initial: 0 }, { name: 'Pending', initial: 0 }, { name: 'LastOutcome', initial: '' }],
  defaultSize: { width: 380, height: 360 },
  primaryProp: 'Record',
  render: ApprovalsPanelRender,
}
