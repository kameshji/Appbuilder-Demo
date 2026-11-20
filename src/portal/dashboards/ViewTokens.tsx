/**
 * TV and kiosk screens of a dashboard (P2-C): its view tokens, for the dashboard's owner (while a maker) and administrators.
 * Server only (GET / POST / DELETE /dashboards/:id/tokens, server/core/dashboards/tokens.ts). The new token is shown ONCE,
 * with the ready-made screen address (the token after `#`, never in a query string: src/dashboards/kiosk.ts) and the
 * server's warnings above it, prominently, before anyone copies it. Revoking asks first (inline: a dialog would open
 * behind this sheet). The token is kept only in this component's state while it is shown, never in browser storage.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react'
import { usePlatform } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { DashboardInfo } from '@/dashboards/types'
import { CYCLE_DEFAULT_SECONDS, CYCLE_MAX_PAGES, CYCLE_MAX_RANGES, CYCLE_MAX_SECONDS, CYCLE_MIN_SECONDS, kioskAddress } from '@/dashboards/kiosk'
import type { KioskCycle } from '@/dashboards/kiosk'
import { RANGE_PRESETS } from '@/dashboards/dates'
import type { RangePreset } from '@/dashboards/dates'
import { errMsg, fmtDate, fmtRelative, useToast } from '../kit'
import { useCaps } from '../security'
import { dashboardsApi } from './api'
import type { NewViewToken, ViewTokenInfo } from './api'
import { sel } from './ConditionBuilder'

const EXPIRY = [
  { key: 'never', label: 'Never (revoke it when the screen goes)', days: 0 },
  { key: '1', label: 'In 1 day', days: 1 },
  { key: '7', label: 'In 7 days', days: 7 },
  { key: '30', label: 'In 30 days', days: 30 },
  { key: '90', label: 'In 90 days', days: 90 },
  { key: '365', label: 'In 1 year', days: 365 },
  { key: 'date', label: 'On a date...', days: -1 },
] as const

/** the expiry choice -> ISO time (end of the chosen day in this browser's time zone), or null */
export function expiryOf(choice: string, date: string, now = new Date()): string | null {
  const e = EXPIRY.find((x) => x.key === choice)
  if (!e || e.days === 0) return null
  if (e.days > 0) return new Date(now.getTime() + e.days * 86_400_000).toISOString()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0).toISOString()
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

