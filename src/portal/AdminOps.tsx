/**
 * Admin console > Server logs, Usage and Updates (package L; docs/admin/operations.md, docs/admin/upgrades.md).
 * Install administrators only; server mode only. Shapes and routes: src/platform/ops.ts.
 *  - Server logs: health checks, the server's log file (filter by level, time and text; follow; download), the log level,
 *    and the diagnostics bundle for support.
 *  - Usage: users, storage, tables and row counts per environment, job statistics.
 *  - Updates: the installed release, upload of a release ZIP (checksums, signature, release notes) and the command that
 *    applies it on the server.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity, CircleAlert, CircleCheck, Download, FileArchive, PackageCheck, RefreshCw, ScrollText, ShieldAlert, Trash2, TriangleAlert, Upload } from 'lucide-react'
import { PlatformError, usePlatform } from '@/platform'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import type { CheckStatus, DetailedHealth, LogLevelName, LogPage, StagedUpdate, UpdatesInfo, UsageReport } from '@/platform/ops'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Empty, Field, Panel, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { fmtBytes } from './AdminEnvironments'

type Title = (title: string, subtitle?: ReactNode, actions?: ReactNode) => ReactNode

/* ------------------------------------------------------------------ server calls */

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, raw?: Blob): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { [CSRF_HEADER]: '1', ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
  } catch {
    throw new PlatformError('unavailable', 'The server cannot be reached.')
  }
  if (!res.ok) {
    let b: { error?: { code?: string; message?: string } } | null = null
    try { b = await res.json() } catch { /* not JSON */ }
    throw new PlatformError((res.status === 403 ? 'denied' : res.status === 404 ? 'not-found' : res.status === 409 ? 'conflict' : res.status === 422 ? 'invalid' : 'storage') as PlatformError['code'], b?.error?.message ?? `The server answered ${res.status}.`)
  }
  return res
}
const json = async <T,>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, raw?: Blob): Promise<T> => (await (await call(method, path, body, raw)).json()) as T

async function saveDownload(res: Response, fallback: string): Promise<void> {
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const fetchHealth = () => json<DetailedHealth>('GET', '/admin/health')
const fetchUsage = () => json<UsageReport>('GET', '/admin/usage')
const fetchUpdates = () => json<UpdatesInfo>('GET', '/admin/updates')
function fetchLogs(q: { level?: string; q?: string; from?: string; to?: string; limit?: number }): Promise<LogPage> {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v))
  return json<LogPage>('GET', `/admin/logs?${p.toString()}`)
}

function ServerOnly({ what }: { what: string }) {
  return <Empty icon={ScrollText} title={`${what} needs the server`} description="The browser-only demo has no server, so there is nothing to show here." />
}

