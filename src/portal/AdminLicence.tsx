/**
 * Admin console > Licences (hosting phase, H-G / H-H): the licence state as the server's licence client sees it
 * (plan, kind, status, valid until, last check, the grace warning with the exact time it becomes read-only) and the
 * seat passes in use against the licensed seats, with the over-seat warnings. Passes are assigned in Admin console >
 * Users (a column and a bulk action). Everything shown comes from the server; nothing here is enforced in the browser.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, BadgeCheck, CircleCheck, FileKey2, Lock, RefreshCw } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCaps } from './security'
import { Empty, Panel, errMsg, fmtDate, fmtRelative } from './kit'
import { PASS_LABELS, checkLicenceNow, fetchLicence, type LicenceState, type PassKind } from './licenceApi'

const PASS_TEXT: Record<PassKind, string> = {
  full: 'Everything: apps, data, Dev mode (Studio, data model, flows, solutions) and administration with the roles held.',
  operator: 'Runs apps on the web and the phone, approvals, dashboards, tasks, chat and notes, with the data the roles allow. No Dev mode.',
  external: 'For external sites (a later phase): counted, not assignable yet.',
}
const PASSES: PassKind[] = ['full', 'operator', 'external']

const STATUS_TEXT: Record<string, string> = {
  active: 'Active', payment: 'Unpaid', suspended: 'Suspended', cancelled: 'Cancelled', duplicate: 'Used by another install', refused: 'Refused',
}

export function AdminLicence() {
  const server = usePlatform((s) => s.mode) === 'server'
  const caps = useCaps()
  const [data, setData] = useState<LicenceState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!server) return
    let alive = true
    fetchLicence().then((d) => { if (alive) setData(d) }).catch((e) => { if (alive) setError(errMsg(e)) })
    return () => { alive = false }
  }, [server])

  if (!server) {
    return (
      <div data-testid="admin-licences">
        <h2 className="mb-4 text-base font-semibold">Licences</h2>
        <Empty icon={FileKey2} title="The licence needs the local server" description="Demo mode checks no licence. With the server, the licence state and the seat passes are shown here." />
      </div>
    )
  }

  const check = async () => {
    setBusy(true)
    setError('')
    try {
      setData(await checkLicenceNow())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const v = data?.licence
  const seats = data?.seats
  return (
    <div data-testid="admin-licences">
      <div className="mb-4 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Licences</h2>
          <p className="text-sm text-muted-foreground">The licence is verified online every 6 hours. If the licence service cannot be reached, Appbuilder keeps working for 3 days, then becomes read-only (sign-in, reading and export keep working) until a check succeeds.</p>
        </div>
        {caps.isInstallAdmin && v?.configured && (
          <Button size="sm" variant="outline" onClick={() => void check()} disabled={busy} data-testid="licence-check-now">{busy ? <Spinner /> : <RefreshCw />} Check now</Button>
        )}
      </div>
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
      {!data && !error && <Spinner />}
      {v && (
        <>
          {v.readOnly && (
            <Panel className="mb-4 flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4" data-testid="licence-read-only">
              <Lock className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="min-w-0 text-sm">
                <div className="font-semibold">Read-only since {fmtDate(v.readOnly.since)}</div>
                <p className="text-muted-foreground">{v.readOnly.message}</p>
              </div>
            </Panel>
          )}
          {!v.readOnly && v.readOnlyAt && (
            <Panel className="mb-4 flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4" data-testid="licence-warning">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div className="min-w-0 text-sm">
                <div className="font-semibold">Becomes read-only at {fmtDate(v.readOnlyAt)} ({new Date(v.readOnlyAt).toISOString().replace('T', ' ').slice(0, 16)} UTC)</div>
                {v.warnings.map((w) => <p key={w} className="text-muted-foreground">{w}</p>)}
              </div>
            </Panel>
          )}
          {v.problems.length > 0 && (
            <Panel className="mb-4 p-4 text-sm" data-testid="licence-problems">
              <div className="mb-1 font-semibold">Licence settings to fix</div>
              <ul className="list-disc pl-5 text-muted-foreground">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </Panel>
          )}
          <Panel className="mb-4 flex items-start gap-3 p-4" data-testid="licence-current">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><BadgeCheck className="size-5" /></span>
            <div className="min-w-0 flex-1 text-sm">
              {!v.configured ? (
                <>
                  <div className="font-semibold">No licence configured</div>
                  <p className="text-xs text-muted-foreground">This install checks no licence and nothing is limited (development or evaluation). A licensed install has APPBUILDER_LICENCE_URL, APPBUILDER_LICENCE_ID and its install key in its environment; see the administrator guide (Licensing).</p>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    {v.licence ? <>Licence {v.licence.licenceId} <Badge variant={v.licence.status === 'active' ? 'secondary' : 'destructive'} data-testid="licence-status">{STATUS_TEXT[v.licence.status] ?? v.licence.status}</Badge></> : 'Licence not verified yet'}
                    {v.mode === 'ok' && <CircleCheck className="size-4 text-emerald-600" />}
                  </div>
                  <dl className="mt-2 grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    {v.licence && <><dt className="text-muted-foreground">Plan</dt><dd data-testid="licence-plan">{v.licence.plan ?? '-'} ({v.licence.kind === 'lifetime' ? 'lifetime, on-premises' : 'subscription'})</dd></>}
                    {v.licence?.kind === 'subscription' && <><dt className="text-muted-foreground">Paid until</dt><dd>{v.licence.paidUntil ? v.licence.paidUntil.slice(0, 10) : '-'}</dd></>}
                    {v.licence?.kind === 'lifetime' && <><dt className="text-muted-foreground">Updates included until</dt><dd>{v.licence.maintenanceUntil ? v.licence.maintenanceUntil.slice(0, 10) : '-'}</dd></>}
                    {v.licence && <><dt className="text-muted-foreground">Valid until</dt><dd data-testid="licence-valid-until">{fmtDate(v.licence.validUntil)} (72 hours after the last valid answer)</dd></>}
                    <dt className="text-muted-foreground">Last check</dt>
                    <dd data-testid="licence-last-check">{v.lastCheck ? <>{fmtDate(v.lastCheck.at)} ({fmtRelative(v.lastCheck.at)}): {v.lastCheck.ok ? 'verified' : v.lastCheck.error}</> : 'not yet'}</dd>
                    {v.keySource === 'setting' && <><dt className="text-muted-foreground">Licence key</dt><dd>set by APPBUILDER_LICENCE_PUBLIC_KEY (test or evaluation service)</dd></>}
                    {v.installId && <><dt className="text-muted-foreground">Install id</dt><dd className="font-mono">{v.installId}</dd></>}
                  </dl>
                </>
              )}
            </div>
          </Panel>

          <h3 className="mb-2 text-sm font-semibold">Seat passes</h3>
          <div className="mb-2 grid grid-cols-3 gap-3" data-testid="pass-counts">
            {PASSES.map((p) => {
              const over = seats?.over[p]
              return (
                <Panel key={p} className={over ? 'border-amber-500/50 p-4' : 'p-4'} data-testid={`pass-${p}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{PASS_LABELS[p]}</span>
                    <span className="text-2xl font-semibold tabular-nums" data-testid={`pass-count-${p}`}>{seats?.inUse[p] ?? 0}{seats?.licensed && <span className="text-sm font-normal text-muted-foreground"> / {seats.licensed[p]}</span>}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{PASS_TEXT[p]}</p>
                  {over && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" data-testid={`pass-over-${p}`}>
                      {over.by} more than licensed since {over.since.slice(0, 10)}. {over.blocked ? `No new ${PASS_LABELS[p]} passes can be assigned until the counts fit.` : `From ${fmtDate(over.blockedFrom)} no new ${PASS_LABELS[p]} passes can be assigned.`} Nobody loses access.
                    </p>
                  )}
                </Panel>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">Counted: people who are not disabled (invited people included; service accounts never). Passes are assigned in Admin console &gt; Users. Only the three counts are sent to the licence service, never names or email addresses.</p>
        </>
      )}
    </div>
  )
}
