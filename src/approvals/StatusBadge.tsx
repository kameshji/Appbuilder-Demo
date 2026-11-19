/** The status chip of an approval request (Approvals page, Approvals panel UI component). */
import { cn } from '@/lib/utils'

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  rejected: 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200',
  cancelled: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
}
const STATUS_LABEL: Record<string, string> = { pending: 'Waiting', info: 'Needs info', approved: 'Approved', rejected: 'Rejected', completed: 'Answered', cancelled: 'Cancelled', expired: 'Expired' }

export function StatusBadge({ status, outcome }: { status: string; outcome?: string | null }) {
  const label = status === 'completed' && outcome ? outcome : STATUS_LABEL[status] ?? status
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[status] ?? 'bg-muted')} data-testid="approval-status">{label}</span>
}

