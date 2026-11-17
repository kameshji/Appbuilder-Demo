import { useEffect, useState } from 'react'
import { Info, Pencil, Plus, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react'
import { platform, usePlatform, type AccessScope, type RoleDef, type TablePrivilege, type UserDef } from '@/platform'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Empty, Field, Panel, PageHeader, Segmented, useToast } from './kit'
import { matches, useSearch } from './Shell'

const SCOPES: { value: AccessScope; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'No access' },
  { value: 'own', label: 'Own', title: 'Only rows owned by the user' },
  { value: 'all', label: 'All', title: 'All rows' },
]

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
  useEffect(() => { setName(role.name); setDesc(role.description ?? '') }, [role.id, role.name, role.description])

  const patch = (p: Partial<Omit<RoleDef, 'id'>>) => { platform.security.updateRole(role.id, p).catch(fail) }
  const priv = (tableId: string): TablePrivilege => role.privileges.find((p) => p.table === tableId) ?? { table: tableId, create: false, read: 'none', update: 'none', delete: 'none' }
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
          <div className={cn('overflow-hidden rounded-lg border border-border')}>
            <table className="w-full text-sm" data-testid="role-matrix">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                  <th className="px-3 py-2">Table</th>
                  <th className="w-20 px-3 py-2 text-center">Create</th>
                  <th className="px-3 py-2">Read</th>
                  <th className="px-3 py-2">Update</th>
                  <th className="px-3 py-2">Delete</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => {
                  const p = adm ? { table: t.id, create: true, read: 'all' as AccessScope, update: 'all' as AccessScope, delete: 'all' as AccessScope } : priv(t.id)
                  return (
                    <tr key={t.id} className="border-b border-border last:border-0" data-testid={`matrix-row-${t.id}`}>
                      <td className="px-3 py-2 font-medium">{t.displayName}</td>
                      <td className="px-3 py-2 text-center">
                        <Checkbox checked={p.create} disabled={adm} onCheckedChange={(v) => setPriv(t.id, { create: v === true })} aria-label={`Create ${t.displayName}`} data-testid={`priv-${t.id}-create`} />
                      </td>
                      {(['read', 'update', 'delete'] as const).map((op) => (
                        <td key={op} className="px-3 py-1.5">
                          <Segmented size="sm" label={`${op} ${t.displayName}`} disabled={adm} value={p[op]} onChange={(v) => setPriv(t.id, { [op]: v })} options={SCOPES} />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
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

function UserDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange(o: boolean): void; user: UserDef | null }) {
  const roles = usePlatform((s) => s.roles)
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(user?.name ?? ''); setEmail(user?.email ?? ''); setRoleIds(user?.roleIds ?? []) } }, [open, user])
  const run = async () => {
    setBusy(true)
    try {
      if (user) await platform.security.updateUser(user.id, { name: name.trim(), email: email.trim(), roleIds })
      else await platform.security.createUser({ name: name.trim(), email: email.trim(), roleIds })
      toast(user ? 'User updated' : `Added ${name.trim()}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="user-dialog">
        <DialogHeader><DialogTitle>{user ? 'Edit user' : 'Add user'}</DialogTitle><DialogDescription>Users are people you can run apps as on this machine.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && email.trim()) void run() }}>
          <Field label="Name" htmlFor="user-name"><Input id="user-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="user-name" /></Field>
          <Field label="Email" htmlFor="user-email"><Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="user-email" /></Field>
          <div className="grid gap-2">
            <Label className="text-xs font-medium">Roles</Label>
            {roles.length === 0 && <p className="text-sm text-muted-foreground">No roles exist yet.</p>}
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={roleIds.includes(r.id)} onCheckedChange={(v) => setRoleIds(v === true ? [...roleIds, r.id] : roleIds.filter((x) => x !== r.id))} />
                {r.name}{r.isAdmin && <Badge variant="secondary">Admin</Badge>}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim() || !email.trim()} data-testid="user-save">{user ? 'Save' : 'Add user'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Roles() {
  const roles = usePlatform((s) => s.roles)
  const users = usePlatform((s) => s.users)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const q = useSearch()
  const { toast } = useToast()
  const [view, setView] = useState<'roles' | 'users'>('roles')
  const [selId, setSelId] = useState<string>('')
  const [newRole, setNewRole] = useState(false)
  const [userDlg, setUserDlg] = useState<{ user: UserDef | null } | null>(null)
  const [delUser, setDelUser] = useState<UserDef | null>(null)
  const list = roles.filter((r) => matches(q, r.name, r.description))
  const selected = roles.find((r) => r.id === selId) ?? list[0]
  const ulist = users.filter((u) => matches(q, u.name, u.email))

  return (
    <div data-testid="page-roles">
      <PageHeader
        icon={ShieldCheck}
        title="Security roles"
        subtitle="Decide who can see and change which tables, and which apps they can run."
        actions={
          <>
            <Segmented label="Section" value={view} onChange={setView} options={[{ value: 'roles', label: <><ShieldCheck className="size-3.5" /> Roles ({roles.length})</> }, { value: 'users', label: <><Users className="size-3.5" /> Users ({users.length})</> }]} />
            {view === 'roles' ? (
              <Button size="sm" onClick={() => setNewRole(true)} data-testid="new-role-button"><Plus /> New role</Button>
            ) : (
              <Button size="sm" onClick={() => setUserDlg({ user: null })} data-testid="new-user-button"><Plus /> Add user</Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground" data-testid="roles-note">
        <Info className="mt-px size-3.5 shrink-0 text-primary" />
        Roles are enforced inside apps on this machine; this is not yet a server-side boundary.
      </div>

      {view === 'roles' ? (
        roles.length === 0 ? (
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
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            {selected && <RoleEditor key={selected.id} role={selected} />}
          </div>
        )
      ) : users.length === 0 ? (
        <Empty icon={UserRound} title="No users yet" description="Add a user to run apps as them." action={<Button onClick={() => setUserDlg({ user: null })}><Plus /> Add user</Button>} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="users-table">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Email</th><th className="px-4 py-2.5">Roles</th><th className="w-24 px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {ulist.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-accent/40" data-testid={`user-row-${u.id}`}>
                  <td className="px-4 py-2.5 font-medium">{u.name}{u.id === currentUserId && <Badge variant="secondary" className="ml-2">Running as</Badge>}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {u.roleIds.map((id) => roles.find((r) => r.id === id)).filter((r): r is RoleDef => !!r).map((r) => <Badge key={r.id} variant="outline">{r.name}</Badge>)}
                      {u.roleIds.length === 0 && <span className="text-xs text-muted-foreground">No roles</span>}
                    </div>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.name}`} onClick={() => setUserDlg({ user: u })}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${u.name}`} onClick={() => setDelUser(u)}><Trash2 /></Button>
                    </div>
                  </td>
                </tr>
              ))}
              {ulist.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">No users match "{q}".</td></tr>}
            </tbody>
          </table>
        </Panel>
      )}

      <NewRoleDialog open={newRole} onOpenChange={setNewRole} onCreated={(r) => { setView('roles'); setSelId(r.id) }} />
      <UserDialog open={!!userDlg} onOpenChange={(o) => !o && setUserDlg(null)} user={userDlg?.user ?? null} />
      <ConfirmDialog
        open={!!delUser}
        onOpenChange={(o) => !o && setDelUser(null)}
        title={`Delete user "${delUser?.name ?? ''}"?`}
        description="The user is removed from this workspace. Rows they own stay in the tables."
        onConfirm={async () => { if (delUser) { await platform.security.removeUser(delUser.id); toast('User deleted', 'success') } }}
      />
    </div>
  )
}
