/**
 * The Approvals page (User mode, #u-approvals; P1 package C). Tabs: "To approve" (bulk answers with one comment when the
 * policy allows), "Sent by me", "All" (administrators), "Delegations" (out of office), "Policies" (makers). A request
 * opens in a detail view: what the requester included, the record as the signed-in person may read it (or a notice
 * that only the included details are shown), the answer buttons with their comment rules, "need more info", reassign,
 * cancel, the stages and people asked, the history, comments and files.
 *
 * Email answer links land here as #u-approvals?link=<token>: the page shows a confirmation (nothing is decided by
 * opening a link); the answer is a POST with the session and the CSRF header. Works at phone width: the list and the
 * detail are one column with a back button below the md breakpoint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Check, CheckCircle2, ClipboardCheck, Clock, FileText, Info, Loader2, MessageSquare, Paperclip, RefreshCw, Search, Send, ShieldAlert, Undo2, UserRoundCog, X,
} from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { ApprovalDetail, ApprovalRequestInfo, DelegationInfo, ResponseOption } from '@/platform/approvals'
import type { TimelineItem } from '@/platform/collab-api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { sanitizeRichText } from '@/platform/system-tables'
import { Empty, ErrorReference, PageHeader, Segmented, errMsg, fmtDate, fmtRelative, referenceFor, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { approvalsApi, type ApprovalView, type LinkInspect } from './api'
import { PoliciesPanel } from './PoliciesPanel'
import { StatusBadge } from './StatusBadge'

export { StatusBadge }

type Tab = ApprovalView | 'delegations' | 'policies'

function hashParams(): URLSearchParams {
  const i = location.hash.indexOf('?')
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : '')
}
function setHashParam(k: string, v: string | null) {
  const p = hashParams()
  if (v === null) p.delete(k)
  else p.set(k, v)
  for (const x of ['link']) if (x !== k && v !== null) p.delete(x)
  const q = p.toString()
  const next = `#u-approvals${q ? `?${q}` : ''}`
  if (location.hash !== next) history.replaceState(null, '', next)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

const fmtValue = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '-'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDate(v)
  return String(v)
}

/* ------------------------------------------------------------------ answer box */

