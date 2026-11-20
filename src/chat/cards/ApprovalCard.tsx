/**
 * An approval card (package E): posted by the system sender "Approvals" into the approver's own conversation. What it
 * shows is the server's answer for THIS reader (POST /chat/cards/resolve: the inbox's visibility rule, the record only
 * as the reader may read it). Its buttons call the same route as the inbox (POST /approvals/:id/respond): comment
 * required answers, delegation, self-approval prevention, separation of duties and immutable decisions are the
 * server's checks; a refusal is shown as the server words it. A decision made elsewhere (inbox, email link, someone
 * else) edits the message, so the card resolves again on its own.
 */
import { useEffect, useState } from 'react'
import { CheckCircle2, ClipboardCheck, Loader2, Lock, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ChatApprovalCardView, ChatCardRef } from '@/platform/chat-protocol'
import { approvalsApi } from '@/approvals/api'
import { cardKey, forgetCard, resolveCard, useChat } from '../store'

const STATUS: Record<string, string> = {
  pending: 'Waiting for answers', info: 'Waiting for more information', approved: 'Approved', rejected: 'Rejected', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired',
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

export function ApprovalCard({ messageId, index, card, version }: { messageId: string; index: number; card: Extract<ChatCardRef, { kind: 'approval' }>; version: number }) {
  const key = cardKey(messageId, index, version)
  const v = useChat((s) => s.cards[key])
  const [answer, setAnswer] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (v === undefined) void resolveCard(messageId, index, card, version)
  }, [v, messageId, index, card, version])

  const box = 'mt-1 block w-full max-w-96 rounded-md border border-border bg-background p-2.5 text-sm'
  if (v === undefined || v === 'loading') return <div className={box} data-testid="chat-card" data-kind="approval" data-state="loading"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
  if (v === 'error') return <div className={box} data-testid="chat-card" data-kind="approval" data-state="error"><span className="text-xs text-muted-foreground">The card could not be loaded.</span></div>
  if (!v.available || v.kind !== 'approval') {
    return (
      <div className={box} data-testid="chat-card" data-state="unavailable" data-kind="approval">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3.5" /> Not available</span>
      </div>
    )
  }
  const a: ChatApprovalCardView = v
  const opt = a.options.find((o) => o.label === answer) ?? null
  const decided = !['pending', 'info'].includes(a.status)
  const send = async () => {
    if (!opt) return
    setBusy(true)
    setError('')
    try {
      await approvalsApi.respond(a.request, opt.label, comment.trim() || undefined, a.env)
      setAnswer(null)
      setComment('')
      forgetCard(messageId, index, version)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={box} data-testid="chat-card" data-state="available" data-kind="approval" data-status={a.status} data-can-decide={a.canDecide ? '1' : '0'}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ClipboardCheck className="size-3.5" /> Approval request</div>
      <a className="mt-0.5 block truncate font-medium hover:underline" href={`#u-approvals?id=${encodeURIComponent(a.request)}`} data-testid="chat-card-title">{a.title}</a>
      <p className="text-xs text-muted-foreground">
        {a.requestedByName ? `Asked by ${a.requestedByName}` : 'Asked by a flow'}
        {a.dueOn ? ` · due ${new Date(a.dueOn).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
      </p>
      {a.record && <p className="mt-0.5 truncate text-xs"><span className="text-muted-foreground">{a.record.tableName}:</span> {a.record.title}</p>}
      {a.fields.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs" data-testid="chat-approval-fields">
          {a.fields.slice(0, 8).map((f) => (
            <div key={f.name} className="contents" data-field={f.name}>
              <dt className="text-muted-foreground">{f.name}</dt>
              <dd className="truncate">{value(f.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className={cn('mt-1.5 flex items-center gap-1 text-xs font-medium', a.status === 'approved' ? 'text-emerald-700 dark:text-emerald-300' : a.status === 'rejected' ? 'text-destructive' : 'text-muted-foreground')} data-testid="chat-approval-status">
        {a.status === 'approved' ? <CheckCircle2 className="size-3.5" /> : a.status === 'rejected' ? <XCircle className="size-3.5" /> : null}
        {STATUS[a.status] ?? a.status}{a.outcome && decided && a.status === 'completed' ? `: ${a.outcome}` : ''}
      </p>
      {a.myAnswer && (
        <p className="text-xs" data-testid="chat-approval-mine">You answered <span className="font-medium">{a.myAnswer.response}</span>{a.myAnswer.comment ? `: ${a.myAnswer.comment}` : ''}</p>
      )}
      {!a.canDecide && !a.myAnswer && !decided && <p className="text-xs text-muted-foreground">You are not asked to answer this now (it may have been reassigned or delegated, or it waits for the requester).</p>}
      {a.canDecide && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answers">
            {a.options.map((o) => (
              <Button key={o.label} size="xs" variant={answer === o.label ? 'default' : o.kind === 'reject' ? 'outline' : 'secondary'} disabled={busy}
                aria-pressed={answer === o.label} data-testid="chat-approval-answer" data-answer={o.label}
                onClick={() => { setAnswer(answer === o.label ? null : o.label); setError('') }}>
                {o.label}
              </Button>
            ))}
          </div>
          {opt && (
            <div className="space-y-1.5">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className="min-h-0 text-sm"
                placeholder={opt.requireComment ? 'A comment is required with this answer' : 'Comment (optional)'} aria-label="Comment" data-testid="chat-approval-comment" />
              <div className="flex items-center gap-2">
                <Button size="xs" disabled={busy} onClick={() => void send()} data-testid="chat-approval-send">{busy ? <Loader2 className="animate-spin" /> : null}Send "{opt.label}"</Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setAnswer(null); setComment('') }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive" role="alert" data-testid="chat-approval-error">{error}</p>}
    </div>
  )
}