const TONE: Record<CheckStatus, string> = { ok: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', error: 'text-destructive' }
function CheckIcon({ s }: { s: CheckStatus }) {
  const I = s === 'ok' ? CircleCheck : s === 'warn' ? TriangleAlert : CircleAlert
  return <I className={cn('size-4 shrink-0', TONE[s])} />
}

/* ------------------------------------------------------------------ Server logs */

const LEVEL_TONE: Record<LogLevelName, 'secondary' | 'outline' | 'destructive'> = { info: 'outline', warn: 'secondary', error: 'destructive' }

export function ServerLogsSection({ title }: { title: Title }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const { toast, fail } = useToast()
  const [health, setHealth] = useState<DetailedHealth | null>(null)
  const [page, setPage] = useState<LogPage | null>(null)
  const [filter, setFilter] = useState({ level: '', q: '', from: '', to: '' })
  const [follow, setFollow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [bundling, setBundling] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const toIso = (v: string) => (v ? new Date(v).toISOString() : '')
      const [h, p] = await Promise.all([fetchHealth(), fetchLogs({ level: filter.level, q: filter.q.trim(), from: toIso(filter.from), to: toIso(filter.to), limit: 500 })])
      if (!alive.current) return
      setHealth(h)
      setPage(p)
    } catch (e) {
      if (alive.current) setError(errMsg(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [filter])

  useEffect(() => {
    alive.current = true
    if (server) void load()
    return () => { alive.current = false }
  }, [server, load])
  useEffect(() => {
    if (!follow || !server) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [follow, server, load])

  if (!server) return <ServerOnly what="The server log" />

  const setLevel = async (level: LogLevelName) => {
    try {
      await json('PUT', '/admin/logs/settings', { level })
      toast(`Log level: ${level}`, 'success')
      void load()
    } catch (e) { fail(e) }
  }
  const download = async () => {
    try { await saveDownload(await call('GET', '/admin/logs/download'), 'appbuilder-log.jsonl') } catch (e) { fail(e) }
  }
  const bundle = async () => {
    setBundling(true)
    try {
      await saveDownload(await call('POST', '/admin/diagnostics'), 'appbuilder-diagnostics.zip')
      toast('Diagnostics bundle downloaded. Passwords, keys and the setup code are removed; e-mail addresses are shortened.', 'success')
    } catch (e) { fail(e) } finally { setBundling(false) }
  }

  return (
    <div data-testid="admin-logs">
      {title('Server logs', 'The server\'s own log and health. Kept in the workspace logs folder, rotated by size.', (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy} data-testid="logs-refresh">{busy ? <Spinner /> : <RefreshCw />} Refresh</Button>
          <Button size="sm" variant="outline" onClick={() => void download()} disabled={!page?.enabled} data-testid="logs-download"><Download /> Download</Button>
          <Button size="sm" onClick={() => void bundle()} disabled={bundling} data-testid="logs-bundle">{bundling ? <Spinner /> : <FileArchive />} Diagnostics bundle</Button>
        </div>
      ))}
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}

      {health && (
        <Panel className="mb-4 p-4" data-testid="health-panel">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Health</span>
            <Badge variant={health.status === 'ok' ? 'secondary' : 'destructive'} data-testid="health-status">{health.status === 'ok' ? 'OK' : health.status === 'starting' ? 'Starting' : 'Degraded'}</Badge>
            <span className="ml-auto text-xs text-muted-foreground" data-testid="health-versions">
              Appbuilder {health.versions.app}{health.versions.commit !== 'dev' ? ` (${health.versions.commit.slice(0, 12)})` : ''} · Node.js {health.versions.node} · {health.versions.postgres ? `${/^postgres/i.test(health.versions.postgres) ? '' : 'PostgreSQL '}${health.versions.postgres} · ` : ''}schema {health.versions.schema.database ?? '?'}/{health.versions.schema.server} · up {Math.round(health.process.uptimeSeconds / 60)} min
            </span>
          </div>
          <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="health-checks">
            {health.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-sm" data-testid={`health-check-${c.key}`}>
                <CheckIcon s={c.status} />
                <span className="min-w-0"><span className="font-medium">{c.label}:</span> <span className="text-muted-foreground">{c.message}</span></span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            {health.live.connections} live connection{health.live.connections === 1 ? '' : 's'} ({health.live.users} user{health.live.users === 1 ? '' : 's'}) · memory {fmtBytes(health.process.rssBytes)} · checked {fmtRelative(health.checkedAt)}
          </p>
        </Panel>
      )}

      <Panel className="mb-3 grid grid-cols-[8rem_minmax(0,1.6fr)_1fr_1fr_auto] items-end gap-3 p-3" data-testid="logs-filters">
        <Field label="Level" htmlFor="logs-level">
          <select id="logs-level" value={filter.level} onChange={(e) => setFilter((f) => ({ ...f, level: e.target.value }))} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="logs-level">
            <option value="">All</option><option value="warn">Warnings and errors</option><option value="error">Errors</option>
          </select>
        </Field>
        <Field label="Text or request id" htmlFor="logs-q"><Input id="logs-q" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} placeholder="for example: backup, ERROR, 4f2a9c1e" data-testid="logs-q" /></Field>
        <Field label="From" htmlFor="logs-from"><Input id="logs-from" type="datetime-local" value={filter.from} onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))} /></Field>
        <Field label="To" htmlFor="logs-to"><Input id="logs-to" type="datetime-local" value={filter.to} onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))} /></Field>
        <label className="flex h-8 items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="logs-follow" /> Follow</label>
      </Panel>

      {page && !page.enabled && <p className="mb-3 text-sm text-muted-foreground">File logging is off on this server (APPBUILDER_LOG_FILE=off, or the development server). The console still has the log.</p>}
      <Panel className="overflow-hidden">
        <table className="w-full table-fixed text-sm" data-testid="logs-table">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="w-44 px-3 py-2">Time (your time)</th><th className="w-20 px-3 py-2">Level</th><th className="px-3 py-2">Message</th><th className="w-36 px-3 py-2">Request</th>
            </tr>
          </thead>
          <tbody>
            {(page?.items ?? []).map((e, i) => (
              <tr key={`${e.t}-${i}`} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-1.5 text-xs" title={e.t}>{fmtDate(e.t)}</td>
                <td className="px-3 py-1.5"><Badge variant={LEVEL_TONE[e.l]} className="text-[10px] uppercase">{e.l}</Badge></td>
                <td className="whitespace-pre-wrap break-words px-3 py-1.5 font-mono text-[11px]">{e.m}</td>
                <td className="truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {e.rid ? <button type="button" className="hover:underline" title="Show every line of this request" onClick={() => setFilter((f) => ({ ...f, q: e.rid! }))}>{e.rid}</button> : e.job ? `job ${e.job}` : '-'}
                </td>
              </tr>
            ))}
            {page && page.items.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">No lines match these filters.</td></tr>}
            {!page && busy && <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground"><Spinner className="mr-2 inline" /> Loading...</td></tr>}
          </tbody>
        </table>
      </Panel>
      {page && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{page.items.length} line{page.items.length === 1 ? '' : 's'}{page.truncated ? ' (the newest 500 that match; narrow the filter for older ones)' : ''} · {page.files.length} file{page.files.length === 1 ? '' : 's'}, {fmtBytes(page.files.reduce((s, f) => s + f.bytes, 0))}</span>
          <span className="ml-auto flex items-center gap-2">
            Record from level
            <select value={page.level} disabled={page.levelFromEnv} onChange={(e) => void setLevel(e.target.value as LogLevelName)} className="h-7 rounded-md border border-input bg-background px-2 text-xs" data-testid="logs-setting" title={page.levelFromEnv ? 'Set by APPBUILDER_LOG_LEVEL in the service configuration' : 'What the server writes to its log file'}>
              <option value="info">Info</option><option value="warn">Warnings</option><option value="error">Errors</option>
            </select>
            {page.levelFromEnv && <span>(set by APPBUILDER_LOG_LEVEL)</span>}
          </span>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ Usage */

function Stat({ label, value, hint, testid }: { label: string; value: ReactNode; hint?: string; testid?: string }) {
  return (
    <Panel className="p-3" data-testid={testid}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </Panel>
  )
}

export function UsageSection({ title }: { title: Title }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const [r, setR] = useState<UsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const load = useCallback(() => {
    setBusy(true)
    setError('')
    fetchUsage().then(setR, (e) => setError(errMsg(e))).finally(() => setBusy(false))
  }, [])
  useEffect(() => { if (server) load() }, [server, load])
  if (!server) return <ServerOnly what="Usage" />
  return (
    <div data-testid="admin-usage">
      {title('Usage', 'Who uses this install and how big the data is. Counted now; nothing is collected or sent anywhere.', (
        <Button size="sm" variant="outline" onClick={load} disabled={busy} data-testid="usage-refresh">{busy ? <Spinner /> : <RefreshCw />} Refresh</Button>
      ))}
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
      {r && (
        <>
          <h3 className="mb-2 text-sm font-semibold">People</h3>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-6" data-testid="usage-users">
            <Stat label="Active accounts" value={r.users.active} hint={`${r.users.disabled} disabled`} testid="usage-active" />
            <Stat label="Online now" value={r.users.onlineNow} />
            <Stat label="Signed in, 24 hours" value={r.users.signedIn.day} />
            <Stat label="Signed in, 7 days" value={r.users.signedIn.week} />
            <Stat label="Signed in, 30 days" value={r.users.signedIn.month} />
            <Stat label="Service accounts" value={r.users.serviceAccounts} />
          </div>
          <h3 className="mb-2 text-sm font-semibold">Storage</h3>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-6" data-testid="usage-storage">
            <Stat label="Database" value={r.storage.databaseBytes === null ? '-' : fmtBytes(r.storage.databaseBytes)} />
            <Stat label="Workspace folder" value={fmtBytes(r.storage.workspaceBytes)} />
            <Stat label="Attachments" value={fmtBytes(r.storage.attachmentsBytes)} />
            <Stat label="Data files" value={fmtBytes(r.storage.filesBytes)} />
            <Stat label="Backups" value={fmtBytes(r.storage.backupsBytes)} />
            <Stat label="Logs" value={fmtBytes(r.storage.logsBytes)} />
          </div>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Tables by environment</h3>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Show system tables</label>
          </div>
          {r.environments.map((e) => {
            const rows = e.tables.filter((t) => showSystem || !t.system).sort((a, b) => b.rows - a.rows)
            return (
              <Panel key={e.id} className="mb-4 overflow-hidden" data-testid={`usage-env-${e.id}`}>
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm">
                  <span className="font-semibold">{e.name}</span>
                  <span className="text-xs text-muted-foreground">{e.tables.filter((t) => !t.system).length} tables · {fmtBytes(e.schemaBytes)}</span>
                  {e.jobs && <span className="ml-auto text-xs text-muted-foreground">Jobs, last 24 hours: {e.jobs.succeeded24h} done, {e.jobs.failed24h} failed · {e.jobs.queued} queued · {e.jobs.dead} dead</span>}
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="px-3 py-1.5">Table</th><th className="w-36 px-3 py-1.5 text-right">Rows</th><th className="w-28 px-3 py-1.5 text-right">Size</th></tr></thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.name} className="border-b border-border last:border-0">
                        <td className="px-3 py-1 font-mono text-[12px]">{t.name}{t.system && <Badge variant="outline" className="ml-2 text-[10px]">system</Badge>}</td>
                        <td className="px-3 py-1 text-right tabular-nums" title={t.approximate ? 'Estimated by PostgreSQL (large table)' : 'Counted'}>{t.approximate ? '~' : ''}{t.rows.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{fmtBytes(t.bytes)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-muted-foreground">No tables yet.</td></tr>}
                  </tbody>
                </table>
                {e.jobs && e.jobs.byType.length > 0 && (
                  <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                    {e.jobs.byType.map((j) => `${j.type}: ${j.succeeded24h} done${j.failed24h ? `, ${j.failed24h} failed` : ''}`).join(' · ')}
                  </div>
                )}
              </Panel>
            )
          })}
          <p className="text-xs text-muted-foreground">Rows are counted exactly up to 100,000 per table; above that PostgreSQL's estimate is shown with ~. Generated {fmtRelative(r.generatedAt)}.</p>
        </>
      )}
      {!r && busy && <p className="text-sm text-muted-foreground"><Spinner className="mr-2 inline" /> Counting...</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ Updates */

const SIGNATURE: Record<StagedUpdate['signature']['state'], { label: string; tone: 'secondary' | 'outline' | 'destructive' }> = {
  valid: { label: 'Signed by a trusted key', tone: 'secondary' },
  unsigned: { label: 'Not signed', tone: 'outline' },
  untrusted: { label: 'Signed by an unknown key', tone: 'destructive' },
  invalid: { label: 'Signature not valid', tone: 'destructive' },
}

export function UpdatesSection({ title }: { title: Title }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const { toast, fail } = useToast()
  const [info, setInfo] = useState<UpdatesInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const load = useCallback(() => {
    setBusy(true)
    setError('')
    fetchUpdates().then(setInfo, (e) => setError(errMsg(e))).finally(() => setBusy(false))
  }, [])
  useEffect(() => { if (server) load() }, [server, load])
  if (!server) return <ServerOnly what="Updates" />

  const upload = async (f: File) => {
    setUploading(true)
    try {
      const s = await json<StagedUpdate>('POST', '/admin/updates/upload', undefined, f)
      toast(s.applicable ? `Appbuilder ${s.version} is checked and staged.` : `Appbuilder ${s.version} cannot be applied: ${s.problems[0] ?? 'see below'}`, s.applicable ? 'success' : 'error')
      load()
    } catch (e) { fail(e) } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const discard = async () => {
    try { await json('DELETE', '/admin/updates/staged'); load() } catch (e) { fail(e) }
  }
  const s = info?.staged ?? null

  return (
    <div data-testid="admin-updates">
      {title('Updates', 'Install a new Appbuilder release. Nothing is downloaded from the internet: you bring the release file.', (
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} data-testid="updates-file" />
          <Button size="sm" variant="outline" onClick={load} disabled={busy}>{busy ? <Spinner /> : <RefreshCw />} Refresh</Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="updates-upload">{uploading ? <Spinner /> : <Upload />} Upload release ZIP</Button>
        </div>
      ))}
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
      {info && (
        <Panel className="mb-4 p-4" data-testid="updates-current">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span><span className="text-muted-foreground">Installed:</span> <span className="font-semibold">Appbuilder {info.current.version}</span></span>
            <span><span className="text-muted-foreground">Commit:</span> <code className="font-mono text-xs">{info.current.commit.slice(0, 12)}</code></span>
            {info.current.built && <span><span className="text-muted-foreground">Built:</span> {fmtDate(info.current.built)}</span>}
            <span><span className="text-muted-foreground">Database schema:</span> {info.current.schemaVersion}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {info.current.trustedKeys.length
              ? <>Accepts releases signed with {info.current.trustedKeys.map((k) => <code key={k.id} className="mx-0.5 font-mono">{k.id}</code>)}.</>
              : 'This build trusts no release key (a development build): unsigned releases are accepted, so check where a file comes from.'}
            {!info.installed && ' This server was not set up by the installer: update it from its source folder (see the administrator guide, Upgrades).'}
          </p>
        </Panel>
      )}

      {s ? (
        <Panel className="mb-4 p-4" data-testid="updates-staged">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <PackageCheck className="size-5 text-muted-foreground" />
            <span className="text-base font-semibold">Appbuilder {s.version}</span>
            <code className="font-mono text-xs text-muted-foreground">{s.commit.slice(0, 12)}</code>
            <Badge variant={s.checksums === 'ok' ? 'secondary' : 'destructive'} data-testid="updates-checksums">{s.checksums === 'ok' ? `${s.files} files match their checksums` : 'Checksums do not match'}</Badge>
            <Badge variant={SIGNATURE[s.signature.state].tone} data-testid="updates-signature">{SIGNATURE[s.signature.state].label}{s.signature.keyId ? ` (${s.signature.keyId})` : ''}</Badge>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void discard()} data-testid="updates-discard"><Trash2 /> Discard</Button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">Built {fmtDate(s.built)} · needs Node.js {s.node} · database schema {s.schemaVersion}{info && s.schemaVersion > info.current.schemaVersion ? ' (the database is upgraded; an install backup is taken first)' : ''} · uploaded {fmtRelative(s.stagedAt)}</p>
          {s.problems.length > 0 && (
            <ul className="mb-3 grid gap-1" data-testid="updates-problems">
              {s.problems.map((p) => <li key={p} className="flex items-start gap-2 text-sm text-destructive"><ShieldAlert className="mt-0.5 size-4 shrink-0" /> {p}</li>)}
            </ul>
          )}
          {s.applicable && info?.applyCommand && (
            <div className="mb-3 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="updates-apply">
              <p className="mb-1.5">To install it, run on the server (as {info.applyCommand.startsWith('sudo') ? 'root' : 'an administrator'}):</p>
              <code className="block select-all whitespace-pre-wrap break-all rounded bg-background px-2 py-1 font-mono text-xs">{info.applyCommand}</code>
              <p className="mt-1.5 text-xs text-muted-foreground">It checks the package again, stops Appbuilder (users are interrupted for about a minute), switches to the new release, starts it and checks that it works; if not, it puts the current release back by itself. The web page cannot do this: the server's own account is not allowed to change its program files.</p>
            </div>
          )}
          {s.releaseNotes && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs" data-testid="updates-notes">{s.releaseNotes}</pre>}
        </Panel>
      ) : info && (
        <Empty icon={Upload} title="No release uploaded" description="Upload appbuilder-<version>.zip to check it and read its release notes before installing it." />
      )}

      {info && info.history.length > 0 && (
        <>
          <h3 className="mb-2 mt-4 text-sm font-semibold">History</h3>
          <Panel className="overflow-hidden">
            <table className="w-full text-sm" data-testid="updates-history">
              <tbody>
                {info.history.map((h, i) => (
                  <tr key={`${h.at}-${i}`} className="border-b border-border align-top last:border-0">
                    <td className="w-44 px-3 py-2 text-xs">{fmtDate(h.at)}</td>
                    <td className="w-48 px-3 py-2 text-xs">{h.from} → {h.to}</td>
                    <td className="w-28 px-3 py-2"><Badge variant={h.result === 'updated' ? 'secondary' : 'destructive'}>{h.result === 'updated' ? 'Updated' : h.result === 'rolled-back' ? 'Rolled back' : 'Failed'}</Badge></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{h.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  )
}
