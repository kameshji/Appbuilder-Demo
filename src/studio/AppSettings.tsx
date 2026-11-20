import { useEffect, useState } from 'react'
import type { AppDef, OfflineTableDef } from '@/contracts'
import { DEFAULT_OFFLINE_ROWS, MAX_OFFLINE_ROWS, clampRows, normalizeOfflineTables } from '@/phone/offline/tables'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { parseFormulas } from '@/runtime/evaluator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { sizeError as checkSize } from '@/runtime/sizes'
import { SizePicker } from '@/portal/SizePicker'

const PRIMARIES = ['', '#4f46e5', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#18181b']

function Seg<T extends string>({ value, options, onChange, testId }: { value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/50 p-0.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          data-value={o.v}
          onClick={() => onChange(o.v)}
          className={cn('h-7 rounded px-3 text-xs font-medium', value === o.v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function AppSettingsDialog() {
  const open = useUi((s) => s.settingsOpen)
  const app = useStore((s) => s.app)
  return (
    <Dialog open={open} onOpenChange={(o) => useUi.setState({ settingsOpen: o })}>
      {open && <SettingsBody app={app} />}
    </Dialog>
  )
}

function SettingsBody({ app }: { app: AppDef }) {
  const [name, setName] = useState(app.name)
  const [size, setSize] = useState({ w: app.width, h: app.height })
  const [scale, setScale] = useState<'responsive' | 'fit'>(app.scaleMode ?? 'responsive')
  const [mode, setMode] = useState<'light' | 'dark'>(app.theme?.mode ?? 'light')
  const [primary, setPrimary] = useState(app.theme?.primary ?? '')
  const [radius, setRadius] = useState(String(app.theme?.radius ?? 8))
  const [formulas, setFormulas] = useState(app.appProps.Formulas ?? '')
  const [onStart, setOnStart] = useState((app.appProps.OnStart ?? '=false').replace(/^=/, ''))
  const [offline, setOffline] = useState(!!app.offline?.entry)
  // "available offline" tables of an offline-entry app (docs/dev/phone.md "Tables kept on the device")
  const [offTables, setOffTables] = useState<OfflineTableDef[]>(() => app.offline?.tables ?? [])
  useEffect(() => setName(app.name), [app.name])
  const sources = app.dataSources ?? []
  const offOf = (t: string) => offTables.find((x) => x.table.toLowerCase() === t.toLowerCase())
  const setOff = (t: string, patch: Partial<OfflineTableDef> | null) =>
    setOffTables((list) => {
      const rest = list.filter((x) => x.table.toLowerCase() !== t.toLowerCase())
      if (patch === null) return rest
      const prev = list.find((x) => x.table.toLowerCase() === t.toLowerCase()) ?? { table: t }
      return [...rest, { ...prev, ...patch }]
    })
  const nextOffline = { entry: offline, ...(offline && offTables.length ? { tables: normalizeOfflineTables(offTables, sources) } : {}) }
  const offlineChanged = JSON.stringify(nextOffline) !== JSON.stringify({ entry: !!app.offline?.entry, ...(app.offline?.tables?.length ? { tables: app.offline.tables } : {}) })

  const cw = size.w
  const ch = size.h
  const sizeError = checkSize(cw, ch)
  const resized = cw !== app.width || ch !== app.height
  const parsed = parseFormulas(formulas)

  const apply = () => {
    if (sizeError) return
    const st = useStore.getState()
    st.setAppSettings({
      name: name.trim() || app.name,
      width: Math.round(cw),
      height: Math.round(ch),
      scaleMode: scale,
      theme: { mode, primary: primary || undefined, radius: Number.isFinite(Number(radius)) ? Number(radius) : undefined },
      ...(offlineChanged ? { offline: nextOffline } : {}),
    })
    if (formulas !== (app.appProps.Formulas ?? '')) st.setAppProp('Formulas', formulas)
    const os = '=' + onStart
    if (os !== (app.appProps.OnStart ?? '=false')) st.setAppProp('OnStart', os)
    useUi.setState({ settingsOpen: false })
    useUi.getState().requestFit()
  }

  return (
    <DialogContent className="max-h-[90vh] max-w-[640px] overflow-auto" data-testid="app-settings">
      <DialogHeader>
        <DialogTitle>App settings</DialogTitle>
        <DialogDescription>Design size, scaling, theme and app-wide formulas.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 text-sm">
        <label className="block space-y-1">
          <span className="text-xs font-medium">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" data-testid="settings-name" />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Design size</span>
          <SizePicker value={size} onChange={setSize} testId="settings-resolution" />
          {sizeError && <p className="text-xs text-destructive">{sizeError}</p>}
          {!sizeError && resized && (
            <p className="text-[11px] text-muted-foreground">UI components keep their positions; check anchors and layouts after changing between desktop and phone sizes.</p>
          )}
        </div>
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Scale mode</span>
          <div className="flex items-center gap-3">
            <Seg value={scale} onChange={setScale} testId="settings-scale" options={[{ v: 'responsive', label: 'Responsive' }, { v: 'fit', label: 'Fit' }]} />
            <span className="text-xs text-muted-foreground">
              {scale === 'responsive' ? 'Fills the window; UI components follow their anchors and layouts.' : 'Design size scaled uniformly and letterboxed.'}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5">
          <span className="text-xs font-medium">Theme</span>
          <Seg value={mode} onChange={setMode} testId="settings-mode" options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }]} />
          <span className="text-xs font-medium">Primary colour</span>
          <div className="flex flex-wrap gap-1.5">
            {PRIMARIES.map((c) => (
              <button
                key={c || 'default'}
                type="button"
                title={c || 'Default (indigo)'}
                onClick={() => setPrimary(c)}
                className={cn('size-6 rounded-md border border-border', primary === c && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
                style={{ background: c || 'linear-gradient(135deg, #4f46e5 50%, transparent 50%)' }}
              />
            ))}
          </div>
          <span className="text-xs font-medium">Corner radius</span>
          <Input value={radius} onChange={(e) => setRadius(e.target.value)} className="h-8 w-20 tabular-nums" />
        </div>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 size-4" checked={offline} onChange={(e) => setOffline(e.target.checked)} data-testid="settings-offline" />
          <span className="space-y-0.5">
            <span className="block text-xs font-medium">Works offline (entry)</span>
            <span className="block text-[11px] text-muted-foreground">
              On phones with a weak connection: new rows, changes and photos are kept on the device (encrypted) and sent in order when the
              connection returns; screens show the last data loaded. Deleting, approvals and flows still need a connection. Server rules always
              apply when the changes arrive. See Guide &gt; Phone apps.
            </span>
          </span>
        </label>
        {offline && (
          <div className="space-y-1.5 pl-6" data-testid="settings-offline-tables">
            <span className="block text-xs font-medium">Available offline</span>
            <span className="block text-[11px] text-muted-foreground">
              Tables whose rows are kept on the phone (encrypted) for lookups, dropdowns and lists without a connection. They download when the
              app opens online, as the signed-in user (their permissions apply), up to the row limit ({DEFAULT_OFFLINE_ROWS.toLocaleString('en-US')} if
              blank, at most {MAX_OFFLINE_ROWS.toLocaleString('en-US')}). The filter is a condition the server can run, for example{' '}
              <code className="font-mono">Status &lt;&gt; "Closed"</code>.
            </span>
            {sources.length === 0 && <span className="block text-[11px] text-muted-foreground">The app has no data sources yet.</span>}
            {sources.map((t) => {
              const cur = offOf(t)
              return (
                <div key={t} className="grid grid-cols-[auto_1fr_5.5rem] items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" className="size-4" checked={!!cur} onChange={(e) => setOff(t, e.target.checked ? {} : null)} data-testid={`settings-offline-table-${t}`} />
                    <span className="truncate">{t}</span>
                  </label>
                  <Input
                    value={cur?.filter ?? ''}
                    disabled={!cur}
                    placeholder="Filter (optional)"
                    className="h-7 font-mono text-xs"
                    spellCheck={false}
                    onChange={(e) => setOff(t, { filter: e.target.value })}
                    data-testid={`settings-offline-filter-${t}`}
                  />
                  <Input
                    value={cur?.maxRows ?? ''}
                    disabled={!cur}
                    placeholder={String(DEFAULT_OFFLINE_ROWS)}
                    inputMode="numeric"
                    className="h-7 text-xs tabular-nums"
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      setOff(t, { maxRows: e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : clampRows(n) })
                    }}
                    aria-label={`${t} row limit`}
                    data-testid={`settings-offline-max-${t}`}
                  />
                </div>
              )
            })}
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">App.OnStart</span>
          <Input value={onStart} onChange={(e) => setOnStart(e.target.value)} className="h-8 font-mono text-xs" spellCheck={false} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">App.Formulas</span>
          <span className="block text-[11px] text-muted-foreground">
            Named formulas <code className="font-mono">Name = expression;</code> and functions <code className="font-mono">Area(w: Number, h: Number): Number = w * h;</code>
          </span>
          <Textarea
            value={formulas}
            onChange={(e) => setFormulas(e.target.value)}
            spellCheck={false}
            rows={6}
            data-testid="settings-formulas"
            className="font-mono text-xs"
          />
          {parsed.errors.map((er, i) => (
            <p key={i} className="text-xs text-destructive">
              {er.message}
            </p>
          ))}
          {!parsed.errors.length && (parsed.named.length > 0 || parsed.udfs.length > 0) && (
            <p className="text-[11px] text-muted-foreground">
              {parsed.named.map((n) => n.name).concat(parsed.udfs.map((u) => u.name + '()')).join(', ')}
            </p>
          )}
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => useUi.setState({ settingsOpen: false })}>
          Cancel
        </Button>
        <Button size="sm" disabled={!!sizeError} onClick={apply} data-testid="settings-apply">
          Apply
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
