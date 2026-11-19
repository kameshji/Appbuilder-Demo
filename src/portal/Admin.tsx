/**
 * Admin console (#admin, #admin-<section>; Dev mode, administrators): its own sub-navigation over environments,
 * users, licences, the audit log, jobs, flows (kill switch and per-flow state), backups (with the backup health line on every page), server logs, usage and
 * updates (AdminOps.tsx, package L).
 * Everything shown is real data or clearly marked: "preview" (derived, not enforced) and "Soon" (not built).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Archive, BadgeCheck, KeySquare, Mail, ShieldCheck, ChevronLeft, ChevronRight, FileKey2, GitFork, Layers, ListChecks, Network, PackageCheck, RefreshCw, ScrollText, ShieldHalf, Upload, Users, UsersRound, Workflow, Zap,
  type LucideIcon,
} from 'lucide-react'
import { usePlatform, type UserDef } from '@/platform'
import type { AuditEntry, AuditPageResponse } from '@/platform/http'
import { go } from '@/router'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SoonBadge } from './ComingSoon'
import { ServerLogsSection, UpdatesSection, UsageSection } from './AdminOps'
import { EnvironmentsSection } from './AdminEnvironments'
import { EventRunsSection, JobsSection, RetentionSetting } from './AdminJobs'
import { FlowsAdminSection } from './AdminFlows'
import { BackupHealthBanner, BackupsSection } from './AdminBackups'
import { fetchInstallAuditPage } from './environmentApi'
import { useCaps } from './security'
import { Empty, Field, PageHeader, Panel, Segmented, errMsg, fmtDate, fmtRelative } from './kit'
import { UserAvatar } from './Profile'
import { fetchAuditPage } from './serverApi'
import { UsersPanel } from './Users'
import { DepartmentsSection, OrgChartSection, TeamsSection } from './Organisation'
import { EmailSection, ServiceAccountsSection, SignInSecuritySection } from './AdminIdentity'
import { NotificationAdmin } from './AdminNotifications'

export type AdminSection = 'environments' | 'users' | 'security' | 'email' | 'service-accounts' | 'departments' | 'teams' | 'orgchart' | 'licences' | 'audit' | 'jobs' | 'flows' | 'events' | 'backups' | 'logs' | 'usage' | 'updates'
interface SectionDef { key: AdminSection; label: string; icon: LucideIcon; soon?: boolean }
export const ADMIN_SECTIONS: SectionDef[] = [
  { key: 'environments', label: 'Environments', icon: Layers },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'security', label: 'Sign-in and security', icon: ShieldCheck },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'service-accounts', label: 'Service accounts', icon: KeySquare },
  { key: 'departments', label: 'Departments', icon: Network },
  { key: 'teams', label: 'Teams', icon: UsersRound },
  { key: 'orgchart', label: 'Org chart', icon: GitFork },
  { key: 'licences', label: 'Licences', icon: FileKey2 },
  { key: 'audit', label: 'Audit log', icon: ScrollText },
  { key: 'jobs', label: 'Jobs', icon: ListChecks },
  { key: 'flows', label: 'Flows', icon: Workflow },
  { key: 'events', label: 'Events run log', icon: Zap },
  { key: 'backups', label: 'Backups', icon: Archive },
  { key: 'logs', label: 'Server logs', icon: ScrollText },
  { key: 'usage', label: 'Usage', icon: Activity },
  { key: 'updates', label: 'Updates', icon: PackageCheck },
]
export const isAdminSection = (s: string | undefined): s is AdminSection => !!s && ADMIN_SECTIONS.some((x) => x.key === s)

export function AdminConsole({ section }: { section?: string }) {
  const current: AdminSection = isAdminSection(section) ? section : 'environments'
  return (
    <div data-testid="page-admin">
      <PageHeader icon={ShieldHalf} title="Admin console" subtitle="Environments, people, licences and the audit trail of this install." />
      {/* backup health (install administrators): the last good backup's age, failures, what is running */}
      {current !== 'backups' && <div className="mb-4"><BackupHealthBanner compact /></div>}
      <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-6">
        <nav aria-label="Admin console" className="sticky top-0 grid gap-0.5" data-testid="admin-nav">
          {ADMIN_SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              data-testid={`admin-nav-${s.key}`}
              aria-current={current === s.key ? 'page' : undefined}
              onClick={() => go({ page: 'admin', id: s.key })}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                current === s.key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <s.icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              {s.soon && <SoonBadge />}
            </button>
          ))}
        </nav>
        <section className="min-w-0" data-testid={`admin-section-${current}`}>
          {current === 'environments' && <EnvironmentsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'users' && <UsersPanel />}
          {current === 'security' && <SignInSecuritySection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'email' && <><EmailSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} /><NotificationAdmin /></>}
          {current === 'service-accounts' && <ServiceAccountsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'departments' && <DepartmentsSection />}
          {current === 'teams' && <TeamsSection />}
          {current === 'orgchart' && <OrgChartSection />}
          {current === 'licences' && <LicencesSection />}
          {current === 'audit' && <AuditSection />}
          {current === 'jobs' && <JobsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'flows' && <FlowsAdminSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'events' && <EventRunsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'backups' && <BackupsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'logs' && <ServerLogsSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'usage' && <UsageSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
          {current === 'updates' && <UpdatesSection title={(t, sub, actions) => <SectionTitle title={t} subtitle={sub} actions={actions} />} />}
        </section>
      </div>
    </div>
  )
}

function SectionTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
    </div>
  )
}

/* ------------------------------------------------------------------ licences */

type Pass = 'full' | 'operator' | 'external'
const PASSES: { key: Pass; label: string; text: string }[] = [
  { key: 'full', label: 'Full user', text: 'Builds and administers: apps, tables, flows, security. Today: administrators and makers.' },
  { key: 'operator', label: 'Operator', text: 'Uses apps and data with their roles, without building. Today: everyone else.' },
  { key: 'external', label: 'External', text: 'Suppliers and customers on an external site (P6 Sites). Nobody yet: external accounts do not exist.' },
]

/** the pass a user would get under the planned model: administrators and makers Full, others Operator */
export function previewPass(u: UserDef, roles: { id: string; isAdmin?: boolean; isMaker?: boolean }[]): Pass {
  return roles.some((r) => u.roleIds.includes(r.id) && (r.isAdmin || r.isMaker)) ? 'full' : 'operator'
}

function LicencesSection() {
  const users = usePlatform((s) => s.users)
  const roles = usePlatform((s) => s.roles)
  const active = users.filter((u) => u.status !== 'disabled')
  const counts = useMemo(() => {
    const c: Record<Pass, number> = { full: 0, operator: 0, external: 0 }
    for (const u of active) c[previewPass(u, roles)]++
    return c
  }, [active, roles])
  const label = (p: Pass) => PASSES.find((x) => x.key === p)!.label

  return (
    <div data-testid="admin-licences">
      <SectionTitle
        title="Licences"
        subtitle="The planned model: a signed licence file checked offline, and a pass per person assigned by an administrator."
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button size="sm" variant="outline" disabled data-testid="upload-licence"><Upload /> Upload licence file</Button>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><SoonBadge /> Licence files arrive with P3.</span>
          </div>
        }
      />
      <Panel className="mb-4 flex items-start gap-3 p-4" data-testid="licence-current">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><BadgeCheck className="size-5" /></span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Development build, no licence file</div>
          <p className="text-xs text-muted-foreground">This build does not check a licence and nothing is limited. Once licences exist: seat bands per install, a grace period, then read-only; export always keeps working.</p>
        </div>
      </Panel>

      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">Pass types <Badge variant="outline" className="text-[10px] uppercase">Preview</Badge></h3>
      <div className="mb-1 grid grid-cols-3 gap-3" data-testid="pass-counts">
        {PASSES.map((p) => (
          <Panel key={p.key} className="p-4" data-testid={`pass-${p.key}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="text-2xl font-semibold tabular-nums" data-testid={`pass-count-${p.key}`}>{counts[p.key]}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.text}</p>
          </Panel>
        ))}
      </div>
      <p className="mb-5 text-xs text-muted-foreground">Preview: how today's {active.length === 1 ? 'active user' : `${active.length} active users`} would fall into passes, derived from their roles. Nothing is enforced.</p>

      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="licence-users">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="px-4 py-2.5">User</th><th className="px-4 py-2.5">Pass (preview)</th>
              <th className="px-4 py-2.5"><span className="flex items-center gap-1.5">Assigned pass <SoonBadge /></span></th>
            </tr>
          </thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2"><span className="flex items-center gap-2"><UserAvatar user={u} size={22} /><span className="truncate">{u.name}</span><span className="truncate text-xs text-muted-foreground">{u.email}</span></span></td>
                <td className="px-4 py-2">{label(previewPass(u, roles))}</td>
                <td className="px-4 py-2">
                  <select disabled aria-label={`Assigned pass of ${u.name} (arrives with P3)`} className="h-7 rounded-md border border-input bg-muted/50 px-2 text-xs text-muted-foreground" defaultValue="">
                    <option value="">Assigning passes arrives with P3</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------------ audit log */

const PAGE_SIZE = 50

function detailsText(d: unknown): string {
  if (d === null || d === undefined) return ''
  if (typeof d === 'string') return d
  try {
    return JSON.stringify(d)
  } catch {
    return String(d)
  }
}

function AuditSection() {
  const server = usePlatform((s) => s.mode) === 'server'
  const users = usePlatform((s) => s.users)
  const caps = useCaps()
  const envName = usePlatform((s) => s.environments.find((e) => e.id === s.environmentId)?.name ?? 'this environment')
  /** env: the current environment's audit log; install: environment lifecycle, access, install administrators */
  const [scope, setScopeRaw] = useState<'env' | 'install'>('env')
  const [filters, setFilters] = useState({ action: '', user: '', from: '', to: '' })
  const [page, setPage] = useState(1)
  const { action, user, from, to } = filters
  /** a new filter starts again at the newest entries */
  const filter = (p: Partial<typeof filters>) => { setFilters((f) => ({ ...f, ...p })); setPage(1) }
  const [data, setData] = useState<AuditPageResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [tick, setTick] = useState(0)

  const setScope = (v: 'env' | 'install') => { setScopeRaw(v); setFilters((f) => ({ ...f, action: '' })); setPage(1); setOpen(null) }
  useEffect(() => {
    if (!server) return
    let alive = true
    setBusy(true)
    setError('')
    ;(scope === 'install' ? fetchInstallAuditPage : fetchAuditPage)({ action, user, from, to, page, pageSize: PAGE_SIZE })
      .then((r) => { if (alive) setData(r) })
      .catch((e) => { if (alive) setError(errMsg(e)) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [server, action, user, from, to, page, tick, scope])

  if (!server) {
    return (
      <div data-testid="admin-audit">
        <SectionTitle title="Audit log" />
        <Empty icon={ScrollText} title="The audit log needs the local server" description="Demo mode keeps no audit trail. With the server, every sign-in, user, role, table and row change is recorded and shown here." />
      </div>
    )
  }

  const actions = data?.actions ?? []
  const groups = [...new Set(actions.map((a) => a.split('.')[0]).filter(Boolean))]
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const name = (e: AuditEntry) => e.userName ?? (e.userId ? e.userId : 'System or not signed in')

  return (
    <div data-testid="admin-audit">
      <SectionTitle
        title="Audit log"
        subtitle={scope === 'install'
          ? 'Install-level actions, newest first: environments created, changed, deleted, access given or removed, install administrators, deployments.'
          : `Security-relevant and data-changing actions in ${envName}, newest first. Reading data is not recorded.`}
        actions={
          <div className="flex items-center gap-2">
            {caps.isInstallAdmin && (
              <span data-testid="audit-scope">
                <Segmented label="Audit log" value={scope} onChange={setScope} options={[{ value: 'env', label: envName }, { value: 'install', label: 'Install' }]} />
              </span>
            )}
            <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)} disabled={busy} data-testid="audit-refresh">{busy ? <Spinner /> : <RefreshCw />} Refresh</Button>
          </div>
        }
      />
      {scope === 'env' && <div className="mb-3"><RetentionSetting scheduleId="sched_audit_retention" what="audit entries" /></div>}
      <Panel className="mb-3 grid grid-cols-[1.2fr_1.2fr_1fr_1fr_auto] items-end gap-3 p-3" data-testid="audit-filters">
        <Field label="Action" htmlFor="audit-action">
          <select id="audit-action" value={action} onChange={(e) => filter({ action: e.target.value })} data-testid="audit-action" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
            <option value="">All actions</option>
            {groups.map((g) => <option key={`g-${g}`} value={`${g}.`}>{g}.* (all {g} actions)</option>)}
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="User" htmlFor="audit-user">
          <select id="audit-user" value={user} onChange={(e) => filter({ user: e.target.value })} data-testid="audit-user" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
            <option value="">Everyone</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
        </Field>
        <Field label="From" htmlFor="audit-from"><Input id="audit-from" type="date" value={from} onChange={(e) => filter({ from: e.target.value })} data-testid="audit-from" /></Field>
        <Field label="To" htmlFor="audit-to"><Input id="audit-to" type="date" value={to} onChange={(e) => filter({ to: e.target.value })} data-testid="audit-to" /></Field>
        <Button size="sm" variant="ghost" disabled={!action && !user && !from && !to} onClick={() => filter({ action: '', user: '', from: '', to: '' })}>Clear</Button>
      </Panel>
      {error && <p className="mb-3 text-sm text-destructive" role="alert" data-testid="audit-error">{error}</p>}
      <Panel className="overflow-hidden">
        <table className="w-full table-fixed text-sm" data-testid="audit-table">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="w-44 px-3 py-2">When (your time)</th><th className="w-48 px-3 py-2">User</th><th className="w-44 px-3 py-2">Action</th><th className="w-32 px-3 py-2">{scope === 'install' ? 'Environment' : 'Table / row'}</th><th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((e) => (
              <tr key={e.id} className="border-b border-border align-top last:border-0" data-testid={`audit-row-${e.id}`}>
                <td className="px-3 py-2 text-xs" title={e.at}>{fmtDate(e.at)}<div className="text-muted-foreground">{fmtRelative(e.at)}</div></td>
                <td className="truncate px-3 py-2 text-xs"><div className="truncate font-medium">{name(e)}</div>{e.userEmail && <div className="truncate text-muted-foreground">{e.userEmail}</div>}</td>
                <td className="px-3 py-2"><code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{e.action}</code></td>
                <td className="truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">{(scope === 'install' ? e.environmentId : [e.tableId, e.rowId].filter(Boolean).join(' / ')) || '-'}</td>
                <td className="px-3 py-2">
                  {e.details !== null && e.details !== undefined ? (
                    <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className={cn('w-full text-left font-mono text-[11px] text-muted-foreground', open === e.id ? 'whitespace-pre-wrap break-all' : 'truncate')} title={open === e.id ? 'Collapse' : 'Show all'}>
                      {open === e.id ? JSON.stringify(e.details, null, 2) : detailsText(e.details)}
                    </button>
                  ) : <span className="text-xs text-muted-foreground">-</span>}
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">No entries match these filters.</td></tr>}
            {!data && busy && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground"><Spinner className="mr-2 inline" /> Loading...</td></tr>}
          </tbody>
        </table>
      </Panel>
      {data && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="audit-pager">
          <span data-testid="audit-total">{data.total === 0 ? 'No entries' : `${(data.page - 1) * data.pageSize + 1}-${Math.min(data.total, data.page * data.pageSize)} of ${data.total.toLocaleString()}`}</span>
          <span className="ml-auto">Page {data.page} of {pages}</span>
          <Button size="icon-sm" variant="outline" aria-label="Newer entries" disabled={page <= 1 || busy} onClick={() => setPage((p) => Math.max(1, p - 1))} data-testid="audit-prev"><ChevronLeft /></Button>
          <Button size="icon-sm" variant="outline" aria-label="Older entries" disabled={page >= pages || busy} onClick={() => setPage((p) => p + 1)} data-testid="audit-next"><ChevronRight /></Button>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Times are shown in your browser's time zone; the server stores them in UTC. See the administrator guide for what is and is not recorded.</p>
    </div>
  )
}
