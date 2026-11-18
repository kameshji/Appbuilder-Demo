/**
 * Admin console > Environments (docs/admin/environments.md): the environments of the install with their type, state
 * and lock; creating one (empty, with the sample, or copied from another: schema only or schema + data); details
 * (type, lock, schema version, sizes); who may enter it (access, environment administrators); deleting it after typing
 * its name. Install administrators manage everything; an environment's own administrators see its details and access.
 * Demo mode has one environment and explains why nothing can be created.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Layers, Lock, LockOpen, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react'
import { ENVIRONMENT_TYPE_LABEL, usePlatform, type EnvironmentDef } from '@/platform'
import type { EnvironmentAccessEntry, EnvironmentDetails, EnvironmentsResponse } from '@/platform/http'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TypeBadge, switchEnvironment } from './EnvironmentPicker'
import { Field, Panel, Segmented, errMsg, fmtDate, useToast } from './kit'
import { BackupRefusal, isBackupRefusal } from './SolutionPlan'
import { go } from '@/router'
import { useCaps } from './security'
import {
  createEnvironment, deleteEnvironment, fetchAccess, fetchEnvironment, fetchEnvironments, grantAccess, revokeAccess, updateEnvironment,
} from './environmentApi'

const TYPE_TEXT: Record<EnvironmentDef['type'], string> = {
  production: 'Where people do their daily work. Can be locked: then apps, tables and roles change only by deploying a solution into it.',
  sandbox: 'A copy for trying changes with realistic data before they reach production (Test).',
  developer: 'A maker’s own workspace to build in without affecting anyone else.',
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '-'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${u[i]}`
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-border py-2 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>{children}</dd>
    </div>
  )
}

function StateBadge({ e }: { e: EnvironmentDef }) {
  if (!e.state || e.state === 'ready') return null
  return <Badge variant={e.state === 'failed' ? 'destructive' : 'secondary'} data-testid={`env-state-${e.id}`}>{e.state === 'failed' ? 'Failed' : e.state === 'creating' ? 'Creating' : e.state === 'restoring' ? 'Restoring' : 'Deleting'}</Badge>
}

export function EnvironmentsSection({ title }: { title: (t: string, sub?: ReactNode, actions?: ReactNode) => ReactNode }) {
  const list = usePlatform((s) => s.environments)
  const currentId = usePlatform((s) => s.environmentId)
  const server = usePlatform((s) => s.mode) === 'server'
  const caps = useCaps()
  const { fail } = useToast()
  const [meta, setMeta] = useState<EnvironmentsResponse | null>(null)
  const [selId, setSelId] = useState('')
  const [creating, setCreating] = useState(false)
  const [tick, setTick] = useState(0)
  const sel = list.find((e) => e.id === selId) ?? list.find((e) => e.id === currentId) ?? list[0]

  useEffect(() => {
    if (!server) return
    let alive = true
    fetchEnvironments().then((m) => alive && setMeta(m)).catch((e) => alive && fail(e))
    return () => { alive = false }
  }, [server, tick, list.length, fail])

  const blocked = !server
    ? 'Demo mode has one environment, kept in this browser. Run the local server to create Sandbox and Developer environments.'
    : !caps.isInstallAdmin ? 'Only install administrators can create environments.' : meta && !meta.canCreate ? (meta.createBlocked ?? 'Creating environments is not possible right now.') : ''

  return (
    <div data-testid="admin-environments">
      {title(
        'Environments',
        <>Each environment is a separate workspace of tables, apps, roles, connections, files and audit log on this install: its own database schema and folder.{meta?.max ? ` This install allows up to ${meta.max}.` : ''}</>,
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-1.5">
            {server && <Button size="sm" variant="outline" onClick={() => setTick((t) => t + 1)} aria-label="Refresh"><RefreshCw /></Button>}
            <Button size="sm" disabled={!!blocked || !meta} onClick={() => setCreating(true)} data-testid="new-environment" title={blocked || undefined}><Plus /> New environment</Button>
          </div>
          {blocked && <span className="max-w-80 text-right text-[11px] text-muted-foreground" data-testid="new-environment-blocked">{blocked}</span>}
        </div>,
      )}
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="environments-table">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Created</th><th className="px-4 py-2.5">Schema</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr
                key={e.id}
                data-testid={`env-row-${e.id}`}
                aria-selected={sel?.id === e.id}
                onClick={() => setSelId(e.id)}
                className={cn('cursor-pointer border-b border-border last:border-0', sel?.id === e.id ? 'bg-accent/60' : 'hover:bg-accent/40')}
              >
                <td className="px-4 py-2.5 font-medium">
                  <span className="flex items-center gap-2"><Layers className="size-4 text-primary" /> {e.name}{e.builtIn && <Badge variant="outline">Built-in</Badge>}{e.id === currentId && <Badge variant="secondary">Current</Badge>}<StateBadge e={e} /></span>
                </td>
                <td className="px-4 py-2.5"><TypeBadge type={e.type} locked={e.locked} /></td>
                <td className="px-4 py-2.5 text-muted-foreground">{e.createdOn ? fmtDate(e.createdOn) : 'Not recorded'}</td>
                <td className="max-w-80 truncate px-4 py-2.5 font-mono text-xs text-muted-foreground">{e.details?.schema ?? '-'}</td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">The server did not report any environment.</td></tr>}
          </tbody>
        </table>
      </Panel>
      {sel && <EnvironmentDetailsPanel key={sel.id} env={sel} server={server} onChanged={() => setTick((t) => t + 1)} />}
      {!server && (
        <div className="mt-6 grid grid-cols-3 gap-3" data-testid="env-types">
          {(Object.keys(TYPE_TEXT) as EnvironmentDef['type'][]).map((t) => (
            <Panel key={t} className="p-4"><div className="mb-1.5"><TypeBadge type={t} /></div><p className="text-xs leading-relaxed text-muted-foreground">{TYPE_TEXT[t]}</p></Panel>
          ))}
        </div>
      )}
      <CreateEnvironmentDialog open={creating} onOpenChange={setCreating} environments={list} onCreated={() => setTick((t) => t + 1)} />
    </div>
  )
}

/* ------------------------------------------------------------------ create */

