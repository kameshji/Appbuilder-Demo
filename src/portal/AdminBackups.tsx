/**
 * Admin console > Backups (docs/admin/backup-and-restore.md; package J): health, the list of backups with their
 * size, state and contents, "Back up now", upload and download, restore (as a new environment, in place, or selected
 * tables), browsing a table of a backup, and the settings (folder, schedules, retention, passphrase, off-site copy,
 * automatic backups before risky changes, restore test). Install administrators only; server mode only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive, ArchiveRestore, CircleAlert, CircleCheck, Clock, Download, Eye, FileKey2, FlaskConical, HardDriveUpload, KeyRound, Lock, Pin, PinOff, Play, RefreshCw,
  ShieldCheck, Table2, Trash2, TriangleAlert, Upload,
} from 'lucide-react'
import { ENVIRONMENT_TYPE_LABEL, usePlatform } from '@/platform'
import type {
  BackupContents, BackupHealth, BackupInfo, BackupOp, BackupRowsPage, BackupSettings, BackupSettingsInput, ScheduleSetting, TableRestorePlan,
} from '@/platform/backup'
import { useLiveTopic } from '@/platform/useLive'
import { go } from '@/router'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Empty, Field, Panel, Segmented, errMsg, fmtDate, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import { fmtBytes } from './AdminEnvironments'
import {
  backupNow, browseBackup, deleteBackup, downloadBackup, fetchBackupHealth, fetchBackupSettings, fetchBackups, fetchContents, isBackupRefusal, needsPassphrase, needsReauth,
  planTableRestore, reauthenticate, restoreBackup, restoreTables, runRestoreTest, saveBackupSettings, updateBackup, uploadBackup, verifyBackup, waitForOp, downloadEnvironmentData } from './backupApi'

type Title = (title: string, subtitle?: ReactNode, actions?: ReactNode) => ReactNode

const STATE: Record<BackupInfo['state'], { label: string; tone: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  queued: { label: 'Waiting', tone: 'outline' }, running: { label: 'Running', tone: 'default' }, verifying: { label: 'Checking', tone: 'default' },
  ok: { label: 'Verified', tone: 'secondary' }, failed: { label: 'Failed', tone: 'destructive' }, missing: { label: 'File missing', tone: 'destructive' }, uploaded: { label: 'Not checked yet', tone: 'outline' },
}
const TRIGGER: Record<BackupInfo['trigger'], string> = {
  manual: 'Manual', schedule: 'Scheduled', 'pre-upgrade': 'Before an upgrade', 'pre-delete': 'Before a delete', 'pre-restore': 'Before a restore', 'pre-migration': 'Before a server upgrade', upload: 'Uploaded',
}
const PHASE: Record<string, string> = {
  snapshot: 'Taking a consistent snapshot', database: 'Database', files: 'Attachments and data files', finishing: 'Finishing', verifying: 'Checking the archive', checking: 'Checking the archive',
  restoring: 'Restoring rows', 'safety-backup': 'Safety backup of what is there now', 'swap-files': 'Putting the files in place', starting: 'Starting', done: 'Done',
}

const pct = (p?: { done: number; total: number }) => (p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null)
const scopeLabel = (b: BackupInfo) => (b.kind === 'install' ? 'Whole install' : b.environmentName ?? b.environmentId ?? 'Environment')

function ServerOnly() {
  return <Empty icon={Archive} title="Backups need the server" description="Backups are made by the Appbuilder server from its PostgreSQL database and workspace folder. The browser-only demo keeps everything in this browser: export packages to keep a copy." />
}

/* ------------------------------------------------------------------ health (also on the Admin console home) */

