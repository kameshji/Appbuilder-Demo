/**
 * The dashboard settings screen (P2-C): the environment's defaults for every dashboard (fiscal year start, first day of the
 * week, shifts, time zone, locale and currency), over GET / PUT /dashboards/settings. Everyone who can open dashboards sees
 * the values; only administrators can change them (the server refuses anyone else). The checks and their wording are in
 * src/dashboards/settings.ts: the server keeps only valid values and drops the rest, so nothing invalid is sent.
 * Demo mode keeps the values in browser storage (api.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Info, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { MAX_SHIFTS, MAX_SHIFT_NAME, MONTH_NAMES, draftOf, sameSettings, validateSettings, valuesOf } from '@/dashboards/settings'
import type { SettingsDraft, ShiftDraft } from '@/dashboards/settings'
import { errMsg, useToast } from '../kit'
import { dashboardsApi } from './api'
import type { DashboardSettings } from './api'
import { sel } from './ConditionBuilder'

const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf?(k: string): string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { return [] }
}

export function DashboardSettingsSheet({ canChange, onClose, onSaved }: { canChange: boolean; onClose(): void; onSaved?(s: DashboardSettings): void }) {
  const [saved, setSaved] = useState<SettingsDraft | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  useEffect(() => {
    dashboardsApi.settings().then((s) => { const d = draftOf(s); setSaved(d); setDraft(d) }, (e) => setLoadError(errMsg(e)))
  }, [])
  const issues = useMemo(() => (draft ? validateSettings(draft) : { errors: [], warnings: [] }), [draft])
  const tzList = useMemo(zones, [])
  const set = (patch: Partial<SettingsDraft>) => { setSaveError(null); setDraft((d) => (d ? { ...d, ...patch } : d)) }
  const setShift = (i: number, patch: Partial<ShiftDraft>) => set({ shifts: draft!.shifts.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const errOf = (field: string) => issues.errors.filter((e) => e.field === field).map((e) => e.message)
  const dirty = !!draft && !!saved && !sameSettings(draft, saved)

  const save = async () => {
    if (!draft || issues.errors.length) return
    setBusy(true)
    try {
      const s = await dashboardsApi.saveSettings(valuesOf(draft))
      const d = draftOf(s)
      setSaved(d); setDraft(d)
      onSaved?.(s)
      toast('Dashboard settings saved.', 'success')
      onClose()
    } catch (e) { setSaveError(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl" data-testid="dashboard-settings" onInteractOutside={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle>Dashboard settings</SheetTitle>
          <SheetDescription>
            {canChange ? 'These apply to every dashboard in this environment: date ranges, fiscal periods and number formats.' : 'These apply to every dashboard in this environment. Only administrators can change them.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {loadError ? <p className="p-4 text-sm text-destructive" role="alert">{loadError}</p> : !draft ? <div className="flex justify-center p-10"><Spinner /></div> : (
            <fieldset disabled={!canChange || busy} className="grid gap-0">
              <Block title="Dates" hint="Date ranges such as This month or This fiscal year follow these.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Time zone" errors={errOf('timeZone')} hint="For example Asia/Kolkata or Europe/Berlin.">
                    <Input className="h-8" list="dashboard-timezones" value={draft.timeZone} onChange={(e) => set({ timeZone: e.target.value })} aria-invalid={errOf('timeZone').length > 0} data-testid="settings-timezone" />
                    <datalist id="dashboard-timezones">{tzList.map((z) => <option key={z} value={z} />)}</datalist>
                  </Field>
                  <Field label="The fiscal year starts in" errors={errOf('fiscalYearStart')}>
                    <select className={sel} value={draft.fiscalYearStart} onChange={(e) => set({ fiscalYearStart: Number(e.target.value) })} data-testid="settings-fiscal">
                      {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="The week starts on" errors={errOf('weekStart')}>
                    <select className={sel} value={draft.weekStart} onChange={(e) => set({ weekStart: Number(e.target.value) === 7 ? 7 : 1 })} data-testid="settings-week">
                      <option value={1}>Monday</option>
                      <option value={7}>Sunday</option>
                    </select>
                  </Field>
                </div>
              </Block>

              <Block title="Numbers" hint="How numbers and money are written on charts and tables.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Locale" errors={errOf('locale')} hint="en-IN gives 12,34,567 and lakh / crore; en-US gives 1,234,567.">
                    <Input className="h-8" value={draft.locale} onChange={(e) => set({ locale: e.target.value })} aria-invalid={errOf('locale').length > 0} data-testid="settings-locale" />
                  </Field>
                  <Field label="Currency" errors={errOf('currency')} hint="A three-letter code such as INR, USD or EUR.">
                    <Input className="h-8" maxLength={3} value={draft.currency} onChange={(e) => set({ currency: e.target.value })} aria-invalid={errOf('currency').length > 0} data-testid="settings-currency" />
                  </Field>
                </div>
              </Block>

              <Block title="Shifts" hint={`Used by "This shift". Up to ${MAX_SHIFTS}. A shift that runs past midnight (22:00 to 06:00) ends the next day.`}>
                {errOf('shifts').map((m) => <p key={m} className="text-xs text-destructive">{m}</p>)}
                <div className="grid gap-2" data-testid="settings-shifts">
                  {draft.shifts.map((s, i) => (
                    <div key={i} className="grid gap-1.5 rounded-md border bg-card p-2.5" data-testid={`settings-shift-${i}`}>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Name</span>
                          <Input className="h-8 w-28" maxLength={MAX_SHIFT_NAME + 5} value={s.name} onChange={(e) => setShift(i, { name: e.target.value })} data-testid={`settings-shift-${i}-name`} /></label>
                        <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Starts</span>
                          <Input className="h-8 w-28" type="time" value={s.start} onChange={(e) => setShift(i, { start: e.target.value })} data-testid={`settings-shift-${i}-start`} /></label>
                        <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">Ends</span>
                          <Input className="h-8 w-28" type="time" value={s.end} onChange={(e) => setShift(i, { end: e.target.value })} data-testid={`settings-shift-${i}-end`} /></label>
                        <label className="flex h-8 items-center gap-1.5 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={s.nextDay} onChange={(e) => setShift(i, { nextDay: e.target.checked })} data-testid={`settings-shift-${i}-next`} />Ends the next day</label>
                        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove shift ${s.name || i + 1}`} onClick={() => set({ shifts: draft.shifts.filter((_, j) => j !== i) })} data-testid={`settings-shift-${i}-remove`}><Trash2 /></Button>
                      </div>
                      {errOf(`shift:${i}`).map((m) => <p key={m} className="flex gap-1.5 text-xs text-destructive"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{m}</p>)}
                    </div>
                  ))}
                  <div><Button type="button" size="sm" variant="outline" disabled={draft.shifts.length >= MAX_SHIFTS} onClick={() => set({ shifts: [...draft.shifts, { name: '', start: '06:00', end: '14:00', nextDay: false }] })} data-testid="settings-add-shift"><Plus /> Add a shift</Button></div>
                </div>
              </Block>
            </fieldset>
          )}
        </div>
        <footer className="shrink-0 border-t bg-card p-3" data-testid="settings-footer">
          {(issues.warnings.length > 0 || saveError) && (
            <ul className="mb-2 max-h-28 space-y-0.5 overflow-auto text-xs" data-testid="settings-issues">
              {saveError && <li className="flex gap-1.5 text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{saveError}</li>}
              {issues.warnings.map((e, i) => <li key={`w${i}`} className="flex gap-1.5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{e.message}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!canChange && <span className="mr-auto text-xs text-muted-foreground" data-testid="settings-readonly">Read only: ask an administrator to change these.</span>}
            <Button variant="outline" size="sm" onClick={onClose} data-testid="settings-cancel">{canChange ? 'Cancel' : 'Close'}</Button>
            {canChange && <Button size="sm" onClick={save} disabled={!dirty || issues.errors.length > 0 || busy} data-testid="settings-save">{busy ? <Spinner /> : null} Save</Button>}
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  )
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-b p-4" aria-label={title}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, errors, hint, children }: { label: string; errors: string[]; hint?: string; children: ReactNode }) {
  return (
    <label className="grid content-start gap-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
      {errors.length ? errors.map((m) => <span key={m} className="text-destructive">{m}</span>) : hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </label>
  )
}
