import { Fragment, useEffect, useRef, useState } from 'react'
import { Cable, CheckCircle2, Cloud, Copy, FileUp, HardDrive, Info, KeyRound, Pencil, Play, Plus, Star, TableProperties, Trash2, TriangleAlert, XCircle } from 'lucide-react'
import { platform, usePlatform, type ConnectionRef, type ConnectorKind } from '@/platform'
import type { SourceTableInfo } from '@/platform/http'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, Empty, Field, Panel, PageHeader, errMsg, useToast } from './kit'
import { CONNECTOR_INFO, ConnectionFlags, connectorInfo } from './ConnectionBits'
import { PasswordInput } from './PasswordFields'
import { goPortal, matches, useSearch } from './Shell'
import { useCaps } from './security'

/* ------------------------------------------------------------------ service-account key (client-side parsing only) */

export type KeyParse = { ok: true; email: string; project?: string } | { ok: false; error: string }

/** Reads client_email from a pasted service-account JSON. The private key is never shown or logged. */
export function parseServiceAccount(text: string): KeyParse {
  let j: unknown
  try { j = JSON.parse(text) } catch { return { ok: false, error: 'This is not valid JSON. Paste the whole key file, or choose the .json file you downloaded from Google Cloud.' } }
  const o = j as { client_email?: unknown; private_key?: unknown; project_id?: unknown; type?: unknown }
  if (!o || typeof o !== 'object') return { ok: false, error: 'This does not look like a service-account key.' }
  if (typeof o.client_email !== 'string' || !o.client_email.includes('@')) return { ok: false, error: 'The key has no client_email. Download a service-account key (JSON) from Google Cloud.' }
  if (typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) return { ok: false, error: 'The key has no private_key. Download a new JSON key for the service account.' }
  return { ok: true, email: o.client_email, project: typeof o.project_id === 'string' ? o.project_id : undefined }
}

export function extractSpreadsheetId(input: string): string {
  const t = input.trim()
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(t)
  return m ? m[1] : t
}

/* ------------------------------------------------------------------ dialog */

const KINDS: { kind: ConnectorKind; text: string }[] = [
  { kind: 'mysql', text: 'A MySQL or MariaDB database.' },
  { kind: 'gsheets', text: 'Tabs of a Google spreadsheet.' },
  { kind: 'files', text: 'CSV, Excel and JSON files on this device.' },
]

function CopyEmail({ email }: { email: string }) {
  const { toast } = useToast()
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" data-testid="service-account-email">{email}</code>
      <Button type="button" variant="outline" size="xs" onClick={() => { navigator.clipboard?.writeText(email).then(() => toast('Email copied', 'success')).catch(() => toast('Select the email and press Ctrl+C', 'info')) }}>
        <Copy /> Copy
      </Button>
    </div>
  )
}