export function BackupHealthBanner({ compact, health }: { compact?: boolean; health?: BackupHealth | null }) {
  const caps = useCaps()
  const [own, setH] = useState<BackupHealth | null>(null)
  const h = health ?? own
  useEffect(() => {
    if (!caps.server || !caps.isInstallAdmin || health !== undefined) return
    let alive = true
    const load = () => fetchBackupHealth().then((x) => alive && setH(x)).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [caps.server, caps.isInstallAdmin, health])
  if (!h) return null
  const bad = h.enabled && (h.stale || !!h.lastFailure)
  const Icon = !h.enabled ? CircleAlert : bad ? TriangleAlert : CircleCheck
  return (
    <button
      type="button"
      onClick={() => go({ page: 'admin', id: 'backups' })}
      data-testid="backup-health"
      data-state={!h.enabled ? 'off' : bad ? 'bad' : 'ok'}
      className={cn('flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm',
        !h.enabled ? 'border-border bg-muted/40 text-muted-foreground' : bad ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100', compact && 'py-1.5 text-xs')}
    >
      <Icon className="size-4 shrink-0" />
      <span className="font-medium">Backups:</span>
      <span className="min-w-0 flex-1 truncate">{h.message}</span>
      {h.running.length > 0 && <span className="flex items-center gap-1 text-xs"><Spinner className="size-3" /> running</span>}
      {h.nextRun && <span className="hidden text-xs opacity-80 md:inline">Next: {fmtDate(h.nextRun)}</span>}
    </button>
  )
}

/* ------------------------------------------------------------------ the section */

export function BackupsSection({ title }: { title: Title }) {
  const caps = useCaps()
  const me = usePlatform((s) => s.session?.user.id ?? null)
  const { fail, toast } = useToast()
  const [data, setData] = useState<{ items: BackupInfo[]; health: BackupHealth; ops: BackupOp[] } | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('list')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [now, setNow] = useState(false)
  const [restoreOf, setRestoreOf] = useState<BackupInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [reauth, setReauth] = useState<null | (() => Promise<void>)>(null)

  const load = useCallback(() => {
    if (!caps.server || !caps.isInstallAdmin) return
    fetchBackups().then((d) => { setData(d); setError('') }).catch((e) => setError(errMsg(e)))
  }, [caps.server, caps.isInstallAdmin])
  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])
  // progress pushed over the live hub: patch the row in place, reload when something finishes
  useLiveTopic(me ? `user:${me}` : null, (m) => {
    if (m.t !== 'user' || m.event !== 'backup') return
    const b = m.backup
    if (b) {
      setData((d) => {
        if (!d) return d
        const has = d.items.some((x) => x.id === b.id)
        return { ...d, items: has ? d.items.map((x) => (x.id === b.id ? { ...x, ...b } : x)) : [b, ...d.items] }
      })
      if (!['queued', 'running', 'verifying'].includes(b.state)) load()
    }
    if (m.op) setData((d) => (d ? { ...d, ops: [m.op!, ...d.ops.filter((o) => o.id !== m.op!.id)] } : d))
  }, null)

  if (!caps.server) return <div data-testid="admin-backups">{title('Backups')}<ServerOnly /></div>
  const withReauth = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      if (needsReauth(e)) setReauth(() => fn)
      else fail(e)
    }
  }
  const exportPanel = caps.isAdmin && (
    <Panel className="mb-4 flex flex-wrap items-center gap-3 p-3 text-sm" data-testid="export-data">
      <div className="min-w-0 flex-1">
        <div className="font-medium">Export environment data</div>
        <div className="text-xs text-muted-foreground">Every table of this environment as CSV files in one ZIP, with a list of the attachment files and a manifest. For moving data to another system or keeping a readable copy; it is not a backup (use a backup to restore). Rows in recycle bins are left out unless you include them.</div>
      </div>
      <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} data-testid="export-data-include-deleted" />Include deleted rows</label>
      <Button size="sm" variant="outline" onClick={() => void withReauth(() => downloadEnvironmentData({ includeDeleted }))} data-testid="export-data-button"><Download /> Export data</Button>
    </Panel>
  )

  if (!caps.isInstallAdmin) {
    return <div data-testid="admin-backups">{title('Backups')}{exportPanel}<Empty icon={Lock} title="Install administrators only" description="Backups contain every environment's data, so only install administrators can see, make and restore them." /><ReauthDialog retry={reauth} onClose={() => setReauth(null)} /></div>
  }
  const upload = async (f: File | undefined) => {
    if (!f) return
    setBusy(true)
    try {
      const b = await uploadBackup(f)
      toast(`Uploaded ${b.fileName}${b.encrypted ? ': enter its passphrase to check it' : ''}`, 'success')
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const running = data?.ops.filter((o) => o.state === 'running') ?? []
  return (
    <div data-testid="admin-backups">
      {title(
        'Backups',
        'Backups of the whole install or one environment: the database, attachments and data files in one archive, checked after it is written.',
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={load} aria-label="Refresh"><RefreshCw /></Button>
          <input ref={fileRef} type="file" accept=".abbak" className="sr-only" data-testid="backup-upload-input" aria-label="Upload a backup" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = '' }} />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="backup-upload">{busy ? <Spinner /> : <Upload />} Upload</Button>
          <Button size="sm" onClick={() => setNow(true)} data-testid="backup-now"><Archive /> Back up now</Button>
        </div>,
      )}
      {error && <p className="mb-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mb-4"><BackupHealthBanner health={data?.health ?? null} /></div>
      {exportPanel}
      {running.map((o) => <OpProgress key={o.id} op={o} />)}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="list" data-testid="backup-tab-list">Backups</TabsTrigger>
          <TabsTrigger value="schedule" data-testid="backup-tab-schedule">Schedule and retention</TabsTrigger>
          <TabsTrigger value="settings" data-testid="backup-tab-settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <BackupList items={data?.items ?? null} onRestore={setRestoreOf} onChanged={load} withReauth={withReauth} />
        </TabsContent>
        <TabsContent value="schedule"><ScheduleTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab /></TabsContent>
      </Tabs>
      <BackupNowDialog open={now} onOpenChange={setNow} onStarted={load} />
      {restoreOf && <RestoreDialog backup={restoreOf} onClose={() => { setRestoreOf(null); load() }} />}
      <ReauthDialog retry={reauth} onClose={() => setReauth(null)} />
    </div>
  )
}

function OpProgress({ op }: { op: BackupOp }) {
  const p = pct(op.progress)
  const label = op.kind === 'restore' ? `Restoring ${op.mode === 'new' ? `as a new environment (${op.targetEnvironment})` : `"${op.targetEnvironment}" in place`}` : op.kind === 'restore-tables' ? 'Restoring tables' : op.kind === 'restore-test' ? 'Restore test' : 'Checking a backup'
  return (
    <Panel className="mb-3 p-3" data-testid={`backup-op-${op.id}`}>
      <div className="mb-1.5 flex items-center gap-2 text-sm"><Spinner className="size-3.5" /> <span className="font-medium">{label}</span><span className="text-xs text-muted-foreground">{PHASE[op.phase ?? ''] ?? op.phase}{op.progress?.message ? `: ${op.progress.message}` : ''}</span></div>
      <Progress value={p ?? 5} className={cn(p === null && 'animate-pulse')} />
    </Panel>
  )
}

/* ------------------------------------------------------------------ list */

