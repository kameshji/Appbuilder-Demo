import { useEffect, useState } from 'react'
import { Eye, Info, Plus, Search, ShieldCheck, SlidersHorizontal, Trash2, Users } from 'lucide-react'
import { go } from '@/router'
import { platform, usePlatform, type AccessScope, type RoleDef, type TablePrivilege } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Empty, Field, Panel, PageHeader, Segmented, useToast } from './kit'
import { TableRules } from './RoleRules'
import { SCOPE_OPTIONS, emptyPrivilege, isMakerRole, useCaps } from './security'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { WhoCanSeeDialog } from './Explain'
import { fetchSecurityPreview, type TablePreview } from './serverApi'
import { Spinner } from '@/components/ui/spinner'
import { matches, useSearch } from './Shell'

/** a scope picker: eight scopes are too many for a segmented control; each has a plain-language description */
function ScopeSelect({ value, onChange, label, disabled, testId }: { value: AccessScope; onChange(v: AccessScope): void; label: string; disabled: boolean; testId: string }) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v as AccessScope)}>
      <SelectTrigger size="sm" className="w-32" aria-label={label} data-testid={testId} title={SCOPE_OPTIONS.find((o) => o.value === value)?.title}><SelectValue>{SCOPE_OPTIONS.find((o) => o.value === value)?.label}</SelectValue></SelectTrigger>
      <SelectContent>
        {SCOPE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="grid"><span>{o.label}</span><span className="text-[11px] text-muted-foreground">{o.title}</span></span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function NewRoleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(o: boolean): void; onCreated(r: RoleDef): void }) {
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setDesc('') } }, [open])
  const run = async () => {
    setBusy(true)
    try {
      const r = await platform.security.createRole({ name: name.trim(), description: desc.trim() || undefined })
      toast(`Created role "${r.name}"`, 'success')
      onOpenChange(false)
      onCreated(r)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-role-dialog">
        <DialogHeader><DialogTitle>New security role</DialogTitle><DialogDescription>Start with no access, then grant privileges per table.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run() }}>
          <Field label="Role name" htmlFor="new-role-name"><Input id="new-role-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="new-role-name" /></Field>
          <Field label="Description (optional)"><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()} data-testid="new-role-create">Create role</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RoleEditor({ role }: { role: RoleDef }) {
  const tables = usePlatform((s) => s.tables)
  const apps = usePlatform((s) => s.apps)
  const { fail, toast } = useToast()
  const [name, setName] = useState(role.name)
  const [desc, setDesc] = useState(role.description ?? '')
  const [del, setDel] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  useEffect(() => { setDetail(null) }, [role.id])
  useEffect(() => { setName(role.name); setDesc(role.description ?? '') }, [role.id, role.name, role.description])

  const patch = (p: Partial<Omit<RoleDef, 'id'>>) => { platform.security.updateRole(role.id, p).catch(fail) }
  const priv = (tableId: string): TablePrivilege => role.privileges.find((p) => p.table === tableId) ?? emptyPrivilege(tableId)
  const setPriv = (tableId: string, change: Partial<TablePrivilege>) => {
    const full = tables.map((t) => (t.id === tableId ? { ...priv(t.id), ...change } : priv(t.id)))
    patch({ privileges: full })
  }
  const preset = (kind: 'all' | 'read' | 'none') => {
    patch({
      privileges: tables.map((t) => ({
        table: t.id,
        create: kind === 'all',
        read: kind === 'none' ? 'none' : 'all',
        update: kind === 'all' ? 'all' : 'none',
        delete: kind === 'all' ? 'all' : 'none',
      })),
    })
  }
  const appsAll = role.apps === 'all'
  const appList = role.apps === 'all' ? [] : role.apps
  const adm = !!role.isAdmin

  return (
    <Panel className="flex min-w-0 flex-col" data-testid="role-editor">
      <div className="grid gap-4 border-b border-border p-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Role name" htmlFor="role-name">
            <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const v = name.trim(); if (v && v !== role.name) patch({ name: v }); else setName(role.name) }} data-testid="role-name" />
          </Field>
          <Field label="Description" htmlFor="role-desc">
            <Input id="role-desc" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc.trim() !== (role.description ?? '')) patch({ description: desc.trim() }) }} />
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
          <span>
            <span className="font-medium">Maker</span>
            <span className="block text-xs text-muted-foreground">May create and edit apps, tables and connections.</span>
          </span>
          <Switch checked={adm || isMakerRole(role)} disabled={adm} onCheckedChange={(v) => patch({ isMaker: v } as Partial<RoleDef>)} aria-label="Maker" data-testid="role-maker-switch" />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
          <span>
            <span className="font-medium">Administrator</span>
            <span className="block text-xs text-muted-foreground">Full access to every table, row and app. Overrides the settings below.</span>
          </span>
          <Switch checked={adm} onCheckedChange={(v) => patch({ isAdmin: v })} aria-label="Administrator" data-testid="role-admin-switch" />
        </label>
      </div>

      <div className="border-b border-border p-5">
        <div className="mb-3 flex items-center">
          <h3 className="text-sm font-semibold">Table privileges</h3>
          {!adm && tables.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Set all:</span>
              <Button size="xs" variant="outline" onClick={() => preset('all')}>Full access</Button>
              <Button size="xs" variant="outline" onClick={() => preset('read')}>Read only</Button>
              <Button size="xs" variant="outline" onClick={() => preset('none')}>No access</Button>
            </div>
          )}
        </div>
        {tables.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no tables yet.</p>
        ) : (
          <div className={cn('overflow-x-auto rounded-lg border border-border')}>
            <table className="w-full text-sm" data-testid="role-matrix">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                  <th className="px-3 py-2">Table</th>
                  <th className="w-20 px-3 py-2 text-center">Create</th>
                  <th className="px-3 py-2">Read</th>
                  <th className="px-3 py-2">Update</th>
                  <th className="px-3 py-2">Delete</th>
                  <th className="px-3 py-2" title="Rows the role may share with other people and teams (tables with sharing on); owners can always share their rows">Share</th>
                  <th className="w-28 px-3 py-2 text-right"><span className="sr-only">Finer rules</span></th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => {
                  const p: TablePrivilege = adm ? { table: t.id, create: true, read: 'all' as AccessScope, update: 'all' as AccessScope, delete: 'all' as AccessScope } : priv(t.id)
                  return (
                    <tr key={t.id} className="border-b border-border last:border-0" data-testid={`matrix-row-${t.id}`}>
                      <td className="px-3 py-2 font-medium">{t.displayName}</td>
                      <td className="px-3 py-2 text-center">
                        <Checkbox checked={p.create} disabled={adm} onCheckedChange={(v) => setPriv(t.id, { create: v === true })} aria-label={`Create ${t.displayName}`} data-testid={`priv-${t.id}-create`} />
                      </td>
                      {(['read', 'update', 'delete'] as const).map((op) => (
                        <td key={op} className="px-3 py-1.5">
                          <ScopeSelect label={`${op} ${t.displayName}`} disabled={adm} value={p[op]} onChange={(v) => setPriv(t.id, { [op]: v })} testId={`priv-${t.id}-${op}`} />
                        </td>
                      ))}
                      <td className="px-3 py-1.5">
                        {t.sharing ? <ScopeSelect label={`share ${t.displayName}`} disabled={adm} value={p.share ?? 'none'} onChange={(v) => setPriv(t.id, { share: v === 'none' ? undefined : v })} testId={`priv-${t.id}-share`} /> : <span className="text-xs text-muted-foreground" title="Turn sharing on in the table designer">Off</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {(() => {
                          const n = Object.values(p.columns ?? {}).filter((a) => a !== 'update').length + (p.rowFilter?.length ?? 0)
                          return <Button size="xs" variant={detail === t.id ? 'secondary' : 'outline'} onClick={() => setDetail(detail === t.id ? null : t.id)} data-testid={`matrix-detail-${t.id}`} aria-expanded={detail === t.id}><SlidersHorizontal /> Columns and rows{n ? ` (${n})` : ''}</Button>
                        })()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {(() => {
          const t = tables.find((x) => x.id === detail)
          return t ? <TableRules role={role} table={t} priv={priv(t.id)} disabled={adm} onChange={(c) => setPriv(t.id, c)} onClose={() => setDetail(null)} /> : null
        })()}
      </div>

      <div className="border-b border-border p-5" data-testid="role-apps">
        <h3 className="mb-3 text-sm font-semibold">App access</h3>
        <Segmented label="App access" disabled={adm} value={appsAll || adm ? 'all' : 'some'} onChange={(v) => patch({ apps: v === 'all' ? 'all' : apps.map((a) => a.id) })} options={[{ value: 'all', label: 'All apps' }, { value: 'some', label: 'Selected apps' }]} />
        {!adm && !appsAll && (
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
            {apps.length === 0 && <p className="text-sm text-muted-foreground">There are no apps yet.</p>}
            {apps.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={appList.includes(a.id)} onCheckedChange={(v) => patch({ apps: v === true ? [...appList, a.id] : appList.filter((x) => x !== a.id) })} />
                <span className="truncate">{a.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center p-4">
        <p className="text-xs text-muted-foreground">Changes are saved as you make them.</p>
        <Button variant="outline" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => setDel(true)} data-testid="delete-role-button"><Trash2 /> Delete role</Button>
      </div>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Delete role "${role.name}"?`}
        description="Users who have this role lose its privileges."
        onConfirm={async () => { await platform.security.removeRole(role.id); toast(`Deleted role "${role.name}"`, 'success') }}
      />
    </Panel>
  )
}

export function TestAsUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const users = usePlatform((s) => s.users)
  const tables = usePlatform((s) => s.tables)
  const { fail } = useToast()
  const [userId, setUserId] = useState('')
  const [rows, setRows] = useState<TablePreview[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setRows(null); setUserId((u) => u || users[0]?.id || '') } }, [open, users])
  useEffect(() => {
    if (!open || !userId) return
    let alive = true
    setBusy(true)
    setRows(null)
    fetchSecurityPreview(userId).then((r) => alive && setRows(r)).catch((e) => { if (alive) fail(e) }).finally(() => alive && setBusy(false))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId])
  const name = (id: string) => tables.find((t) => t.id === id)?.displayName ?? id
  const col = (tid: string, n: string) => tables.find((t) => t.id === tid)?.columns.find((c) => c.name === n)?.displayName ?? n
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl" data-testid="test-as-user-dialog">
        <DialogHeader>
          <DialogTitle>Test as user</DialogTitle>
          <DialogDescription>What the server would show this person: rows they can read and the columns that are hidden or read-only. You stay signed in as yourself.</DialogDescription>
        </DialogHeader>
        <Field label="User" htmlFor="preview-user">
          <select id="preview-user" value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="preview-user" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
        </Field>
        {busy ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Asking the server...</div> : rows && (
          <table className="w-full text-sm" data-testid="preview-table">
            <thead><tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground"><th className="px-3 py-2">Table</th><th className="px-3 py-2 text-right">Visible rows</th><th className="px-3 py-2">Why</th><th className="px-3 py-2">Hidden columns</th><th className="px-3 py-2">Read-only columns</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tableId} className="border-b border-border last:border-0" data-testid={`preview-${r.tableId}`}>
                  <td className="px-3 py-2 font-medium">{name(r.tableId)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.visibleRows}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground" data-testid={`preview-why-${r.tableId}`}>{r.why.length ? r.why.map((w, i) => <div key={i}>{w}</div>) : 'No role grants read'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.hiddenColumns.map((n) => col(r.tableId, n)).join(', ') || 'None'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.readOnlyColumns.map((n) => col(r.tableId, n)).join(', ') || 'None'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No table access.</td></tr>}
            </tbody>
          </table>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Roles() {
  const server = usePlatform((s) => s.mode) === 'server'
  const caps = useCaps()
  const [preview, setPreview] = useState(false)
  const [who, setWho] = useState(false)
  const roles = usePlatform((s) => s.roles)
  const users = usePlatform((s) => s.users)
  const q = useSearch()
  const [selId, setSelId] = useState<string>('')
  const [newRole, setNewRole] = useState(false)
  const list = roles.filter((r) => matches(q, r.name, r.description))
  const selected = roles.find((r) => r.id === selId) ?? list[0]

  return (
    <div data-testid="page-roles">
      <PageHeader
        icon={ShieldCheck}
        title="Security roles"
        subtitle="Decide who can see and change which tables, and which apps they can run."
        actions={
          <>
            {caps.isAdmin && <Button size="sm" variant="outline" onClick={() => go({ page: 'admin', id: 'users' })} data-testid="roles-users-link"><Users /> Users ({users.length})</Button>}
            {server && caps.isAdmin && <Button size="sm" variant="outline" onClick={() => setPreview(true)} data-testid="test-as-user-button"><Eye /> Test as user</Button>}
            {caps.isAdmin && <Button size="sm" variant="outline" onClick={() => setWho(true)} data-testid="who-can-see-button"><Search /> Who can see a row?</Button>}
            <Button size="sm" onClick={() => setNewRole(true)} data-testid="new-role-button"><Plus /> New role</Button>
          </>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground" data-testid="roles-note">
        <Info className="mt-px size-3.5 shrink-0 text-primary" />
        <span>
          {server ? 'The server enforces roles on every request: table access, hidden and read-only columns, and row filters.' : 'Demo mode: roles are simulated in this browser and are not a security boundary. Connect the local server for real enforcement.'}
          {' '}People and their roles are managed in <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => go({ page: 'admin', id: 'users' })}>Admin console &gt; Users</button>.
        </span>
      </div>

      {roles.length === 0 ? (
        <Empty icon={ShieldCheck} title="No roles yet" description="Create a role to control access to tables and apps." action={<Button onClick={() => setNewRole(true)}><Plus /> New role</Button>} />
      ) : (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] items-start gap-4">
          <Panel className="overflow-hidden" data-testid="role-list">
            {list.length === 0 && <div className="p-4 text-sm text-muted-foreground">No roles match "{q}".</div>}
            <ul role="list">
              {list.map((r) => (
                <li key={r.id} className="border-b border-border last:border-0">
                  <button type="button" data-testid={`role-item-${r.id}`} aria-current={selected?.id === r.id} onClick={() => setSelId(r.id)} className={cn('flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left outline-none focus-visible:bg-accent/70', selected?.id === r.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40')}>
                    <ShieldCheck className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{users.filter((u) => u.roleIds.includes(r.id)).length === 1 ? '1 user' : `${users.filter((u) => u.roleIds.includes(r.id)).length} users`}{r.description ? ` · ${r.description}` : ''}</span>
                    </span>
                    {r.isAdmin && <Badge variant="secondary">Admin</Badge>}
                    {!r.isAdmin && isMakerRole(r) && <Badge variant="outline">Maker</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {selected && <RoleEditor key={selected.id} role={selected} />}
        </div>
      )}

      <NewRoleDialog open={newRole} onOpenChange={setNewRole} onCreated={(r) => setSelId(r.id)} />
      <TestAsUserDialog open={preview} onOpenChange={setPreview} />
      <WhoCanSeeDialog open={who} onOpenChange={setWho} />
    </div>
  )
}