function AnswerBox({ req, onDone }: { req: ApprovalDetail | ApprovalRequestInfo; onDone(): void }) {
  const { toast } = useToast()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const needsComment = (r: ResponseOption) => !!r.requireComment || r.kind === 'info'
  const answer = async (r: ResponseOption) => {
    if (needsComment(r) && !comment.trim()) {
      setError(r.kind === 'info' ? 'Say what information you need.' : `A comment is required with "${r.label}".`)
      return
    }
    setBusy(r.label)
    setError('')
    try {
      const res = await approvalsApi.respond(req.id, r.label, comment.trim() || undefined)
      toast(res.status === 'info' ? 'Sent back to the requester for more information.' : `You answered "${r.label}".`, 'success')
      setComment('')
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3" data-testid="approval-answer">
      <div className="text-sm font-medium">Your answer</div>
      <Textarea placeholder="Comment (optional unless marked)" value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-16" data-testid="approval-comment" />
      {error && <div className="flex flex-col text-xs text-destructive" data-testid="approval-error">{error}{referenceFor(error) && <ErrorReference id={referenceFor(error)!} />}</div>}
      <div className="flex flex-wrap gap-2">
        {req.responses.map((r) => (
          <Button
            key={r.label} className={cn('h-11 min-w-28 flex-1 sm:flex-none', r.kind === 'approve' && 'bg-emerald-600 text-white hover:bg-emerald-700', r.kind === 'reject' && 'bg-rose-600 text-white hover:bg-rose-700')}
            variant={r.kind === 'approve' || r.kind === 'reject' ? 'default' : 'outline'} disabled={!!busy} onClick={() => void answer(r)} data-testid={`approval-answer-${r.label}`}
          >
            {busy === r.label ? <Loader2 className="animate-spin" /> : r.kind === 'approve' ? <Check /> : r.kind === 'reject' ? <X /> : r.kind === 'info' ? <Info /> : null}
            {r.label}{needsComment(r) ? ' *' : ''}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">Answers cannot be changed afterwards. * needs a comment.</p>
    </div>
  )
}

/* ------------------------------------------------------------------ comments and files of a request */

function Conversation({ requestId }: { requestId: string }) {
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const load = useCallback(() => {
    platform.collab?.timeline(requestId, { table: 'sys_approval_requests', limit: 50 }).then((p) => setItems(p.items.filter((i) => i.kind === 'comment' || i.kind === 'file'))).catch(() => setItems([]))
  }, [requestId])
  useEffect(() => load(), [load])
  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await platform.collab!.addComment({ rowId: requestId, table: 'sys_approval_requests', body: `<p>${text.trim().replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>` })
      setText('')
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const attach = async (f: File | undefined) => {
    if (!f) return
    try {
      await platform.collab!.attachFile(requestId, f, 'sys_approval_requests')
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }
  return (
    <section className="flex flex-col gap-2" data-testid="approval-conversation">
      <h3 className="flex items-center gap-1.5 text-sm font-medium"><MessageSquare className="size-4" />Comments and files</h3>
      {items === null ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : items.length === 0 ? <p className="text-xs text-muted-foreground">No comments yet.</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.id} className="rounded-md border bg-muted/30 p-2 text-sm">
              <div className="text-[11px] text-muted-foreground">{i.byName ?? 'Someone'} · {fmtRelative(i.at)}</div>
              {i.kind === 'comment'
                // comment bodies are sanitised rich text (server sanitizeRichText)
                ? <div className="prose-sm break-words" dangerouslySetInnerHTML={{ __html: sanitizeRichText(String(i.data.Body ?? '')) }} />
                : <a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={i.data.Attachment ? platform.attachments.url(String(i.data.Attachment)) : '#'} target="_blank" rel="noreferrer"><FileText className="size-3.5" />{String(i.data.FileName ?? 'file')}</a>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input placeholder="Write a comment" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} data-testid="approval-comment-input" />
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || !text.trim()} onClick={() => void send()}><Send />Send</Button>
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"><Paperclip className="size-4" />File<input type="file" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} /></label>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ detail */

const HISTORY_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  requested: () => 'asked for approval',
  asked: (d) => `${String(d.userName ?? 'someone')} was asked${d.source && d.source !== 'direct' ? ` (${String(d.source)})` : ''}${d.onBehalfOfName ? ` on behalf of ${String(d.onBehalfOfName)}` : ''}`,
  responded: (d) => `answered "${String(d.response)}"${d.comment ? `: ${String(d.comment)}` : ''}${d.via === 'email' ? ' (by email link)' : ''}${d.bulk ? ' (with others)' : ''}`,
  decided: (d) => `${d.automatic ? 'Decided automatically: ' : 'Decided: '}${String(d.outcome)}${d.reason ? ` (${String(d.reason)})` : ''}`,
  cancelled: (d) => `cancelled${d.reason ? `: ${String(d.reason)}` : ''}`,
  expired: (d) => `expired${d.reason ? `: ${String(d.reason)}` : ''}`,
  reminded: (d) => `reminded ${String(d.userName ?? '')}`,
  escalated: (d) => `escalated (${String(d.action)})`,
  delegated: (d) => `moved from ${String(d.fromName ?? '')} to ${String(d.toName ?? '')} (delegation)`,
  'delegation.ended': (d) => `back to ${String(d.toName ?? '')} (the delegation ended)`,
  reassigned: (d) => `reassigned from ${String(d.fromName ?? '')} to ${String(d.toName ?? '')}${d.comment ? `: ${String(d.comment)}` : ''}`,
  'info.requested': (d) => `asked for more information: ${String(d.comment ?? '')}`,
  'info.answered': (d) => `added information: ${String(d.comment ?? '')}`,
  'stage.started': (d) => `stage "${String(d.name ?? '')}" started`,
  'stage.approved': (d) => `stage "${String(d.name ?? '')}" approved`,
}

function Detail({ id, onBack, onChanged }: { id: string; onBack(): void; onChanged(): void }) {
  const { toast } = useToast()
  const [d, setD] = useState<ApprovalDetail | null>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [reassignTo, setReassignTo] = useState('')
  const [showReassign, setShowReassign] = useState(false)
  const load = useCallback(() => {
    approvalsApi.get(id).then((r) => { setD(r.request); setError('') }).catch((e) => setError(errMsg(e)))
  }, [id])
  useEffect(() => load(), [load])
  const done = () => { load(); onChanged() }
  if (error) return <div className="p-6"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />Back</Button><Empty icon={ShieldAlert} title="Not available" description={error} /></div>
  if (!d) return <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  const fields = Object.entries(d.fields ?? {})
  return (
    <div className="flex flex-col gap-4 p-3 sm:p-4" data-testid="approval-detail">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Back to the list" onClick={onBack} data-testid="approval-back"><ArrowLeft /></Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold break-words" data-testid="approval-title">{d.title}</h2><StatusBadge status={d.status} outcome={d.outcome} /></div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {d.requestedByName ? `From ${d.requestedByName}` : d.flowName ? `From the flow ${d.flowName}` : ''}{` · ${fmtRelative(d.createdOn)}`}{d.dueOn ? ` · due ${fmtDate(d.dueOn)}` : ''}{d.policyName ? ` · ${d.policyName}` : ''}
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={load}><RefreshCw className="size-4" /></Button>
      </div>

      {d.details && <div className="prose-sm rounded-lg border bg-muted/20 p-3 break-words" data-testid="approval-details" dangerouslySetInnerHTML={{ __html: sanitizeRichText(d.details) }} />}
      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm" data-testid="approval-fields">
          {fields.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-words">{fmtValue(v)}</dd></div>)}
        </dl>
      )}
      {d.record ? (
        <section className="rounded-lg border p-3" data-testid="approval-record">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium"><FileText className="size-4" />{d.regardingTableName ?? 'Record'}: {d.record.title || '(no title)'}</div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {d.record.fields.map((f) => <div key={f.name} className="contents"><dt className="text-muted-foreground">{f.label}</dt><dd className="break-words">{fmtValue(f.value)}</dd></div>)}
          </dl>
        </section>
      ) : d.recordHidden ? (
        <div className="flex gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="approval-record-hidden">
          <ShieldAlert className="size-4 shrink-0" />You cannot open the record this request is about. You see what the requester included above.
        </div>
      ) : null}

      {d.canDecide && <AnswerBox req={d} onDone={done} />}
      {d.status === 'info' && d.canAnswerInfo && (
        <div className="flex flex-col gap-2 rounded-lg border border-sky-300 bg-sky-50 p-3 dark:bg-sky-950/30" data-testid="approval-info-answer">
          <div className="text-sm font-medium">More information was asked for</div>
          <p className="text-xs">{String(d.history.filter((h) => h.action === 'info.requested').slice(-1)[0]?.details.comment ?? '')}</p>
          <Textarea value={info} onChange={(e) => setInfo(e.target.value)} placeholder="Your answer" />
          <Button className="w-fit" disabled={!info.trim()} onClick={async () => { try { await approvalsApi.answerInfo(d.id, info); setInfo(''); toast('Sent: the approvers can answer now.', 'success'); done() } catch (e) { toast(errMsg(e), 'error') } }}><Send />Send</Button>
        </div>
      )}
      {d.status === 'info' && !d.canAnswerInfo && <div className="rounded-lg border p-3 text-sm text-muted-foreground">Waiting for more information from the requester.</div>}

      <div className="flex flex-wrap gap-2">
        {d.canReassign && <Button variant="outline" size="sm" onClick={() => setShowReassign((x) => !x)} data-testid="approval-reassign"><UserRoundCog />Reassign</Button>}
        {d.canCancel && <Button variant="outline" size="sm" data-testid="approval-cancel" onClick={async () => { if (!window.confirm('Cancel (withdraw) this request? Nobody can answer it afterwards.')) return; try { await approvalsApi.cancel(d.id); done() } catch (e) { toast(errMsg(e), 'error') } }}><Undo2 />Cancel request</Button>}
      </div>
      {showReassign && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="Email of the person to ask instead" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} />
          <Button disabled={!reassignTo.trim()} onClick={async () => { try { await approvalsApi.reassign(d.id, reassignTo.trim(), undefined, d.myAssignment ? undefined : d.assignments.find((a) => a.status === 'pending')?.id); setShowReassign(false); setReassignTo(''); done() } catch (e) { toast(errMsg(e), 'error') } }}>Reassign</Button>
        </div>
      )}

      <section className="flex flex-col gap-2" data-testid="approval-people">
        <h3 className="text-sm font-medium">Who is asked</h3>
        {d.stages.map((st) => (
          <div key={st.index} className="rounded-lg border p-2">
            {d.stages.length > 1 && <div className="mb-1 flex items-center gap-2 text-xs font-medium">{st.index + 1}. {st.name}<span className="font-normal text-muted-foreground">{st.mode === 'all' ? 'everyone' : st.mode === 'quorum' ? `${st.quorum} must approve` : 'any one'} · {st.status}</span></div>}
            <ul className="flex flex-col gap-1">
              {d.assignments.filter((a) => a.stage === st.index).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                  <span className={cn('font-medium', (a.status === 'reassigned' || a.status === 'escalated' || a.status === 'cancelled' || a.status === 'skipped') && 'text-muted-foreground line-through')}>{a.userName ?? a.userId}</span>
                  {a.source !== 'direct' && <Badge variant="secondary" className="font-normal">{a.source}</Badge>}
                  <span className="text-xs text-muted-foreground">{a.status === 'responded' ? `${a.response}${a.comment ? `: ${a.comment}` : ''} · ${fmtRelative(a.respondedOn)}` : a.status}</span>
                  {a.note && <span className="w-full text-[11px] text-muted-foreground">{a.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <Conversation requestId={d.id} />

      <section className="flex flex-col gap-1" data-testid="approval-history">
        <h3 className="flex items-center gap-1.5 text-sm font-medium"><Clock className="size-4" />History</h3>
        <ol className="flex flex-col gap-1 border-l pl-3">
          {d.history.map((h) => (
            <li key={h.id} className="text-xs">
              <span className="text-muted-foreground">{fmtDate(h.at)} </span>
              <span className="font-medium">{h.actorKind === 'system' ? 'System' : h.actorKind === 'flow' ? 'Flow' : h.actorName ?? 'Someone'}</span>{' '}
              {(HISTORY_TEXT[h.action] ?? ((x: Record<string, unknown>) => `${h.action}${x.text ? `: ${String(x.text)}` : ''}`))(h.details)}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ email link confirmation */

function LinkConfirm({ token, onOpen }: { token: string; onOpen(id: string | null): void }) {
  const [state, setState] = useState<LinkInspect | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let off = false
    approvalsApi.inspectLink(token).then(async (r) => {
      if (off) return
      // a link of another environment: switch to it (when this person may enter it) and look again
      if (!r.ok && r.code === 'environment' && r.environmentId) {
        try {
          await platform.environments.select(r.environmentId)
          const again = await approvalsApi.inspectLink(token)
          if (!off) setState(again)
          return
        } catch { /* show the reason below */ }
      }
      setState(r)
    }).catch((e) => setState({ ok: false, reason: errMsg(e) }))
    return () => { off = true }
  }, [token])
  if (!state) return <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  const req = state.request
  const confirm = async () => {
    if (state.requireComment && !comment.trim()) {
      setError('A comment is required with this answer.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await approvalsApi.useLink(token, comment.trim() || undefined)
      setDone(r.status === 'info' ? 'Sent back to the requester for more information.' : `Done: you answered "${state.response}".`)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4" data-testid="approval-link">
      <PageHeader icon={ClipboardCheck} title="Confirm your answer" subtitle="Opening the link did not answer anything: confirm below." />
      {done ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-4" data-testid="approval-link-done">
          <div className="flex items-center gap-2 text-base font-medium"><CheckCircle2 className="size-5 text-emerald-600" />{done}</div>
          <Button variant="outline" onClick={() => onOpen(req?.id ?? null)}>Open the request</Button>
        </div>
      ) : !state.ok ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-4" data-testid="approval-link-invalid">
          <div className="flex items-center gap-2 text-sm"><ShieldAlert className="size-5 text-amber-600" />{state.reason}</div>
          <Button variant="outline" onClick={() => onOpen(null)}>Go to my approvals</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div>
            <div className="text-base font-semibold break-words" data-testid="approval-link-title">{req?.title}</div>
            <div className="text-xs text-muted-foreground">{req?.requestedByName ? `From ${req.requestedByName}` : ''}{req?.dueOn ? ` · due ${fmtDate(req.dueOn)}` : ''}</div>
          </div>
          {req?.details && <div className="prose-sm break-words text-sm" dangerouslySetInnerHTML={{ __html: sanitizeRichText(req.details) }} />}
          {req && Object.keys(req.fields).length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">{Object.entries(req.fields).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{fmtValue(v)}</dd></div>)}</dl>
          )}
          <div className="text-sm">Your answer: <span className="font-semibold" data-testid="approval-link-response">{state.response}</span></div>
          <Textarea placeholder={state.requireComment ? 'Comment (required)' : 'Comment (optional)'} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="approval-link-comment" />
          {error && <div className="flex flex-col text-xs text-destructive">{error}{referenceFor(error) && <ErrorReference id={referenceFor(error)!} />}</div>}
          <div className="flex flex-wrap gap-2">
            <Button className={cn('h-11 flex-1', state.kind === 'approve' && 'bg-emerald-600 text-white hover:bg-emerald-700', state.kind === 'reject' && 'bg-rose-600 text-white hover:bg-rose-700')} disabled={busy} onClick={() => void confirm()} data-testid="approval-link-confirm">
              {busy ? <Loader2 className="animate-spin" /> : <Check />}Confirm: {state.response}
            </Button>
            <Button variant="outline" className="h-11" onClick={() => onOpen(req?.id ?? null)}>Open the request instead</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ delegations */

function Delegations() {
  const { toast } = useToast()
  const caps = useCaps()
  const [items, setItems] = useState<DelegationInfo[] | null>(null)
  const [to, setTo] = useState('')
  const [from, setFrom] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [note, setNote] = useState('')
  const load = useCallback(() => { approvalsApi.delegations(caps.isAdmin).then((r) => setItems(r.items)).catch((e) => toast(errMsg(e), 'error')) }, [caps.isAdmin, toast])
  useEffect(() => load(), [load])
  const add = async () => {
    try {
      await approvalsApi.delegate({ toUser: to.trim(), ...(from.trim() ? { fromUser: from.trim() } : {}), ...(startsOn ? { startsOn: new Date(startsOn).toISOString() } : {}), ...(endsOn ? { endsOn: new Date(endsOn).toISOString() } : {}), ...(note ? { note } : {}) })
      setTo(''); setFrom(''); setStartsOn(''); setEndsOn(''); setNote('')
      toast('Delegation saved. Waiting approvals move to them when it starts.', 'success')
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="approval-delegations">
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="text-sm font-medium">Out of office: let someone decide for you</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input placeholder="Their email" value={to} onChange={(e) => setTo(e.target.value)} data-testid="delegate-to" />
          {caps.isAdmin && <Input placeholder="For (email; empty: yourself)" value={from} onChange={(e) => setFrom(e.target.value)} />}
          <label className="flex flex-col gap-1 text-xs">From<Input type="datetime-local" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
          <label className="flex flex-col gap-1 text-xs">Until (optional)<Input type="datetime-local" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
          <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button className="w-fit" disabled={!to.trim()} onClick={() => void add()} data-testid="delegate-save">Save delegation</Button>
        <p className="text-[11px] text-muted-foreground">Approvals that wait for you move to them when the delegation starts, and come back when it ends if still open. Every move is in the request's history.</p>
      </div>
      {items === null ? <Loader2 className="size-4 animate-spin" /> : items.length === 0 ? <p className="text-sm text-muted-foreground">No delegations.</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm" data-testid="delegation-row">
              <span className="font-medium">{d.fromName ?? d.fromUser}</span> to <span className="font-medium">{d.toName ?? d.toUser}</span>
              <span className="text-xs text-muted-foreground">{fmtDate(d.startsOn)}{d.endsOn ? ` - ${fmtDate(d.endsOn)}` : ' onwards'}{d.note ? ` · ${d.note}` : ''}</span>
              {d.cancelledOn ? <Badge variant="secondary">cancelled</Badge> : d.active ? <Badge>active</Badge> : null}
              {!d.cancelledOn && <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => { try { await approvalsApi.cancelDelegation(d.id); load() } catch (e) { toast(errMsg(e), 'error') } }}>End</Button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the page */

export function ApprovalsPage() {
  const caps = useCaps()
  const mode = usePlatform((s) => s.mode)
  const { toast } = useToast()
  const [params, setParams] = useState(hashParams)
  useEffect(() => {
    const on = () => setParams(hashParams())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const link = params.get('link')
  const selected = params.get('id')
  const [tab, setTab] = useState<Tab>('toApprove')
  const [status, setStatus] = useState<'open' | 'decided' | ''>('open')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<ApprovalRequestInfo[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulkComment, setBulkComment] = useState('')
  const [busy, setBusy] = useState(false)
  const listTab = tab === 'toApprove' || tab === 'sentByMe' || tab === 'all' || tab === 'involved'

  const load = useCallback(() => {
    if (!listTab || mode !== 'server') return
    approvalsApi.list({ view: tab, status: tab === 'toApprove' ? undefined : status || undefined, q: q.trim() || undefined }).then((r) => {
      setItems(r.items)
      setPicked((p) => new Set([...p].filter((id) => r.items.some((x) => x.id === id && x.canDecide))))
    }).catch((e) => {
      setItems([])
      toast(errMsg(e), 'error')
    })
  }, [tab, status, q, listTab, mode, toast])
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, q])
  // new requests arrive with a bell notification; refresh when one does and every half minute
  useEffect(() => {
    const off = platform.live.subscribe?.('user', () => load()) ?? (() => {})
    const t = setInterval(load, 30_000)
    return () => { off(); clearInterval(t) }
  }, [load])

  const open = (id: string | null) => setHashParam('id', id)
  const bulkOptions = useMemo(() => {
    const sel = (items ?? []).filter((x) => picked.has(x.id))
    if (!sel.length) return []
    const labels = sel.map((x) => x.responses.filter((r) => r.kind === 'approve' || r.kind === 'reject').map((r) => r.label))
    return labels[0].filter((l) => labels.every((ls) => ls.includes(l)))
  }, [items, picked])
  const bulk = async (response: string) => {
    setBusy(true)
    try {
      const r = await approvalsApi.respondMany([...picked], response, bulkComment.trim() || undefined)
      const failed = r.results.filter((x) => !x.ok)
      toast(failed.length ? `${r.results.length - failed.length} answered; ${failed.length} not: ${failed[0].error}` : `${r.results.length} answered "${response}".`, failed.length ? 'error' : 'success')
      setPicked(new Set())
      setBulkComment('')
      load()
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (mode !== 'server') {
    return <div className="p-6"><Empty icon={ClipboardCheck} title="Approvals run on a server" description="Approvals need Appbuilder on a server (with flows and email). They are not available in the demo." /></div>
  }
  if (link) return <div className="h-full overflow-y-auto"><LinkConfirm token={link} onOpen={(id) => { setHashParam('link', null); open(id) }} /></div>

  const tabs: { value: Tab; label: string }[] = [
    { value: 'toApprove', label: 'To approve' }, { value: 'sentByMe', label: 'Sent by me' },
    ...(caps.isAdmin ? [{ value: 'all' as Tab, label: 'All' }] : []), { value: 'delegations', label: 'Delegations' },
    ...(caps.isMaker ? [{ value: 'policies' as Tab, label: 'Policies' }] : []),
  ]
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="approvals-page">
      <div className="border-b px-3 pt-3 pb-2 sm:px-6">
        <PageHeader icon={ClipboardCheck} title="Approvals" subtitle="Decide what waits for you; follow what you asked for." />
        <div className="mt-2 overflow-x-auto"><Segmented label="View" size="sm" value={tab} onChange={(v) => { setTab(v); setItems(null); setPicked(new Set()) }} options={tabs} /></div>
      </div>
      {tab === 'delegations' ? <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6"><Delegations /></div>
        : tab === 'policies' ? <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6"><PoliciesPanel /></div>
          : (
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <div className={cn('flex min-h-0 flex-col border-r', selected && 'hidden md:flex')}>
                <div className="flex flex-wrap items-center gap-2 p-2">
                  <div className="relative min-w-40 flex-1"><Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" /><Input className="h-9 pl-8" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} data-testid="approvals-search" /></div>
                  {tab !== 'toApprove' && <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'decided', label: 'Decided' }, { value: '', label: 'All' }]} />}
                </div>
                {tab === 'toApprove' && picked.size > 0 && (
                  <div className="flex flex-col gap-2 border-y bg-muted/40 p-2" data-testid="approvals-bulk">
                    <div className="text-xs font-medium">{picked.size} selected</div>
                    <Input placeholder="One comment for all (optional)" value={bulkComment} onChange={(e) => setBulkComment(e.target.value)} />
                    <div className="flex flex-wrap gap-2">
                      {bulkOptions.map((l) => <Button key={l} size="sm" disabled={busy} onClick={() => void bulk(l)} data-testid={`approvals-bulk-${l}`}>{l} all</Button>)}
                      {!bulkOptions.length && <span className="text-xs text-muted-foreground">The selected requests have no answer in common.</span>}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {items === null ? <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
                    : items.length === 0 ? <Empty icon={ClipboardCheck} title={tab === 'toApprove' ? 'Nothing waits for you' : 'No requests'} description={tab === 'toApprove' ? 'Requests to approve show up here, with a bell notification and an email.' : 'Nothing matches.'} />
                      : (
                        <ul className="flex flex-col" data-testid="approvals-list">
                          {items.map((x) => (
                            <li key={x.id} className={cn('flex items-start gap-2 border-b px-3 py-2.5 hover:bg-accent/50', selected === x.id && 'bg-accent')} data-testid="approvals-row">
                              {tab === 'toApprove' && (
                                <Checkbox className="mt-1" aria-label={`Select ${x.title}`} disabled={!x.canDecide || !x.allowBulk} checked={picked.has(x.id)}
                                  onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v) n.add(x.id); else n.delete(x.id); return n })} />
                              )}
                              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(x.id)} data-testid="approvals-open">
                                <div className="flex items-start gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{x.title}</span><StatusBadge status={x.status} outcome={x.outcome} /></div>
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {x.requestedByName ?? x.flowName ?? ''}{x.regardingTableName ? ` · ${x.regardingTableName}` : ''} · {fmtRelative(x.createdOn)}{x.dueOn && (x.status === 'pending' || x.status === 'info') ? ` · due ${fmtDate(x.dueOn)}` : ''}
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                </div>
              </div>
              <div className={cn('min-h-0 overflow-y-auto', !selected && 'hidden md:block')}>
                {selected ? <Detail key={selected} id={selected} onBack={() => open(null)} onChanged={load} /> : <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Choose a request to see it.</div>}
              </div>
            </div>
          )}
    </div>
  )
}

export default ApprovalsPage