function BackupList({ items, onRestore, onChanged, withReauth }: { items: BackupInfo[] | null; onRestore(b: BackupInfo): void; onChanged(): void; withReauth(fn: () => Promise<void>): Promise<void> }) {
  const { fail, toast } = useToast()
  const [del, setDel] = useState<BackupInfo | null>(null)
  const [verifyOf, setVerifyOf] = useState<BackupInfo | null>(null)
  if (!items) return <div className="py-10 text-center text-sm text-muted-foreground"><Spinner className="mr-2 inline" /> Loading...</div>
  if (!items.length) return <Empty icon={Archive} title="No backups yet" description="Press Back up now, or wait for the nightly backup. Each backup is checked (every file against its checksum, rows counted again) right after it is written." />
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); toast(done, 'success'); onChanged() } catch (e) { fail(e) }
  }
  return (
    <>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="backups-table">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-2.5">Made</th><th className="px-3 py-2.5">Of</th><th className="px-3 py-2.5">How</th><th className="px-3 py-2.5">Size</th><th className="px-3 py-2.5">State</th><th className="w-[1%] px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {items.map((b) => {
              const p = pct(b.progress)
              const inProgress = ['queued', 'running', 'verifying'].includes(b.state)
              return (
                <tr key={b.id} className="border-b border-border align-top last:border-0" data-testid={`backup-row-${b.id}`} data-state={b.state}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium" title={b.createdOn}>{fmtDate(b.createdOn)}</div>
                    <div className="text-xs text-muted-foreground">{fmtRelative(b.createdOn)}{b.createdBy ? ` · ${b.createdBy.name}` : ''}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">{scopeLabel(b)}{b.pinned && <Pin className="size-3.5 text-muted-foreground" aria-label="pinned" />}</div>
                    {b.summary && <div className="text-xs text-muted-foreground">{b.summary.environments.length} environment{b.summary.environments.length === 1 ? '' : 's'}, {b.summary.rows.toLocaleString()} rows, {b.summary.environments.reduce((a, e) => a + e.attachments, 0)} attachments</div>}
                    {b.note && <div className="text-xs italic text-muted-foreground">{b.note}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    <div>{TRIGGER[b.trigger]}</div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      {b.method === 'pg_dump' ? `pg_dump${b.summary?.pgDump ? ` ${b.summary.pgDump}` : ''}` : b.method === 'builtin' ? 'built-in exporter' : ''}
                      {b.encrypted && <span className="flex items-center gap-0.5" title="Encrypted with a passphrase"><Lock className="size-3" /> encrypted</span>}
                      {b.includesKey && <span className="flex items-center gap-0.5 text-amber-700 dark:text-amber-300" title="Contains the install's encryption key: keep this file safe"><KeyRound className="size-3" /> key</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{fmtBytes(b.sizeBytes)}</td>
                  <td className="px-3 py-2.5">
                    <Badge variant={STATE[b.state].tone} data-testid={`backup-state-${b.id}`}>{STATE[b.state].label}</Badge>
                    {inProgress && <div className="mt-1.5 w-40"><Progress value={p ?? 5} /><div className="mt-0.5 text-[11px] text-muted-foreground">{PHASE[b.progress?.phase ?? ''] ?? 'Waiting for the job worker'}</div></div>}
                    {b.error && <div className="mt-1 max-w-72 text-xs text-destructive">{b.error}</div>}
                    {b.offsite && <div className={cn('mt-1 text-[11px]', b.offsite.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>Off-site: {b.offsite.state === 'ok' ? 'copied and checked' : b.offsite.error ?? b.offsite.state}</div>}
                    {b.restoreTestedOn && <div className={cn('mt-0.5 text-[11px]', b.restoreTestError ? 'text-destructive' : 'text-muted-foreground')}>Restore test {fmtRelative(b.restoreTestedOn)}: {b.restoreTestError ? 'failed' : 'passed'}</div>}
                    {b.retention && !inProgress && <div className="mt-0.5 max-w-72 text-[11px] text-muted-foreground" title="Retention">Kept: {b.retention}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="outline" disabled={!['ok', 'uploaded'].includes(b.state)} onClick={() => onRestore(b)} data-testid={`backup-restore-${b.id}`}><ArchiveRestore /> Restore</Button>
                      <Button size="icon-sm" variant="ghost" disabled={!['ok', 'uploaded'].includes(b.state)} title="Download" aria-label="Download" onClick={() => void withReauth(() => downloadBackup(b.id))} data-testid={`backup-download-${b.id}`}><Download /></Button>
                      <Button size="icon-sm" variant="ghost" disabled={inProgress || b.state === 'missing'} title="Check again" aria-label="Check again" onClick={() => (b.encrypted ? setVerifyOf(b) : void act(() => verifyBackup(b.id), 'Checking the backup'))}><ShieldCheck /></Button>
                      <Button size="icon-sm" variant="ghost" title={b.pinned ? 'Unpin (retention may remove it)' : 'Pin (never removed by retention)'} aria-label={b.pinned ? 'Unpin' : 'Pin'} onClick={() => void act(() => updateBackup(b.id, { pinned: !b.pinned }), b.pinned ? 'Unpinned' : 'Pinned')}>{b.pinned ? <PinOff /> : <Pin />}</Button>
                      <Button size="icon-sm" variant="ghost" disabled={b.state === 'running' || b.state === 'verifying'} title="Delete" aria-label="Delete" onClick={() => setDel(b)}><Trash2 /></Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>
      <p className="mt-2 text-xs text-muted-foreground">Archives are kept in the backup folder on the server (Settings). A backup on the same disk does not survive a disk failure: set an off-site folder, or copy them elsewhere with rclone or restic (see the administrator guide).</p>
      <Dialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this backup?</DialogTitle>
            <DialogDescription>{del ? `${del.fileName} (${fmtBytes(del.sizeBytes)}) is removed from the backup folder${del.offsite?.path ? ' and the off-site folder' : ''}. It cannot be restored afterwards.` : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDel(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { const d = del!; setDel(null); void act(() => deleteBackup(d.id), 'Backup deleted') }} data-testid="backup-delete-confirm"><Trash2 /> Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PassphraseDialog open={!!verifyOf} title="Check an encrypted backup" onClose={() => setVerifyOf(null)} onSubmit={async (p) => { await verifyBackup(verifyOf!.id, p); toast('Checking the backup', 'success'); setVerifyOf(null); onChanged() }} />
    </>
  )
}

function PassphraseDialog({ open, title, onClose, onSubmit }: { open: boolean; title: string; onClose(): void; onSubmit(p: string): Promise<void> }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setV(''); setErr('') } }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>The passphrase is never stored with the backup. Without it the backup cannot be read.</DialogDescription></DialogHeader>
        <Field label="Passphrase" htmlFor="bk-pass"><Input id="bk-pass" type="password" value={v} onChange={(e) => setV(e.target.value)} autoFocus data-testid="backup-passphrase" /></Field>
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!v || busy} onClick={async () => { setBusy(true); setErr(''); try { await onSubmit(v) } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) } }}>{busy && <Spinner />} Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReauthDialog({ retry, onClose }: { retry: null | (() => Promise<void>); onClose(): void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (retry) { setPw(''); setErr('') } }, [retry])
  return (
    <Dialog open={!!retry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="backup-reauth">
        <DialogHeader><DialogTitle>Confirm it is you</DialogTitle><DialogDescription>Downloading a backup gives a copy of every environment's data. Enter your password (or a code from your authenticator app) first.</DialogDescription></DialogHeader>
        <Field label="Password or code" htmlFor="bk-reauth"><Input id="bk-reauth" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" /></Field>
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!pw || busy} onClick={async () => { setBusy(true); setErr(''); try { await reauthenticate(pw); await retry!(); onClose() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) } }}>{busy && <Spinner />} Confirm and download</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ back up now */

function BackupNowDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange(o: boolean): void; onStarted(): void }) {
  const envs = usePlatform((s) => s.environments)
  const { fail, toast } = useToast()
  const [scope, setScope] = useState('install')
  const [encrypt, setEncrypt] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [includeKey, setIncludeKey] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setScope('install'); setEncrypt(false); setPass(''); setPass2(''); setIncludeKey(false); setNote('') } }, [open])
  const passOk = !encrypt || (pass.length >= 10 && pass === pass2)
  const run = async () => {
    setBusy(true)
    try {
      const b = await backupNow({ scope, ...(encrypt ? { passphrase: pass } : {}), ...(scope === 'install' && includeKey ? { includeKey: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
      toast(`Backup started: ${b.fileName}`, 'success')
      onOpenChange(false)
      onStarted()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg" data-testid="backup-now-dialog">
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
          <DialogDescription>Runs as a job on the server; people can keep working. The archive is checked right after it is written.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="What">
            <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="backup-now-scope">
              <option value="install">The whole install (accounts, settings and every environment)</option>
              {envs.filter((e) => !e.state || e.state === 'ready').map((e) => <option key={e.id} value={e.id}>Environment: {e.name} ({ENVIRONMENT_TYPE_LABEL[e.type]})</option>)}
            </select>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={encrypt} onCheckedChange={(v) => setEncrypt(v === true)} className="mt-0.5" data-testid="backup-now-encrypt" />
            <span>Encrypt with a passphrase<span className="block text-xs text-muted-foreground">AES-256. The passphrase is not stored anywhere: without it, nobody (you included) can restore this backup.</span></span>
          </label>
          {encrypt && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Passphrase (10 characters or more)" htmlFor="bk-now-pass"><Input id="bk-now-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" data-testid="backup-now-pass" /></Field>
              <Field label="Again" htmlFor="bk-now-pass2" hint={pass2 && pass !== pass2 ? <span className="text-destructive">Does not match.</span> : undefined}><Input id="bk-now-pass2" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" /></Field>
            </div>
          )}
          {scope === 'install' && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={includeKey} onCheckedChange={(v) => setIncludeKey(v === true)} className="mt-0.5" data-testid="backup-now-key" />
              <span>Include the encryption key (keep this file safe)
                <span className="block text-xs text-muted-foreground">
                  {includeKey
                    ? 'The archive can then restore saved connection passwords, keys and the mail password on a new machine; anyone holding the file can read them too. Encrypt it, and store it like a password.'
                    : 'Without the key, a restore on a new machine gets all data, users and apps, but every saved secret (connection passwords and keys, the mail password, two-step verification) must be entered again, unless you kept workspace/.secret-key separately.'}
                </span>
              </span>
            </label>
          )}
          {includeKey && !encrypt && <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100"><TriangleAlert className="mt-px size-3.5 shrink-0" /> The key is included without a passphrase: the file alone opens every saved secret.</p>}
          <Field label="Note (optional)" htmlFor="bk-note"><Input id="bk-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Before the April price update" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={run} disabled={busy || !passOk} data-testid="backup-now-start">{busy ? <Spinner /> : <Play />} Start backup</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ restore */

type Mode = 'new' | 'in-place' | 'tables'

function RestoreDialog({ backup, onClose }: { backup: BackupInfo; onClose(): void }) {
  const envs = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const { fail, toast } = useToast()
  const [pass, setPass] = useState<string | undefined>(undefined)
  const [askPass, setAskPass] = useState(false)
  const [contents, setContents] = useState<BackupContents | null>(null)
  const [error, setError] = useState('')
  const [envId, setEnvId] = useState('')
  const [mode, setMode] = useState<Mode>('new')
  const [name, setName] = useState('')
  const [type, setType] = useState<'sandbox' | 'developer' | 'production'>('sandbox')
  const [keepSecrets, setKeepSecrets] = useState(false)
  const [keepAccess, setKeepAccess] = useState(false)
  const [target, setTarget] = useState('')
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [tableMode, setTableMode] = useState<'new' | 'replace'>('new')
  const [plan, setPlan] = useState<TableRestorePlan | null>(null)
  const [ack, setAck] = useState(false)
  const [op, setOp] = useState<BackupOp | null>(null)
  const [busy, setBusy] = useState(false)
  const [browse, setBrowse] = useState<{ table: string; name: string } | null>(null)

  const load = useCallback(async (p?: string) => {
    setError('')
    try {
      const c = await fetchContents(backup.id, p)
      setContents(c)
      setPass(p)
      setAskPass(false)
      const first = c.environments[0]
      setEnvId(first?.id ?? '')
      setName(first ? `${first.name} (restored ${c.createdOn.slice(0, 10)})` : '')
      setTarget(first?.id ?? '')
    } catch (e) {
      if (needsPassphrase(e)) { setAskPass(true); if (p) throw e } else setError(errMsg(e))
    }
  }, [backup.id])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setPlan(null); setAck(false) }, [picked, tableMode, envId])

  const env = contents?.environments.find((e) => e.id === envId)
  const targetEnv = envs.find((e) => e.id === target)
  const currentEnv = envs.find((e) => e.id === currentId)
  const nameTaken = envs.some((e) => e.name.toLowerCase() === name.trim().toLowerCase())

  const follow = async (o: BackupOp) => {
    setOp(o)
    const end = await waitForOp(o.id, setOp)
    setOp(end)
    if (end.state === 'succeeded') toast(mode === 'tables' ? 'Tables restored' : mode === 'new' ? `Restored as "${String(end.result?.name ?? end.targetEnvironment)}"` : `"${targetEnv?.name ?? target}" restored`, 'success')
  }
  const start = async (proceedWithoutBackup = false) => {
    setBusy(true)
    try {
      if (mode === 'tables') {
        if (!plan) { setPlan(await planTableRestore(backup.id, { environment: envId, tables: picked, mode: tableMode, ...(pass ? { passphrase: pass } : {}) })); return }
        await follow(await restoreTables(backup.id, { environment: envId, tables: picked, mode: tableMode, confirm: plan.token, ...(pass ? { passphrase: pass } : {}) }))
      } else if (mode === 'new') {
        await follow(await restoreBackup(backup.id, { environment: envId, mode: 'new', name: name.trim(), type, keepConnectionSecrets: keepSecrets, keepAccess, ...(pass ? { passphrase: pass } : {}) }))
      } else {
        await follow(await restoreBackup(backup.id, { environment: envId, mode: 'in-place', target, confirmName: typed, ...(proceedWithoutBackup ? { proceedWithoutBackup: true } : {}), ...(pass ? { passphrase: pass } : {}) }))
      }
    } catch (e) {
      if (isBackupRefusal(e)) setError(errMsg(e))
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  const running = op?.state === 'running'
  const ready = !!contents && !!env && contents.restorable && !running && (
    mode === 'new' ? !!name.trim() && !nameTaken
      : mode === 'in-place' ? !!targetEnv && typed === targetEnv.name
        : picked.length > 0 && (!plan || (!plan.problems.length && (!plan.destructive || ack))))

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="restore-dialog">
        <DialogHeader>
          <DialogTitle>Restore from {backup.kind === 'install' ? 'the install backup' : `the backup of ${backup.environmentName ?? backup.environmentId}`} of {fmtDate(backup.createdOn)}</DialogTitle>
          <DialogDescription>{backup.fileName}{backup.sizeBytes ? ` · ${fmtBytes(backup.sizeBytes)}` : ''}</DialogDescription>
        </DialogHeader>
        {askPass && <PassphraseInline onSubmit={(p) => load(p)} />}
        {error && <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2.5 text-sm text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}</p>}
        {!contents && !askPass && !error && <div className="py-8 text-center text-sm text-muted-foreground"><Spinner className="mr-2 inline" /> Reading the backup...</div>}
        {contents && !contents.restorable && <p className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive" role="alert">{contents.problem}</p>}
        {contents && (
          <div className="grid gap-4">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Environment in the backup">
                <select value={envId} onChange={(e) => setEnvId(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="restore-source-env">
                  {contents.environments.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.tables.length} tables, {e.attachments.count} attachments)</option>)}
                </select>
              </Field>
              <span className="pb-1.5 text-xs text-muted-foreground">Made by {contents.app.version} · schema {contents.app.schemaVersion} · {contents.method === 'pg_dump' ? 'pg_dump' : 'built-in exporter'}</span>
            </div>
            {env && (
              <Panel className="max-h-56 overflow-auto">
                <table className="w-full text-xs" data-testid="restore-tables">
                  <thead><tr className="border-b border-border bg-muted/50 text-left text-muted-foreground"><th className="w-8 px-2 py-1.5" /><th className="px-2 py-1.5">Table</th><th className="px-2 py-1.5 text-right">Rows</th><th className="px-2 py-1.5">Columns</th><th className="w-[1%] px-2 py-1.5" /></tr></thead>
                  <tbody>
                    {env.tables.map((t) => (
                      <tr key={t.id} className="border-b border-border last:border-0">
                        <td className="px-2 py-1">{mode === 'tables' && <Checkbox disabled={!t.restorable} checked={picked.includes(t.id)} onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, t.id] : p.filter((x) => x !== t.id)))} aria-label={`Restore ${t.name}`} data-testid={`restore-pick-${t.name}`} />}</td>
                        <td className="px-2 py-1 font-medium"><span className="flex items-center gap-1.5"><Table2 className="size-3.5 text-muted-foreground" /> {t.name}</span>{t.note && <span className="block font-normal text-muted-foreground">{t.note}</span>}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{t.rows === null ? '-' : t.rows.toLocaleString()}</td>
                        <td className="max-w-64 truncate px-2 py-1 text-muted-foreground">{t.columns.map((c) => c.name).join(', ')}</td>
                        <td className="px-2 py-1">{t.restorable && <Button size="xs" variant="ghost" onClick={() => setBrowse({ table: t.id, name: t.name })} data-testid={`restore-browse-${t.name}`}><Eye /> Browse</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
            <Field label="Restore">
              <div className="grid gap-2" role="radiogroup" aria-label="How to restore" data-testid="restore-mode">
                {([
                  ['new', 'As a new environment (recommended)', 'Nothing that exists is changed. Look at the data there, copy what you need, or make it the one people use.'],
                  ['in-place', 'In place, over an existing environment', 'Replaces its tables, rows, apps, roles, files and audit log with the backup. A safety backup of what is there now is taken first.'],
                  ['tables', `Selected tables into ${currentEnv?.name ?? 'this environment'}`, 'Brings back the rows of chosen tables, as new tables or replacing the rows of the existing ones.'],
                ] as const).map(([v, label, hint]) => (
                  <label key={v} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm', mode === v ? 'border-primary bg-primary/5' : 'border-border')}>
                    <input type="radio" name="restore-mode" value={v} checked={mode === v} onChange={() => setMode(v)} className="mt-0.5" data-testid={`restore-mode-${v}`} />
                    <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                  </label>
                ))}
              </div>
            </Field>
            {mode === 'new' && (
              <div className="grid gap-3">
                <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                  <Field label="Name of the new environment" htmlFor="restore-name" hint={nameTaken ? <span className="text-destructive">An environment with this name exists.</span> : undefined}><Input id="restore-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="restore-name" /></Field>
                  <Segmented label="Type" value={type} onChange={setType} options={(['sandbox', 'developer', 'production'] as const).map((t) => ({ value: t, label: ENVIRONMENT_TYPE_LABEL[t] }))} />
                </div>
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={keepAccess} onCheckedChange={(v) => setKeepAccess(v === true)} className="mt-0.5" /><span>Keep people's roles from the backup<span className="block text-xs text-muted-foreground">Off: only you can enter it (as its administrator), like a copy. On: everybody who had a role then gets it back, even if their access was removed since.</span></span></label>
                <label className="flex items-start gap-2 text-sm"><Checkbox checked={keepSecrets} onCheckedChange={(v) => setKeepSecrets(v === true)} className="mt-0.5" /><span>Keep the passwords of connections to other systems<span className="block text-xs text-muted-foreground">Off: the restored environment cannot write to your other databases or sheets until someone enters them again.</span></span></label>
              </div>
            )}
            {mode === 'in-place' && (
              <div className="grid gap-3">
                <Field label="Environment to replace">
                  <select value={target} onChange={(e) => { setTarget(e.target.value); setTyped('') }} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" data-testid="restore-target">
                    {envs.filter((e) => !e.state || e.state === 'ready').map((e) => <option key={e.id} value={e.id}>{e.name} ({ENVIRONMENT_TYPE_LABEL[e.type]}){e.id === envId ? ' - the same environment' : ''}</option>)}
                  </select>
                </Field>
                <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-900 dark:text-rose-100">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span>Everything in <b>{targetEnv?.name}</b> is replaced by the backup of {fmtDate(contents.createdOn)}: changes made since then are gone (they stay in the safety backup taken first). While it runs, nobody can use it: requests answer "being restored". The database part is one transaction: if it fails, the environment keeps its data.</span>
                </div>
                <Field label={`Type the name of the environment (${targetEnv?.name ?? ''}) to confirm`} htmlFor="restore-confirm"><Input id="restore-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="restore-confirm-name" /></Field>
              </div>
            )}
            {mode === 'tables' && (
              <div className="grid gap-3">
                <Segmented label="How" value={tableMode} onChange={setTableMode} options={[{ value: 'new', label: 'As new tables', title: 'The live tables are not touched' }, { value: 'replace', label: 'Replace the rows of the existing tables', title: 'Their current rows are deleted' }]} />
                {plan && <TablePlanView plan={plan} />}
                {plan?.destructive && !plan.problems.length && (
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="restore-plan-ack" /> I understand that the current rows of these tables are replaced.</label>
                )}
              </div>
            )}
            {op && (
              <Panel className="p-3" data-testid="restore-progress" data-state={op.state}>
                <div className="mb-1.5 flex items-center gap-2 text-sm">
                  {op.state === 'running' ? <Spinner className="size-3.5" /> : op.state === 'succeeded' ? <CircleCheck className="size-4 text-emerald-600" /> : <CircleAlert className="size-4 text-destructive" />}
                  <span className="font-medium">{op.state === 'running' ? PHASE[op.phase ?? ''] ?? op.phase : op.state === 'succeeded' ? 'Restored' : 'The restore failed'}</span>
                  {op.progress?.message && op.state === 'running' && <span className="truncate text-xs text-muted-foreground">{op.progress.message}</span>}
                </div>
                {op.state === 'running' && <Progress value={pct(op.progress) ?? 5} />}
                {op.error && <p className="text-xs text-destructive">{op.error}</p>}
                {op.backupFailed && <Button size="sm" variant="destructive" className="mt-2" onClick={() => void start(true)} data-testid="restore-without-backup">Restore without a safety backup</Button>}
                {op.state === 'succeeded' && op.result?.environment ? <p className="text-xs text-muted-foreground">Open it with the environment picker (top right).</p> : null}
              </Panel>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>{op?.state === 'succeeded' ? 'Close' : 'Cancel'}</Button>
          {op?.state !== 'succeeded' && (
            <Button onClick={() => void start()} disabled={!ready || busy} variant={mode === 'in-place' || plan?.destructive ? 'destructive' : 'default'} data-testid="restore-start">
              {busy || running ? <Spinner /> : <ArchiveRestore />} {mode === 'tables' && !plan ? 'Review plan' : mode === 'in-place' ? `Replace ${targetEnv?.name ?? ''}` : 'Restore'}
            </Button>
          )}
        </DialogFooter>
        {browse && contents && <BrowseDialog backupId={backup.id} environment={envId} table={browse.table} name={browse.name} passphrase={pass} onClose={() => setBrowse(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function PassphraseInline({ onSubmit }: { onSubmit(p: string): Promise<void> }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Panel className="grid gap-2 p-3" data-testid="restore-passphrase">
      <span className="flex items-center gap-1.5 text-sm font-medium"><Lock className="size-4" /> This backup is encrypted</span>
      <div className="flex gap-2">
        <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="Passphrase" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && v) (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click() }} />
        <Button disabled={!v || busy} onClick={async () => { setBusy(true); setErr(''); try { await onSubmit(v) } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) } }}>{busy && <Spinner />} Open</Button>
      </div>
      {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
    </Panel>
  )
}

function TablePlanView({ plan }: { plan: TableRestorePlan }) {
  return (
    <div className="grid gap-2" data-testid="restore-plan">
      {plan.problems.length > 0 && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive" role="alert">{plan.problems.map((p) => <div key={p}>{p}</div>)}</div>}
      {plan.items.map((i) => (
        <div key={i.tableId} className={cn('rounded-md border p-2.5 text-sm', i.destructive ? 'border-rose-500/40 bg-rose-500/5' : 'border-border')} data-testid={`restore-plan-${i.name}`}>
          <div className="flex items-center gap-2">
            <Table2 className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{i.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{i.mode === 'new' ? `new table "${i.newName}"` : `${i.rowsNow ?? '?'} rows now`} ← {i.rowsInBackup.toLocaleString()} rows from the backup</span>
          </div>
          {i.columns.length > 0 && <ul className="mt-1 pl-5 text-xs text-muted-foreground">{i.columns.map((c) => <li key={c.name}>{c.change === 'only-in-backup' ? `${c.name}: only in the backup, left out` : c.change === 'only-now' ? `${c.name}: added since, blank in restored rows` : `${c.name}: ${c.from} → ${c.to}`}</li>)}</ul>}
          {i.notes.map((n) => <p key={n} className="mt-1 pl-5 text-xs text-muted-foreground">{n}</p>)}
        </div>
      ))}
    </div>
  )
}

function BrowseDialog({ backupId, environment, table, name, passphrase, onClose }: { backupId: string; environment: string; table: string; name: string; passphrase?: string; onClose(): void }) {
  const [page, setPage] = useState<BackupRowsPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [err, setErr] = useState('')
  const limit = 50
  useEffect(() => {
    let alive = true
    setErr('')
    browseBackup(backupId, { environment, table, offset, limit, ...(passphrase ? { passphrase } : {}) }).then((p) => alive && setPage(p)).catch((e) => alive && setErr(errMsg(e)))
    return () => { alive = false }
  }, [backupId, environment, table, offset, passphrase])
  const cols = page?.columns.filter((c) => !['createdBy', 'owner'].includes(c.name)) ?? []
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] sm:max-w-5xl" data-testid="backup-browse">
        <DialogHeader><DialogTitle className="flex items-center gap-2">{name} <Badge variant="outline">read-only, from the backup</Badge></DialogTitle><DialogDescription>Values as they were stored when the backup was made.</DialogDescription></DialogHeader>
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
          <table className="w-full text-xs" data-testid="backup-browse-table">
            <thead className="sticky top-0 bg-muted"><tr>{cols.map((c) => <th key={c.name} className="whitespace-nowrap px-2 py-1.5 text-left font-medium" title={`${c.name} (${c.type})`}>{c.displayName}</th>)}</tr></thead>
            <tbody>
              {page?.rows.map((r, i) => <tr key={i} className="border-t border-border">{cols.map((c) => <td key={c.name} className="max-w-60 truncate px-2 py-1" title={r[c.name] ?? ''}>{r[c.name] === null ? <span className="text-muted-foreground">-</span> : r[c.name]}</td>)}</tr>)}
              {!page && !err && <tr><td className="px-3 py-6 text-center text-muted-foreground"><Spinner className="mr-2 inline" /> Reading...</td></tr>}
            </tbody>
          </table>
        </div>
        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground" data-testid="backup-browse-range">{page ? `${page.rows.length ? `${offset + 1}-${offset + page.rows.length}` : 'No rows'}${page.total !== null ? ` of ${page.total.toLocaleString()}` : ''}` : ''}</span>
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - limit))}>Previous</Button>
          <Button size="sm" variant="outline" disabled={!page?.more} onClick={() => setOffset((o) => o + limit)}>Next</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ schedule and retention */

const cronTime = (cron: string): string | null => {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim())
  return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : null
}
const timeCron = (t: string): string => { const [h, m] = t.split(':').map(Number); return `${m} ${h} * * *` }

function useSettings(): [BackupSettings | null, (p: BackupSettingsInput, done?: string) => Promise<boolean>] {
  const { fail, toast } = useToast()
  const [s, setS] = useState<BackupSettings | null>(null)
  useEffect(() => { fetchBackupSettings().then(setS).catch(fail) }, [fail])
  const save = async (p: BackupSettingsInput, done = 'Saved') => {
    try {
      setS(await saveBackupSettings(p))
      toast(done, 'success')
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }
  return [s, save]
}

function ScheduleRow({ label, value, onSave, testId }: { label: ReactNode; value: ScheduleSetting; onSave(v: Partial<ScheduleSetting>): void; testId: string }) {
  const t = cronTime(value.cron)
  const [cron, setCron] = useState(value.cron)
  useEffect(() => setCron(value.cron), [value.cron])
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border py-2.5 last:border-0" data-testid={testId}>
      <div className="text-sm">{label}</div>
      <Switch checked={value.enabled} onCheckedChange={(v) => onSave({ enabled: v })} aria-label="On" />
      {t ? (
        <Input type="time" className="h-8 w-28" value={t} onChange={(e) => e.target.value && onSave({ cron: timeCron(e.target.value) })} aria-label="Time" />
      ) : (
        <Input className="h-8 w-36 font-mono text-xs" value={cron} onChange={(e) => setCron(e.target.value)} onBlur={() => cron !== value.cron && onSave({ cron })} aria-label="Cron expression" />
      )}
      <span className="w-36 truncate text-xs text-muted-foreground" title={value.timeZone}>{t ? 'every day, ' : ''}{value.timeZone}</span>
    </div>
  )
}

function ScheduleTab() {
  const [s, save] = useSettings()
  const envs = usePlatform((x) => x.environments)
  const [ret, setRet] = useState<BackupSettings['retention'] | null>(null)
  useEffect(() => { if (s) setRet(s.retention) }, [s])
  if (!s || !ret) return <div className="py-8 text-center"><Spinner className="inline" /></div>
  const num = (k: keyof BackupSettings['retention'], label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" min={0} max={1000} value={ret[k]} onChange={(e) => setRet({ ...ret, [k]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} className="h-8 w-24" data-testid={`retention-${k}`} />
    </Field>
  )
  return (
    <div className="grid gap-4" data-testid="backup-schedule">
      <Panel className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Schedules</h3>
        <p className="mb-2 text-xs text-muted-foreground">Backups run as jobs of the Default environment. A slot missed while the server was off runs once when it starts again.</p>
        <ScheduleRow testId="schedule-install" label={<><b>Whole install</b><span className="block text-xs text-muted-foreground">Accounts, settings and every environment</span></>} value={s.install} onSave={(v) => void save({ install: v })} />
        {envs.filter((e) => !e.state || e.state === 'ready').map((e) => {
          const v = s.environments[e.id]
          return v ? (
            <ScheduleRow key={e.id} testId={`schedule-env-${e.id}`} label={<><b>{e.name}</b><span className="block text-xs text-muted-foreground">This environment only <button type="button" className="underline" onClick={() => void save({ environments: { [e.id]: null } })}>remove</button></span></>} value={v} onSave={(x) => void save({ environments: { [e.id]: x } })} />
          ) : (
            <div key={e.id} className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"><span>{e.name} <span className="text-xs text-muted-foreground">(in the install backup)</span></span><Button size="xs" variant="ghost" onClick={() => void save({ environments: { [e.id]: { enabled: true } } })}>Add its own schedule</Button></div>
          )
        })}
        <label className="mt-3 flex items-start gap-2 text-sm"><Switch checked={s.install.includeKey} onCheckedChange={(v) => void save({ install: { includeKey: v } })} className="mt-0.5" /><span>Scheduled install backups include the encryption key<span className="block text-xs text-muted-foreground">Then they can restore saved passwords on a new machine, and anyone with an archive can read them. {s.passphraseSaved ? 'They are encrypted with the saved passphrase.' : 'Save a passphrase (Settings) to encrypt them.'}</span></span></label>
      </Panel>
      <Panel className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Retention</h3>
        <p className="mb-3 text-xs text-muted-foreground">Scheduled backups are kept grandfather-father-son: the newest of each of the last days, weeks and months. Manual, uploaded and pinned backups are never removed automatically; the newest good backup always stays.</p>
        <div className="flex flex-wrap items-end gap-4">
          {num('daily', 'Daily', 'days')}
          {num('weekly', 'Weekly', 'weeks')}
          {num('monthly', 'Monthly', 'months')}
          {num('snapshotDays', 'Automatic backups', 'days (before upgrades, deletes, restores)')}
          <Button size="sm" onClick={() => void save({ retention: ret })} disabled={JSON.stringify(ret) === JSON.stringify(s.retention)} data-testid="retention-save">Save</Button>
        </div>
      </Panel>
      <Panel className="p-4">
        <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><FlaskConical className="size-4" /> Restore test</h3>
        <p className="mb-2 text-xs text-muted-foreground">Restores the newest good backup into temporary schemas, compares every table's rows with the manifest, and drops them. A failure is sent to install administrators.</p>
        <ScheduleRow testId="schedule-restore-test" label="Scheduled restore test" value={s.restoreTest} onSave={(v) => void save({ restoreTest: v })} />
        <RestoreTestNow />
      </Panel>
    </div>
  )
}

function RestoreTestNow() {
  const { fail, toast } = useToast()
  const [op, setOp] = useState<BackupOp | null>(null)
  return (
    <div className="mt-2 flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={op?.state === 'running'} onClick={async () => {
        try {
          const o = await runRestoreTest()
          if (!('id' in o)) return
          setOp(o)
          const end = await waitForOp(o.id, setOp)
          if (end.state === 'succeeded') toast(`Restore test passed (${String((end.result as { rows?: number } | undefined)?.rows ?? '')} rows)`, 'success')
        } catch (e) { fail(e) }
      }}>{op?.state === 'running' ? <Spinner /> : <Play />} Run it now</Button>
      {op && op.state !== 'running' && <span className={cn('text-xs', op.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{op.state === 'failed' ? op.error : 'Passed'}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ settings */

function SettingsTab() {
  const [s, save] = useSettings()
  const [folder, setFolder] = useState('')
  const [bin, setBin] = useState('')
  const [off, setOff] = useState('')
  const [pass, setPass] = useState('')
  const [stale, setStale] = useState('')
  useEffect(() => { if (s) { setFolder(s.folderFromEnv ? s.folder : (s.folder === s.defaultFolder ? '' : s.folder)); setBin(s.pgBinPath ?? ''); setOff(s.offsite.folder ?? ''); setStale(String(s.staleHours)) } }, [s])
  const tools = s?.tools
  const toolLine = useMemo(() => {
    if (!tools) return ''
    if (tools.usable && tools.pgDump) return `pg_dump ${tools.pgDump.version} at ${tools.pgDump.path}`
    return `${tools.problem ?? 'pg_dump not found'}: backups use the built-in exporter.`
  }, [tools])
  if (!s) return <div className="py-8 text-center"><Spinner className="inline" /></div>
  return (
    <div className="grid gap-4" data-testid="backup-settings">
      <Panel className="p-4">
        <label className="flex items-start gap-2 text-sm"><Switch checked={s.enabled} onCheckedChange={(v) => void save({ enabled: v }, v ? 'Automatic backups are on' : 'Automatic backups are off')} className="mt-0.5" data-testid="backup-enabled" /><span><b>Automatic backups</b><span className="block text-xs text-muted-foreground">Schedules, and the backups taken before solution upgrades, environment deletes, restores and server upgrades. "Back up now" always works.</span></span></label>
      </Panel>
      <Panel className="grid gap-3 p-4">
        <h3 className="text-sm font-semibold">Where</h3>
        <Field label="Backup folder (on the server)" hint={s.folderFromEnv ? 'Set by APPBUILDER_BACKUP_DIR on the server.' : `Empty: ${s.defaultFolder}. Use a folder outside the web folder; a second disk is better.`}>
          <div className="flex gap-2">
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} disabled={s.folderFromEnv} placeholder={s.defaultFolder} className="font-mono text-xs" data-testid="backup-folder" />
            <Button size="sm" variant="outline" disabled={s.folderFromEnv} onClick={() => void save({ folder: folder.trim() || null })}>Save</Button>
          </div>
        </Field>
        <Field label="Off-site copy" hint="A second folder, for example a NAS share, a USB disk or a cloud-sync folder: every finished backup is copied there and checked. For real off-site storage use rclone or restic on that folder (see the administrator guide).">
          <div className="flex items-center gap-2">
            <Switch checked={s.offsite.enabled} onCheckedChange={(v) => void save({ offsite: { enabled: v, folder: off.trim() || null } })} aria-label="Copy off-site" />
            <Input value={off} onChange={(e) => setOff(e.target.value)} placeholder={'\\\\nas\\backups\\appbuilder or /mnt/nas/appbuilder'} className="font-mono text-xs" data-testid="backup-offsite" />
            <Button size="sm" variant="outline" onClick={() => void save({ offsite: { folder: off.trim() || null } })}>Save</Button>
          </div>
        </Field>
      </Panel>
      <Panel className="grid gap-3 p-4">
        <h3 className="text-sm font-semibold">How</h3>
        <Field label="Method" hint={toolLine}>
          <Segmented label="Method" value={s.method} onChange={(m) => void save({ method: m })} options={[{ value: 'auto', label: 'Automatic', title: 'pg_dump when it is usable, else the built-in exporter' }, { value: 'pg_dump', label: 'pg_dump only' }, { value: 'builtin', label: 'Built-in exporter' }]} />
        </Field>
        <Field label="PostgreSQL tools folder (optional)" hint="Where pg_dump and pg_restore are, if they are not found on their own (for example C:\Program Files\PostgreSQL\17\bin). They must be the server's major version or newer.">
          <div className="flex gap-2"><Input value={bin} onChange={(e) => setBin(e.target.value)} className="font-mono text-xs" /><Button size="sm" variant="outline" onClick={() => void save({ pgBinPath: bin.trim() || null })}>Save</Button></div>
        </Field>
      </Panel>
      <Panel className="grid gap-3 p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><FileKey2 className="size-4" /> Passphrase for scheduled backups</h3>
        <p className="text-xs text-muted-foreground">
          {s.passphraseSaved
            ? 'A passphrase is saved: scheduled and automatic backups are encrypted with it. It is stored sealed with this install\'s encryption key (workspace/.secret-key), so this server can use it; anyone who has both the database and that key file can recover it. To restore an archive on another machine you need the passphrase itself: keep a copy of it somewhere safe.'
            : 'No passphrase is saved: scheduled backups are not encrypted. Save one to encrypt them; it is stored sealed with this install\'s encryption key so the server can use it at night.'}
        </p>
        <div className="flex gap-2">
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={s.passphraseSaved ? 'New passphrase' : 'Passphrase (10 characters or more)'} autoComplete="new-password" data-testid="backup-saved-pass" />
          <Button size="sm" variant="outline" disabled={pass.length < 10} onClick={async () => { if (await save({ passphrase: pass }, 'Passphrase saved')) setPass('') }}>Save</Button>
          {s.passphraseSaved && <Button size="sm" variant="ghost" onClick={() => void save({ passphrase: null }, 'Passphrase forgotten')}>Forget it</Button>}
        </div>
      </Panel>
      <Panel className="grid gap-2 p-4">
        <h3 className="text-sm font-semibold">Automatic backups before risky changes</h3>
        {([
          ['beforeUpgrade', 'Before a solution upgrade in place (import or deploy)'],
          ['beforeDelete', 'Before an environment is deleted'],
          ['beforeRestore', 'Before an environment is restored in place'],
          ['beforeMigration', 'Before the server upgrades the database (new Appbuilder version)'],
        ] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><Switch checked={s.snapshots[k]} onCheckedChange={(v) => void save({ snapshots: { [k]: v } })} aria-label={label} data-testid={`snapshot-${k}`} /> {label}</label>
        ))}
        <p className="text-xs text-muted-foreground">If such a backup fails, the change stops and you can go on without it or cancel.</p>
      </Panel>
      <Panel className="p-4">
        <Field label="Warn when the last good install backup is older than (hours)" hint="Install administrators get a notification, at most once a day.">
          <div className="flex gap-2"><Input type="number" min={1} max={1440} value={stale} onChange={(e) => setStale(e.target.value)} className="h-8 w-24" /><Button size="sm" variant="outline" onClick={() => void save({ staleHours: Number(stale) })}>Save</Button></div>
        </Field>
      </Panel>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><HardDriveUpload className="size-3.5" /> Disaster recovery onto a new machine: <code className="rounded bg-muted px-1">node server/main.ts restore &lt;archive&gt;</code> (administrator guide, Disaster recovery). <Clock className="ml-2 size-3.5" /> Times use the server's time zone ({s.timeZone}).</p>
    </div>
  )
}