type Start = 'empty' | 'sample' | 'copy'

function CreateEnvironmentDialog({ open, onOpenChange, environments, onCreated }: { open: boolean; onOpenChange(o: boolean): void; environments: EnvironmentDef[]; onCreated(): void }) {
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState<EnvironmentDef['type']>('sandbox')
  const [description, setDescription] = useState('')
  const [start, setStart] = useState<Start>('copy')
  const [copyFrom, setCopyFrom] = useState('')
  const [copy, setCopy] = useState<'schema' | 'data'>('schema')
  const [busy, setBusy] = useState(false)
  const sources = environments.filter((e) => !e.state || e.state === 'ready')
  useEffect(() => {
    if (!open) return
    setName(''); setType('sandbox'); setDescription(''); setStart('copy'); setCopy('schema')
    setCopyFrom(sources.find((e) => e.builtIn)?.id ?? sources[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const taken = environments.some((e) => e.name.toLowerCase() === name.trim().toLowerCase())
  const ok = !!name.trim() && !taken && (start !== 'copy' || !!copyFrom)

  const submit = async () => {
    if (!ok) return
    setBusy(true)
    try {
      const env = await createEnvironment({
        name: name.trim(), type, ...(description.trim() ? { description: description.trim() } : {}),
        ...(start === 'sample' ? { sampleData: true } : {}), ...(start === 'copy' ? { copyFrom, copy } : {}),
      })
      toast(`Created "${env.name}"`, 'success')
      onOpenChange(false)
      onCreated()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-testid="new-environment-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New environment</DialogTitle>
          <DialogDescription>A separate workspace on this install: its own tables, apps, roles and files. You become its administrator.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Name" htmlFor="env-name" hint={taken ? <span className="text-destructive">An environment with this name exists.</span> : undefined}>
            <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Sales test" autoFocus data-testid="env-name" />
          </Field>
          <Field label="Type" hint={TYPE_TEXT[type]}>
            <Segmented label="Type" value={type} onChange={setType} options={(['production', 'sandbox', 'developer'] as const).map((t) => ({ value: t, label: ENVIRONMENT_TYPE_LABEL[t] }))} />
          </Field>
          <Field label="Description (optional)" htmlFor="env-desc">
            <Input id="env-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} data-testid="env-description" />
          </Field>
          <Field label="Start with">
            <div className="grid gap-2" role="radiogroup" aria-label="Start with" data-testid="env-start">
              {([
                ['copy', 'A copy of another environment', 'Tables, apps, roles, solutions and connections (without their passwords). Users are not copied: give them access.'],
                ['sample', 'The sample', 'Contacts and Orders with a few rows, and the Contacts app.'],
                ['empty', 'Nothing', 'Only the built-in roles and connections.'],
              ] as const).map(([v, label, hint]) => (
                <label key={v} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm', start === v ? 'border-primary bg-primary/5' : 'border-border')}>
                  <input type="radio" name="env-start" value={v} checked={start === v} onChange={() => setStart(v)} className="mt-0.5" data-testid={`env-start-${v}`} />
                  <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                </label>
              ))}
            </div>
          </Field>
          {start === 'copy' && (
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Copy from" htmlFor="env-copy-from">
                <select id="env-copy-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} data-testid="env-copy-from" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {sources.map((e) => <option key={e.id} value={e.id}>{e.name} ({ENVIRONMENT_TYPE_LABEL[e.type]})</option>)}
                </select>
              </Field>
              <Segmented label="What to copy" value={copy} onChange={setCopy} options={[{ value: 'schema', label: 'Schema only', title: 'Tables are created empty' }, { value: 'data', label: 'Schema and data', title: 'Rows, attachments and data files too' }]} />
            </div>
          )}
          {start === 'copy' && copy === 'data' && <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200" data-testid="env-copy-data-note">Every row, attachment and data file is copied. People given access to the new environment see that data.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!ok || busy} data-testid="env-create">{busy ? <Spinner /> : <Plus />} Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ details */

function EnvironmentDetailsPanel({ env, server, onChanged }: { env: EnvironmentDef; server: boolean; onChanged(): void }) {
  const caps = useCaps()
  const { fail, toast } = useToast()
  const currentId = usePlatform((s) => s.environmentId)
  const list = usePlatform((s) => s.environments)
  const [details, setDetails] = useState<EnvironmentDetails | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [tick, setTick] = useState(0)
  const manage = server && !!env.canManage
  useEffect(() => {
    if (!manage) return
    let alive = true
    fetchEnvironment(env.id).then((d) => alive && setDetails(d)).catch(() => {})
    return () => { alive = false }
  }, [env.id, manage, tick])

  const patch = async (p: Parameters<typeof updateEnvironment>[1], done?: string) => {
    setBusy(true)
    try {
      await updateEnvironment(env.id, p)
      if (done) toast(done, 'success')
      setTick((t) => t + 1)
      onChanged()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const lastProduction = env.type === 'production' && list.filter((e) => e.type === 'production').length <= 1
  const sizes = details?.sizes

  return (
    <Panel className="mt-4 p-5" data-testid="environment-details">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">{env.name} <TypeBadge type={env.type} locked={env.locked} /><StateBadge e={env} /></h3>
      {env.state === 'failed' && env.details?.error && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {env.details.error}</p>
      )}
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details" data-testid="env-tab-details">Details</TabsTrigger>
          <TabsTrigger value="access" disabled={!manage} data-testid="env-tab-access">Access</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <dl>
            <Fact label="Name">
              <span className="flex items-center gap-2">{env.name}
                {caps.isInstallAdmin && server && <RenameButton env={env} onRename={(name) => patch({ name }, 'Renamed')} />}
              </span>
            </Fact>
            {env.description && <Fact label="Description">{env.description}</Fact>}
            <Fact label="Type" testId="env-detail-type">
              {caps.isInstallAdmin && server && !env.builtIn ? (
                <Segmented label="Type" size="sm" disabled={busy} value={env.type} onChange={(t) => patch({ type: t })} options={(['production', 'sandbox', 'developer'] as const).map((t) => ({ value: t, label: ENVIRONMENT_TYPE_LABEL[t], ...(lastProduction && t !== 'production' ? { title: 'This is the only production environment' } : {}) }))} />
              ) : <>{ENVIRONMENT_TYPE_LABEL[env.type]}{env.builtIn ? ' (the built-in environment of this install)' : ''}</>}
            </Fact>
            {env.type === 'production' && (
              <Fact label="Locked" testId="env-detail-locked">
                <span className="flex items-center gap-2">
                  <Switch checked={!!env.locked} disabled={!caps.isInstallAdmin || !server || busy} onCheckedChange={(v) => patch({ locked: v }, v ? `"${env.name}" is locked` : `"${env.name}" is unlocked`)} aria-label="Locked" data-testid="env-lock" />
                  {env.locked ? <><Lock className="size-3.5" /> Apps, tables and roles change only by deploying a solution into it.</> : <><LockOpen className="size-3.5 text-muted-foreground" /> Makers can edit apps, tables and roles here directly.</>}
                </span>
              </Fact>
            )}
            <Fact label="Created">{env.createdOn ? fmtDate(env.createdOn) : server ? 'Not recorded' : 'Demo mode: kept in this browser'}</Fact>
            <Fact label="Database" testId="env-detail-database">{env.details?.database ?? '-'}</Fact>
            {env.details?.schema && <Fact label="Schema"><code className="font-mono text-xs">{env.details.schema}</code></Fact>}
            {env.details?.schemaVersion !== undefined && <Fact label="Schema version" testId="env-detail-schema">{env.details.schemaVersion}</Fact>}
            {manage && caps.isInstallAdmin && details && 'lastBackup' in details && (
              <Fact label="Last backup" testId="env-detail-backup">
                {details.lastBackup
                  ? <span className="flex items-center gap-2">{fmtDate(details.lastBackup.at)} <span className="text-xs text-muted-foreground">({details.lastBackup.kind === 'install' ? 'install backup' : 'its own backup'})</span><Button size="xs" variant="ghost" onClick={() => go({ page: 'admin', id: 'backups' })}>Backups</Button></span>
                  : <span className="flex items-center gap-2 text-amber-700 dark:text-amber-300"><TriangleAlert className="size-3.5" /> No backup contains it yet. <Button size="xs" variant="ghost" onClick={() => go({ page: 'admin', id: 'backups' })}>Back it up</Button></span>}
              </Fact>
            )}
            {manage && (
              <Fact label="Size" testId="env-detail-sizes">
                {sizes ? (
                  <span className="grid gap-0.5 text-xs">
                    <span>{sizes.tables} table{sizes.tables === 1 ? '' : 's'}, about {sizes.rowEstimate.toLocaleString()} rows, {fmtBytes(sizes.databaseBytes)} in the database</span>
                    <span>{sizes.attachments} attachment{sizes.attachments === 1 ? '' : 's'} ({fmtBytes(sizes.attachmentBytes)}), {sizes.files} data file{sizes.files === 1 ? '' : 's'}</span>
                    <span className="text-muted-foreground">{details?.accessCount ?? 0} {details?.accessCount === 1 ? 'person has' : 'people have'} access (install administrators always do)</span>
                  </span>
                ) : <Spinner />}
              </Fact>
            )}
          </dl>
          {caps.isInstallAdmin && server && (
            <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
              {env.id !== currentId && (!env.state || env.state === 'ready') && <Button size="sm" variant="outline" onClick={() => switchEnvironment(env.id, null).catch(fail)} data-testid="env-open">Switch to it</Button>}
              <div className="ml-auto flex items-center gap-2">
                {(env.builtIn || lastProduction) && <span className="text-[11px] text-muted-foreground">{env.builtIn ? 'The Default environment cannot be deleted.' : 'The last production environment cannot be deleted.'}</span>}
                <Button size="sm" variant="destructive" disabled={env.builtIn || lastProduction} onClick={() => setDeleting(true)} data-testid="env-delete"><Trash2 /> Delete</Button>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="access">{manage && <AccessTab env={env} />}</TabsContent>
      </Tabs>
      <DeleteEnvironmentDialog open={deleting} onOpenChange={setDeleting} env={env} onDeleted={onChanged} />
    </Panel>
  )
}

function RenameButton({ env, onRename }: { env: EnvironmentDef; onRename(name: string): void }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState(env.name)
  if (!open) return <Button size="xs" variant="ghost" onClick={() => { setV(env.name); setOpen(true) }} data-testid="env-rename">Rename</Button>
  return (
    <span className="flex items-center gap-1">
      <Input value={v} onChange={(e) => setV(e.target.value)} className="h-7 w-48" maxLength={60} data-testid="env-rename-input" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { onRename(v.trim()); setOpen(false) } if (e.key === 'Escape') setOpen(false) }} />
      <Button size="xs" disabled={!v.trim()} onClick={() => { onRename(v.trim()); setOpen(false) }}>Save</Button>
      <Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setOpen(false)}><X /></Button>
    </span>
  )
}

function DeleteEnvironmentDialog({ open, onOpenChange, env, onDeleted }: { open: boolean; onOpenChange(o: boolean): void; env: EnvironmentDef; onDeleted(): void }) {
  const { fail, toast } = useToast()
  const currentId = usePlatform((s) => s.environmentId)
  const list = usePlatform((s) => s.environments)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  useEffect(() => { if (open) { setTyped(''); setRefused('') } }, [open])
  const ok = typed === env.name
  const run = async (proceedWithoutBackup = false) => {
    if (!ok) return
    setBusy(true)
    try {
      // a request working in the environment cannot delete it: switch away first
      if (currentId === env.id) {
        const other = list.find((e) => e.id !== env.id && (!e.state || e.state === 'ready'))
        if (other) await switchEnvironment(other.id, null)
      }
      const r = await deleteEnvironment(env.id, typed, { proceedWithoutBackup })
      toast(`Deleted "${env.name}"${r.backup?.taken ? ': a backup of it is in Admin console > Backups' : ''}`, 'success')
      onOpenChange(false)
      onDeleted()
    } catch (e) {
      // the backup before deleting failed: nothing was deleted; the administrator decides
      if (isBackupRefusal(e)) setRefused(errMsg(e))
      else fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-testid="delete-environment-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete "{env.name}"?</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2">
              <p>Its database schema with every table and row, its apps, roles, connections, solutions, audit log, attachments and data files are removed for good. Nobody can enter it afterwards.</p>
              <p>A backup of it is taken first (unless automatic backups are switched off in Admin console &gt; Backups): it can be restored later as a new environment. Otherwise there is no undo{env.type === 'production' ? ' (and it is a production environment)' : ''}.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <Field label={`Type the name of the environment (${env.name}) to confirm`} htmlFor="env-confirm-name">
          <Input id="env-confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="env-confirm-name" />
        </Field>
        {refused && <BackupRefusal message={refused} busy={busy} label="Delete without a backup" onProceed={() => void run(true)} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => void run()} disabled={!ok || busy} data-testid="env-delete-confirm">{busy ? <Spinner /> : <Trash2 />} Delete environment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ access */

function AccessTab({ env }: { env: EnvironmentDef }) {
  const users = usePlatform((s) => s.users)
  const me = usePlatform((s) => s.session?.user.id)
  const { fail, toast } = useToast()
  const [items, setItems] = useState<EnvironmentAccessEntry[] | null>(null)
  const [tick, setTick] = useState(0)
  const [add, setAdd] = useState('')
  const [asAdmin, setAsAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    fetchAccess(env.id).then((x) => alive && setItems(x)).catch((e) => alive && fail(e))
    return () => { alive = false }
  }, [env.id, tick, fail])
  const candidates = useMemo(() => users.filter((u) => !items?.some((i) => i.userId === u.id)), [users, items])
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast(done, 'success')
      setTick((t) => t + 1)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-testid="env-access">
      <p className="mb-3 text-xs text-muted-foreground">People in this list may enter "{env.name}"; what they may do there comes from their roles in it. Install administrators enter every environment.</p>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Give access to" htmlFor="env-access-user">
          <select id="env-access-user" value={add} onChange={(e) => setAdd(e.target.value)} data-testid="env-access-user" className="h-8 w-64 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">Choose a person…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
        </Field>
        <label className="flex h-8 items-center gap-2 text-xs"><Switch checked={asAdmin} onCheckedChange={setAsAdmin} aria-label="As environment administrator" data-testid="env-access-admin" /> Environment administrator</label>
        <Button size="sm" disabled={!add || busy} onClick={() => run(() => grantAccess(env.id, add, asAdmin || undefined), 'Access given').then(() => { setAdd(''); setAsAdmin(false) })} data-testid="env-access-grant"><UserPlus /> Give access</Button>
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="env-access-table">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-2">Person</th><th className="px-3 py-2">Environment administrator</th><th className="px-3 py-2">Since</th><th className="w-24 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((a) => (
              <tr key={a.userId} className="border-b border-border last:border-0" data-testid={`env-access-row-${a.userId}`}>
                <td className="px-3 py-2"><div className="font-medium">{a.name} {a.status === 'disabled' && <Badge variant="outline">Disabled</Badge>}</div><div className="text-xs text-muted-foreground">{a.email}</div></td>
                <td className="px-3 py-2">
                  {a.isInstallAdmin && !a.grantedOn ? <Badge variant="secondary"><ShieldCheck className="size-3" /> Install administrator</Badge> : (
                    <Switch checked={a.isEnvAdmin} disabled={busy} aria-label={`${a.name} administers ${env.name}`} onCheckedChange={(v) => run(() => grantAccess(env.id, a.userId, v), v ? `${a.name} administers "${env.name}"` : `${a.name} no longer administers "${env.name}"`)} />
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{a.grantedOn ? fmtDate(a.grantedOn) : 'Always'}</td>
                <td className="px-3 py-2 text-right">
                  {a.grantedOn && a.userId !== me && <Button size="xs" variant="ghost" disabled={busy} onClick={() => run(() => revokeAccess(env.id, a.userId), `${a.name} can no longer enter "${env.name}"`)} data-testid={`env-access-revoke-${a.userId}`}>Remove</Button>}
                </td>
              </tr>
            ))}
            {items && items.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Nobody yet.</td></tr>}
            {!items && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground"><Spinner className="mr-2 inline" /> Loading…</td></tr>}
          </tbody>
        </table>
      </Panel>
      <p className="mt-2 text-[11px] text-muted-foreground">Removing someone also removes every role they held here.</p>
    </div>
  )
}