function ConnectionDialog({ open, onOpenChange, connection, onSaved }: { open: boolean; onOpenChange(o: boolean): void; connection: ConnectionRef | null; onSaved(c: ConnectionRef | null): void }) {
  const { fail, toast } = useToast()
  const [kind, setKind] = useState<ConnectorKind>('mysql')
  const [name, setName] = useState('')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('3306')
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState(false)
  const [sheet, setSheet] = useState('')
  const [keyJson, setKeyJson] = useState('') // kept in state only; never rendered
  const [keyInfo, setKeyInfo] = useState<{ email: string; project?: string } | null>(null)
  const [paste, setPaste] = useState('')
  const [keyError, setKeyError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const editing = !!connection

  useEffect(() => {
    if (!open) return
    const s = connection?.settings ?? {}
    setKind(connection?.connector ?? 'mysql')
    setName(connection?.name ?? '')
    setHost(s.host ?? '127.0.0.1')
    setPort(s.port ?? '3306')
    setDatabase(s.database ?? '')
    setUser(s.user ?? '')
    setPassword('')
    setSsl(s.ssl === 'true')
    setSheet(s.spreadsheetId ?? '')
    setKeyJson('')
    setKeyInfo(connection?.connector === 'gsheets' && s.serviceAccountEmail ? { email: s.serviceAccountEmail } : null)
    setPaste('')
    setKeyError('')
  }, [open, connection])

  const acceptKey = (text: string) => {
    const r = parseServiceAccount(text)
    if (r.ok) {
      setKeyJson(text)
      setKeyInfo({ email: r.email, project: r.project })
      setPaste('') // the key never stays visible
      setKeyError('')
    } else {
      setKeyError(r.error)
    }
  }
  const onPaste = (text: string) => {
    setPaste(text)
    if (!text.trim()) { setKeyError(''); return }
    if (/^\s*\{[\s\S]*\}\s*$/.test(text)) acceptKey(text)
    else setKeyError('')
  }

  const portNum = Number(port)
  const mysqlOk = !!host.trim() && Number.isInteger(portNum) && portNum > 0 && portNum < 65536 && !!database.trim() && !!user.trim()
  const sheetId = extractSpreadsheetId(sheet)
  const gsOk = !!sheetId && (!!keyJson || (editing && !!connection?.hasSecret))
  const valid = !!name.trim() && (kind === 'mysql' ? mysqlOk : kind === 'gsheets' ? gsOk : false)

  const run = async () => {
    setBusy(true)
    try {
      let saved: ConnectionRef | null = null
      if (kind === 'mysql') {
        const settings = { host: host.trim(), port: String(portNum), database: database.trim(), user: user.trim(), ssl: ssl ? 'true' : 'false' }
        if (connection) await platform.connections.update(connection.id, { name: name.trim(), settings: { ...connection.settings, ...settings }, ...(password ? { secret: password } : {}) })
        else saved = await platform.connections.create({ name: name.trim(), connector: 'mysql', settings, secret: password })
      } else {
        const settings: Record<string, string> = { spreadsheetId: sheetId }
        if (keyInfo) settings.serviceAccountEmail = keyInfo.email
        if (connection) await platform.connections.update(connection.id, { name: name.trim(), settings: { ...connection.settings, ...settings }, ...(keyJson ? { secret: keyJson } : {}) })
        else saved = await platform.connections.create({ name: name.trim(), connector: 'gsheets', settings, secret: keyJson })
      }
      setPassword('')
      setKeyJson('')
      toast(connection ? 'Connection updated' : `Added connection "${name.trim()}"`, 'success')
      onOpenChange(false)
      onSaved(saved ?? (connection ? platform.getState().connections.find((c) => c.id === connection.id) ?? null : null))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-auto sm:max-w-xl" data-testid="connection-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit connection` : 'New connection'}</DialogTitle>
          <DialogDescription>Passwords and keys are write-only: they are encrypted on the server and never shown again.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void run() }}>
          {!editing && (
            <div role="radiogroup" aria-label="Connector" className="grid grid-cols-3 gap-2">
              {KINDS.map((k) => {
                const I = CONNECTOR_INFO[k.kind].icon
                return (
                  <button
                    key={k.kind}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.kind}
                    data-testid={`connector-${k.kind}`}
                    onClick={() => setKind(k.kind)}
                    className={cn('flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40', kind === k.kind ? 'border-primary bg-accent text-accent-foreground' : 'border-border hover:bg-muted')}
                  >
                    <I className="size-5" />
                    {CONNECTOR_INFO[k.kind].label}
                    <span className="text-[10px] font-normal text-muted-foreground">{k.text}</span>
                  </button>
                )
              })}
            </div>
          )}

          {kind === 'files' ? (
            <div className="grid gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm" data-testid="files-connection-info">
              <p>Data files are managed on their own page. Add a CSV, Excel or JSON file there and Appbuilder copies it into the workspace's files folder and creates one table per sheet. The original file is never changed.</p>
              <p className="text-xs text-muted-foreground">The files connection is device-only: it stays on this machine unless packaged in a solution.</p>
              <div><Button type="button" size="sm" onClick={() => { onOpenChange(false); goPortal('datafiles') }} data-testid="open-data-files"><HardDrive /> Open Data files</Button></div>
            </div>
          ) : (
            <>
              <Field label="Connection name" htmlFor="conn-name"><Input id="conn-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'mysql' ? 'e.g. Sales database' : 'e.g. Budget sheet'} data-testid="connection-name" /></Field>
              {kind === 'mysql' && (
                <>
                  <div className="grid grid-cols-[1fr_96px] gap-3">
                    <Field label="Host" htmlFor="conn-host"><Input id="conn-host" value={host} onChange={(e) => setHost(e.target.value)} data-testid="conn-host" /></Field>
                    <Field label="Port" htmlFor="conn-port"><Input id="conn-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} data-testid="conn-port" /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Database" htmlFor="conn-db"><Input id="conn-db" value={database} onChange={(e) => setDatabase(e.target.value)} data-testid="conn-database" /></Field>
                    <Field label="User" htmlFor="conn-user"><Input id="conn-user" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} data-testid="conn-user" /></Field>
                  </div>
                  <Field label="Password" htmlFor="conn-password" hint={editing && connection?.hasSecret ? 'A password is stored. Leave blank to keep it, or type a new one to replace it.' : 'Stored encrypted on the server. Never shown again.'}>
                    <PasswordInput id="conn-password" value={password} onChange={setPassword} testId="conn-password" placeholder={editing && connection?.hasSecret ? 'Unchanged' : undefined} />
                  </Field>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Use SSL<span className="block text-xs text-muted-foreground">Encrypt the connection. Turn on for databases on other machines.</span></span>
                    <Switch checked={ssl} onCheckedChange={setSsl} aria-label="Use SSL" data-testid="conn-ssl" />
                  </label>
                </>
              )}
              {kind === 'gsheets' && (
                <>
                  <Field label="Spreadsheet URL or id" htmlFor="conn-sheet" hint={sheet.trim() && sheetId !== sheet.trim() ? `Spreadsheet id: ${sheetId}` : 'Paste the address of the Google spreadsheet from your browser.'}>
                    <Input id="conn-sheet" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." data-testid="conn-sheet" />
                  </Field>
                  <div className="grid gap-2">
                    <div className="text-xs font-medium">Service-account key (JSON)</div>
                    {keyInfo ? (
                      <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="service-account-card">
                        <div className="flex items-center gap-2"><KeyRound className="size-4 text-primary" /><span className="font-medium">{keyJson ? 'Key ready to save' : 'A key is stored on the server'}</span>{keyInfo.project && <Badge variant="outline">{keyInfo.project}</Badge>}</div>
                        <CopyEmail email={keyInfo.email} />
                        <p className="text-xs text-muted-foreground"><strong className="text-foreground">Share your sheet with this email as Editor.</strong> Open the spreadsheet, press Share, paste this address, choose Editor and send. Without that, Google answers "access denied". The private key is never displayed.</p>
                        <div><Button type="button" variant="ghost" size="xs" onClick={() => { setKeyInfo(null); setKeyJson('') }} data-testid="replace-key">Replace key</Button></div>
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        <textarea
                          value={paste}
                          onChange={(e) => onPaste(e.target.value)}
                          spellCheck={false}
                          autoComplete="off"
                          aria-label="Paste the service-account JSON"
                          placeholder="Paste the key file's contents here. It is read in your browser and hidden right away."
                          data-testid="conn-key-paste"
                          className="h-20 w-full resize-none rounded-md border border-input bg-muted/40 p-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                        />
                        <div className="flex items-center gap-2">
                          <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" aria-label="Choose service-account JSON file" data-testid="conn-key-file"
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              e.target.value = ''
                              if (f) f.text().then(acceptKey).catch(fail)
                            }} />
                          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><FileUp /> Choose JSON file</Button>
                          <span className="text-xs text-muted-foreground">Create it in Google Cloud: IAM, Service accounts, Keys.</span>
                        </div>
                        {keyError && <p className="text-xs text-destructive" role="alert" data-testid="key-error">{keyError}</p>}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {kind !== 'files' && <Button type="submit" disabled={busy || !valid} data-testid="connection-save">{busy && <Spinner />}{editing ? 'Save' : 'Add connection'}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ browse source tables */

function BrowseDialog({ connection, onOpenChange }: { connection: ConnectionRef | null; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [items, setItems] = useState<SourceTableInfo[] | null>(null)
  const [error, setError] = useState('')
  const [consent, setConsent] = useState<Record<string, boolean>>({})
  const [linking, setLinking] = useState('')
  const id = connection?.id
  useEffect(() => {
    if (!id) return
    let alive = true
    setItems(null)
    setError('')
    setConsent({})
    platform.tables.listSourceTables(id).then((r) => alive && setItems(r)).catch((e) => { if (alive) { setError(errMsg(e)); fail(e) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const noun = connection?.connector === 'gsheets' ? 'tab' : 'table'
  const link = async (it: SourceTableInfo) => {
    if (!connection) return
    setLinking(it.source)
    try {
      const t = await platform.tables.linkSourceTable(connection.id, it.source)
      toast(`Linked ${it.source} as table "${t.displayName}"`, 'success')
      setItems((l) => l?.filter((x) => x.source !== it.source) ?? l)
    } catch (e) {
      fail(e)
    } finally {
      setLinking('')
    }
  }
  return (
    <Dialog open={!!connection} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl" data-testid="browse-dialog">
        <DialogHeader>
          <DialogTitle>Browse {noun}s in {connection?.name}</DialogTitle>
          <DialogDescription>Existing {noun}s that are not yet tables in your workspace. Linking registers one without copying its rows.</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not list {noun}s</AlertTitle><AlertDescription className="text-destructive">{error}</AlertDescription></Alert>
        ) : items === null ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Spinner /> Reading {noun}s...</div>
        ) : items.length === 0 ? (
          <Empty icon={TableProperties} title={`No unlinked ${noun}s`} description={`Every ${noun} in this connection is already a table.`} />
        ) : (
          <ul className="grid gap-2" data-testid="source-table-list">
            {items.map((it) => {
              const needsId = !it.columns.some((c) => c.name.toLowerCase() === 'id')
              const ok = !needsId || consent[it.source]
              return (
                <li key={it.source} className="grid gap-2 rounded-lg border border-border p-3" data-testid={`source-${it.source}`}>
                  <div className="flex items-center gap-3">
                    <TableProperties className="size-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{it.source}</div>
                      <div className="truncate text-xs text-muted-foreground">{it.columns.length} columns{typeof it.rowCount === 'number' ? ` · ${it.rowCount} rows` : ''} · {it.columns.slice(0, 6).map((c) => c.name).join(', ')}{it.columns.length > 6 ? '...' : ''}</div>
                    </div>
                    <Button size="sm" disabled={!ok || linking === it.source} onClick={() => void link(it)} data-testid={`link-${it.source}`}>{linking === it.source ? <Spinner /> : <Plus />} Link</Button>
                  </div>
                  {needsId && (
                    <label className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs">
                      <Checkbox checked={!!consent[it.source]} onCheckedChange={(v) => setConsent((c) => ({ ...c, [it.source]: v === true }))} className="mt-px" data-testid={`link-consent-${it.source}`} />
                      <span>This {noun} has no <code className="font-mono">id</code> column. I agree that Appbuilder adds an <code className="font-mono">id</code> column{connection?.connector === 'mysql' ? ' and its system columns' : ''} to the {connection?.connector === 'gsheets' ? 'sheet tab' : 'table'} so rows can be told apart. Existing data is kept.</span>
                    </label>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ page */

function summary(c: ConnectionRef): string {
  const s = c.settings
  if (c.connector === 'mysql') return [s.user && `${s.user}@`, s.host, s.port && `:${s.port}`, s.database && `/${s.database}`].filter(Boolean).join('') || 'Not configured'
  if (c.connector === 'gsheets') return s.spreadsheetId ? `Spreadsheet ${s.spreadsheetId.length > 18 ? s.spreadsheetId.slice(0, 16) + '...' : s.spreadsheetId}` : 'No spreadsheet set'
  if (c.connector === 'files') return 'Copies of your files in the workspace folder'
  return ''
}

function StatusBadge({ c }: { c: ConnectionRef }) {
  if (c.status === 'connected') return <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Connected</Badge>
  if (c.status === 'error') return <Badge variant="destructive" title={c.lastError}>Error</Badge>
  return <Badge variant="secondary">Not configured</Badge>
}

export function Connections() {
  const connections = usePlatform((s) => s.connections)
  const mode = usePlatform((s) => s.mode)
  const caps = useCaps()
  const q = useSearch()
  const { fail, toast } = useToast()
  const [dlg, setDlg] = useState<{ conn: ConnectionRef | null } | null>(null)
  const [del, setDel] = useState<ConnectionRef | null>(null)
  const [browse, setBrowse] = useState<ConnectionRef | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; busy?: boolean }>>({})
  const demo = mode !== 'server'
  const canEdit = caps.isAdmin && !demo
  const list = connections.filter((c) => matches(q, c.name, connectorInfo(c.connector).label))

  const test = async (c: ConnectionRef) => {
    setResults((r) => ({ ...r, [c.id]: { ok: false, message: 'Testing...', busy: true } }))
    try {
      const r = await platform.connections.test(c.id)
      setResults((x) => ({ ...x, [c.id]: r }))
      toast(r.ok ? `${c.name}: ${r.message}` : `${c.name}: ${r.message}`, r.ok ? 'success' : 'error')
    } catch (e) {
      setResults((x) => ({ ...x, [c.id]: { ok: false, message: errMsg(e) } }))
      fail(e)
    }
  }
  const makeDefault = async (c: ConnectionRef) => {
    try {
      await platform.connections.setDefault(c.id)
      toast(`"${c.name}" is now the default store for new tables`, 'success')
    } catch (e) {
      fail(e)
    }
  }

  return (
    <div data-testid="connections-page">
      <div data-testid="page-connections">
        <PageHeader
          icon={Cable}
          title="Connections"
          subtitle="Where your tables are stored. The default connection holds new tables; others link existing databases, sheets and files."
          actions={canEdit && <Button size="sm" onClick={() => setDlg({ conn: null })} data-testid="new-connection-button"><Plus /> New connection</Button>}
        />
        {demo && (
          <Alert className="mb-4" data-testid="connections-demo-note">
            <Info />
            <AlertTitle>Demo mode</AlertTitle>
            <AlertDescription>MySQL and Google Sheets connections, testing and linking tables need the local server (<code className="font-mono text-xs">npm start</code>). In this browser demo your tables live in browser storage and files are turned into ordinary tables.</AlertDescription>
          </Alert>
        )}
        {!demo && !caps.isAdmin && (
          <Alert className="mb-4"><Info /><AlertDescription>Only administrators can change connections. You can see what exists.</AlertDescription></Alert>
        )}
        {connections.length === 0 ? (
          <Empty icon={Cloud} title="No connections yet" description={demo ? 'Connections are managed by the local server.' : 'Add a MySQL database or a Google Sheet.'} action={canEdit ? <Button onClick={() => setDlg({ conn: null })}><Plus /> New connection</Button> : undefined} />
        ) : list.length === 0 ? (
          <Empty icon={Cable} title="No matching connections" description={`Nothing matches "${q}".`} />
        ) : (
          <Panel className="overflow-hidden">
            <table className="w-full text-sm" data-testid="connections-list">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                  <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Kind</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const m = connectorInfo(c.connector)
                  const r = results[c.id]
                  const isFiles = c.connector === 'files'
                  const canBrowse = !demo && (c.connector === 'mysql' || c.connector === 'gsheets')
                  return (
                    <Fragment key={c.id}>
                      <tr className={cn('hover:bg-accent/40', !r && 'border-b border-border last:border-0')} data-testid={`connection-row-${c.id}`}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground"><m.icon className="size-4" /></span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5"><span className="font-medium">{c.name}</span><ConnectionFlags conn={c} /></div>
                              <div className="truncate text-xs text-muted-foreground">{summary(c)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{m.label}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <StatusBadge c={c} />
                            {c.hasSecret && <span title="A secret is stored encrypted on the server"><KeyRound className="size-3.5 text-muted-foreground" aria-label="Secret stored" /></span>}
                          </div>
                          {c.status === 'error' && c.lastError && <div className="mt-1 max-w-xs truncate text-xs text-destructive" title={c.lastError}>{c.lastError}</div>}
                        </td>
                        <td className="px-4 py-1.5">
                          <div className="flex flex-wrap justify-end gap-1">
                            {!demo && !isFiles && <Button variant="outline" size="xs" onClick={() => void test(c)} disabled={r?.busy} data-testid={`test-${c.id}`}>{r?.busy ? <Spinner /> : <Play />} Test</Button>}
                            {canBrowse && <Button variant="outline" size="xs" onClick={() => setBrowse(c)} data-testid={`browse-${c.id}`}><TableProperties /> Browse tables</Button>}
                            {canEdit && c.connector === 'mysql' && !c.isDefault && <Button variant="outline" size="xs" onClick={() => void makeDefault(c)} data-testid={`default-${c.id}`}><Star /> Set as default</Button>}
                            {isFiles && !demo && <Button variant="outline" size="xs" onClick={() => goPortal('datafiles')}><HardDrive /> Data files</Button>}
                            {canEdit && !isFiles && <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setDlg({ conn: c })} data-testid={`edit-${c.id}`}><Pencil /></Button>}
                            {canEdit && !isFiles && <Button variant="ghost" size="icon-sm" aria-label={`Delete ${c.name}`} disabled={c.isDefault} title={c.isDefault ? 'The default connection cannot be deleted. Make another one the default first.' : undefined} onClick={() => setDel(c)} data-testid={`delete-${c.id}`}><Trash2 /></Button>}
                          </div>
                        </td>
                      </tr>
                      {r && (
                        <tr className="border-b border-border last:border-0" data-testid={`test-result-${c.id}`}>
                          <td colSpan={4} className="px-4 pb-2.5">
                            <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs', r.busy ? 'bg-muted text-muted-foreground' : r.ok ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/10 text-destructive')} role="status">
                              {r.busy ? <Spinner className="mt-px" /> : r.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
                              <span className="min-w-0 break-words">{r.message}</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </Panel>
        )}
        <ConnectionDialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)} connection={dlg?.conn ?? null} onSaved={(c) => { if (c) void test(c) }} />
        <BrowseDialog connection={browse} onOpenChange={(o) => !o && setBrowse(null)} />
        <ConfirmDialog
          open={!!del}
          onOpenChange={(o) => !o && setDel(null)}
          title={`Delete connection "${del?.name ?? ''}"?`}
          description="Only the connection is removed; the data stays where it is. The server refuses while tables still use it."
          onConfirm={async () => { if (del) { await platform.connections.remove(del.id); toast('Connection deleted', 'success') } }}
        />
      </div>
    </div>
  )
}