export function ViewTokensSheet({ info, onClose }: { info: DashboardInfo; onClose(): void }) {
  const caps = useCaps()
  const users = usePlatform((s) => s.users)
  const services = users.filter((u) => (u as { kind?: string }).kind === 'service' && (u as { status?: string }).status !== 'disabled')
  const { toast } = useToast()
  const [items, setItems] = useState<ViewTokenInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState<string>('90')
  const [expiryDate, setExpiryDate] = useState('')
  const [viewAs, setViewAs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<NewViewToken | null>(null)
  // cycling (P3-D): part of the address, not of the token; off by default
  const [cycleOn, setCycleOn] = useState(false)
  const [cycleEvery, setCycleEvery] = useState(String(CYCLE_DEFAULT_SECONDS))
  const [cycleRanges, setCycleRanges] = useState<RangePreset[]>([])
  const [cyclePages, setCyclePages] = useState('1')
  const [createdCycle, setCreatedCycle] = useState<KioskCycle | null>(null)
  const cycleOf = (): KioskCycle | null => {
    if (!cycleOn) return null
    const every = Math.floor(Number(cycleEvery)); const pages = Math.floor(Number(cyclePages))
    return { every: Number.isFinite(every) ? every : CYCLE_DEFAULT_SECONDS, ranges: cycleRanges, pages: Number.isFinite(pages) ? pages : 1 }
  }
  const everyOk = !cycleOn || (Number(cycleEvery) >= CYCLE_MIN_SECONDS && Number(cycleEvery) <= CYCLE_MAX_SECONDS)
  const pagesOk = !cycleOn || (Number(cyclePages) >= 1 && Number(cyclePages) <= CYCLE_MAX_PAGES)
  const cycleUseful = !cycleOn || cycleRanges.length >= 2 || Number(cyclePages) >= 2
  const [copied, setCopied] = useState<'address' | 'token' | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(() => { dashboardsApi.tokens(info.id).then((x) => { setItems(x); setLoadError(null) }, (e) => setLoadError(errMsg(e))) }, [info.id])
  useEffect(load, [load])

  const create = async () => {
    setError(null)
    if (expiry === 'date' && !expiryOf('date', expiryDate)) { setError('Choose the day the token stops working.'); return }
    setBusy(true)
    try {
      const t = await dashboardsApi.createToken(info.id, { label: label.trim(), expiresOn: expiryOf(expiry, expiryDate), viewAs: viewAs ? { serviceAccount: viewAs } : 'creator' })
      setCreatedCycle(cycleOf())
      setCreated(t)
      setCopied(null)
      setLabel('')
      load()
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const revoke = async (t: ViewTokenInfo) => {
    try {
      await dashboardsApi.revokeToken(info.id, t.id)
      toast(`"${t.label}" is revoked. Its screen stops at its next refresh.`, 'success')
      setRevoking(null)
      load()
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const address = created ? kioskAddress(location.origin, location.pathname, created.token, createdCycle) : ''
  const copy = async (what: 'address' | 'token') => {
    if (!created) return
    if (await copyText(what === 'address' ? address : created.token)) setCopied(what)
    else toast('The browser did not allow copying: select the text and copy it yourself.', 'error')
  }
  // closing with the token still on screen: it is gone for good afterwards
  const close = () => { setCreated(null); onClose() }
  const toggleRange = (k: RangePreset) => setCycleRanges((r) => (r.includes(k) ? r.filter((x) => x !== k) : r.length >= CYCLE_MAX_RANGES ? r : [...r, k]))

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close() }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl" data-testid="tokens-sheet" onInteractOutside={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2"><KeyRound className="size-4" /> TV and kiosk screens</SheetTitle>
          <SheetDescription>
            A view token lets one screen (a TV, a wall display) show this dashboard without anyone signing in. Whoever has the screen's address sees
            what the token's account sees, from anywhere this server can be reached, until the token is revoked or expires. It opens nothing else:
            no other dashboard, no apps, no data API.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {created ? (
            <section className="grid gap-3 border-b bg-card p-4" data-testid="token-created" aria-label="The new token">
              <h3 className="text-sm font-semibold">"{created.label}" is ready. Copy the address now: it is shown only this once.</h3>
              {created.warnings.length > 0 && (
                <ul className="grid gap-2" data-testid="token-warnings">
                  {created.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" role="alert">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0" />{w}
                    </li>
                  ))}
                </ul>
              )}
              <label className="grid gap-1 text-xs">
                <span className="font-medium text-muted-foreground">Address for the screen (open it in the screen's browser, full screen)</span>
                <div className="flex gap-2">
                  <Input readOnly value={address} className="h-8 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="token-address" />
                  <Button size="sm" onClick={() => void copy('address')} data-testid="token-copy-address">{copied === 'address' ? <Check /> : <Copy />} {copied === 'address' ? 'Copied' : 'Copy address'}</Button>
                </div>
              </label>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Button size="xs" variant="outline" onClick={() => void copy('token')} data-testid="token-copy-token">{copied === 'token' ? <Check /> : <Copy />} Copy the token only</Button>
                <span>The token is after <code>#</code>: browsers never send that part to the server, so it is not in server or proxy logs. Treat the address like a password.</span>
              </div>
              <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => setCreated(null)} data-testid="token-done">I copied it, hide it</Button></div>
            </section>
          ) : (
            <section className="grid gap-3 border-b p-4" aria-label="New view token" data-testid="token-form">
              <h3 className="text-sm font-semibold">New screen</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Label (where the screen is)</span>
                  <Input className="h-8" value={label} maxLength={100} placeholder="Shop floor TV, line 2" onChange={(e) => setLabel(e.target.value)} data-testid="token-label" /></label>
                <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Stops working</span>
                  <div className="flex gap-2">
                    <select className={sel} value={expiry} onChange={(e) => setExpiry(e.target.value)} data-testid="token-expiry">{EXPIRY.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
                    {expiry === 'date' && <Input type="date" className="h-8 w-40" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} aria-label="Expiry date" data-testid="token-expiry-date" />}
                  </div></label>
              </div>
              <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Show the dashboard as</span>
                <select className={sel} value={viewAs} onChange={(e) => setViewAs(e.target.value)} disabled={!caps.isAdmin} data-testid="token-viewas">
                  <option value="">Me: the screen shows exactly what I see</option>
                  {caps.isAdmin && services.map((u) => <option key={u.id} value={u.id}>Service account: {u.name}</option>)}
                </select>
                <span className="text-muted-foreground">
                  {caps.isAdmin
                    ? 'Each tile runs with this account\'s own row and column security, checked on every refresh. As an administrator you see every row: for a screen in a shared place choose a service account with a narrow role (it must be able to open this dashboard).'
                    : 'Each tile runs with your own row and column security, checked on every refresh. Only administrators can choose a service account.'}
                </span>
              </label>
              <fieldset className="grid gap-2 rounded-md border p-3 text-xs" data-testid="token-cycle">
                <legend className="px-1 font-medium text-muted-foreground">Cycling (optional)</legend>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cycleOn} onChange={(e) => setCycleOn(e.target.checked)} data-testid="token-cycle-on" /> Rotate this screen through date ranges and / or pages of tiles</label>
                {cycleOn && (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="grid gap-1"><span className="text-muted-foreground">Seconds on each step ({CYCLE_MIN_SECONDS} to {CYCLE_MAX_SECONDS})</span>
                        <Input className="h-8 w-28" type="number" min={CYCLE_MIN_SECONDS} max={CYCLE_MAX_SECONDS} value={cycleEvery} onChange={(e) => setCycleEvery(e.target.value)} data-testid="token-cycle-every" /></label>
                      <label className="grid gap-1"><span className="text-muted-foreground">Pages of tiles (1 to {CYCLE_MAX_PAGES})</span>
                        <Input className="h-8 w-28" type="number" min={1} max={CYCLE_MAX_PAGES} value={cyclePages} onChange={(e) => setCyclePages(e.target.value)} data-testid="token-cycle-pages" /></label>
                    </div>
                    <div className="grid gap-1"><span className="text-muted-foreground">Date ranges to rotate through (in the order you tick them; none: the dashboard's own range)</span>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">{RANGE_PRESETS.map((p) => (
                        <label key={p.key} className="flex items-center gap-1.5"><input type="checkbox" checked={cycleRanges.includes(p.key)} onChange={() => toggleRange(p.key)} data-testid={`token-cycle-range-${p.key}`} /> {p.label}</label>
                      ))}</div></div>
                    <p className="text-muted-foreground">Pages split the dashboard into groups of whole rows of tiles, shown one after the other, for dashboards with more tiles than fit the screen. The cycle is part of the address, not of the token: the token still shows this one dashboard, and every range is checked by the server as before. The screen keeps rotating through what it already has if the network drops.</p>
                    {!cycleUseful && <p className="text-amber-700 dark:text-amber-300" role="status">Choose at least two ranges or two pages, otherwise the screen will not rotate.</p>}
                  </div>
                )}
              </fieldset>
              {error && <p className="flex gap-1.5 text-xs text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{error}</p>}
              <div className="flex justify-end"><Button size="sm" onClick={() => void create()} disabled={busy || !label.trim() || !everyOk || !pagesOk} data-testid="token-create">{busy ? <Spinner /> : <KeyRound />} Create view token</Button></div>
            </section>
          )}
          <section className="p-4" aria-label="View tokens">
            <h3 className="mb-2 text-sm font-semibold">Tokens of this dashboard</h3>
            {loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : !items ? <Spinner /> : !items.length ? <p className="text-sm text-muted-foreground">None yet.</p> : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs" data-testid="token-list">
                  <thead><tr className="border-b bg-muted/50 text-left text-muted-foreground"><th className="px-2 py-1.5">Label</th><th className="px-2 py-1.5">Shows it as</th><th className="px-2 py-1.5">Created</th><th className="px-2 py-1.5">Expires</th><th className="px-2 py-1.5">Last used</th><th className="px-2 py-1.5">Status</th><th /></tr></thead>
                  <tbody>
                    {items.map((t) => (
                      <tr key={t.id} className="border-b align-top last:border-0" data-testid={`token-row-${t.id}`}>
                        <td className="px-2 py-1.5"><div className="font-medium">{t.label}</div><div className="font-mono text-[10.5px] text-muted-foreground" title="The public part of the token, to tell tokens apart">{t.prefix}...</div></td>
                        <td className="px-2 py-1.5">{t.viewAs.name ?? t.viewAs.userId}{t.viewAs.kind === 'service' && <Badge variant="outline" className="ml-1">service account</Badge>}</td>
                        <td className="px-2 py-1.5" title={fmtDate(t.createdOn)}>{fmtRelative(t.createdOn)}</td>
                        <td className="px-2 py-1.5">{t.expiresOn ? fmtDate(t.expiresOn) : 'never'}</td>
                        <td className="px-2 py-1.5">{t.lastUsedOn ? fmtRelative(t.lastUsedOn) : 'never'}</td>
                        <td className="px-2 py-1.5"><Badge variant={t.status === 'active' ? 'secondary' : 'outline'} data-testid={`token-status-${t.id}`}>{t.status}</Badge></td>
                        <td className="px-2 py-1.5 text-right">
                          {t.status === 'active' && (revoking === t.id ? (
                            <div className="flex flex-col items-end gap-1" data-testid={`token-confirm-${t.id}`}>
                              <span className="max-w-48 text-right">Revoke it? The screen shows "not valid" at its next refresh. This cannot be undone.</span>
                              <div className="flex gap-1">
                                <Button size="xs" variant="outline" onClick={() => setRevoking(null)}>Cancel</Button>
                                <Button size="xs" variant="destructive" onClick={() => void revoke(t)} data-testid={`token-revoke-ok-${t.id}`}>Revoke</Button>
                              </div>
                            </div>
                          ) : <Button size="xs" variant="ghost" onClick={() => setRevoking(t.id)} data-testid={`token-revoke-${t.id}`}>Revoke</Button>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">The tokens and every view-as choice are in the audit log. A token stops when it is revoked or expires, when its account is disabled, and when that account can no longer open this dashboard.</p>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
