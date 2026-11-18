/**
 * User management: the primary place is Admin console > Users (#admin-users). Create users, set or reset their
 * password, enable or disable them, assign roles; shows the sign-in state the server returns (no password yet, must
 * change the password an administrator set, last sign-in). Roles themselves stay under Security roles (#roles).
 */
import { useEffect, useState } from 'react'
import { Ban, CircleCheck, Eye, Info, KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserRound, Users as UsersIcon } from 'lucide-react'
import { platform, usePlatform, type RoleDef, type UserDef } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, Empty, Field, Panel, fmtDate, fmtRelative, useToast } from './kit'
import { NewPasswordFields, passwordsValid } from './PasswordFields'
import { TestAsUserDialog } from './Roles'
import { UserAvatar } from './Profile'
import { matches, useSearch } from './Shell'
import { useCaps } from './security'

function UserDialog({ open, onOpenChange, user, onCreated }: { open: boolean; onOpenChange(o: boolean): void; user: UserDef | null; onCreated(u: UserDef): void }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const roles = usePlatform((s) => s.roles)
  const envName = usePlatform((s) => s.environments.find((e) => e.id === s.environmentId)?.name)
  const caps = useCaps()
  // accounts are install-wide: only install administrators change them; environment administrators assign roles
  const account = !server || caps.isInstallAdmin
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [installAdmin, setInstallAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(user?.name ?? ''); setEmail(user?.email ?? ''); setRoleIds(user?.roleIds ?? []); setInstallAdmin(!!user?.isInstallAdmin) } }, [open, user])
  const run = async () => {
    setBusy(true)
    try {
      const flag = server && caps.isInstallAdmin && installAdmin !== !!user?.isInstallAdmin ? { isInstallAdmin: installAdmin } : {}
      if (user) await platform.security.updateUser(user.id, account ? { name: name.trim(), email: email.trim(), roleIds, ...flag } : { roleIds })
      else {
        const u = await platform.security.createUser({ name: name.trim(), email: email.trim(), roleIds, ...flag })
        toast(`Added ${name.trim()}`, 'success')
        onOpenChange(false)
        onCreated(u)
        return
      }
      toast('User updated', 'success')
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
        <DialogHeader><DialogTitle>{user ? 'Edit user' : 'Add user'}</DialogTitle><DialogDescription>{server ? 'After adding a user you set their first password; they can change it themselves.' : 'Users are people you can run apps as on this machine.'}</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && email.trim()) void run() }}>
          <Field label="Name" htmlFor="user-name"><Input id="user-name" autoFocus value={name} disabled={!account} onChange={(e) => setName(e.target.value)} data-testid="user-name" /></Field>
          <Field label="Email" htmlFor="user-email"><Input id="user-email" type="email" value={email} disabled={!account} onChange={(e) => setEmail(e.target.value)} data-testid="user-email" /></Field>
          {server && caps.isInstallAdmin && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={installAdmin} onCheckedChange={(v) => setInstallAdmin(v === true)} data-testid="user-install-admin" className="mt-0.5" />
              <span><span className="font-medium">Install administrator</span><span className="block text-xs text-muted-foreground">Manages environments and user accounts, enters every environment and administers it.</span></span>
            </label>
          )}
          <div className="grid gap-2">
            <Label className="text-xs font-medium">{server && envName ? `Roles in ${envName}` : 'Roles'}</Label>
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

function UserPasswordDialog({ user, onOpenChange }: { user: UserDef | null; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setPw(''); setConfirm(''); setError('') }, [user?.id])
  const valid = passwordsValid(pw, confirm, user?.email)
  const submit = async () => {
    if (!user || !valid) return
    setBusy(true)
    setError('')
    try {
      await platform.security.setPassword(user.id, pw)
      toast(`Password set for ${user.name}. Share it with them securely; it is not shown again.`, 'success')
      setPw(''); setConfirm('')
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent data-testid="user-password-dialog">
        <DialogHeader>
          <DialogTitle>{user?.hasPassword ? 'Reset password' : 'Set password'} for {user?.name}</DialogTitle>
          <DialogDescription>You choose the password and tell the user. It is stored hashed, never shown again, and any open sessions of this user end.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <NewPasswordFields password={pw} confirm={confirm} onPassword={setPw} onConfirm={setConfirm} email={user?.email} idPrefix="up" labelNew="Password" autoFocus />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !valid} data-testid="user-password-save">{busy && <Spinner />} Set password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}


/** Admin console > Users */
export function UsersPanel() {
  const server = usePlatform((s) => s.mode) === 'server'
  const session = usePlatform((s) => s.session)
  const roles = usePlatform((s) => s.roles)
  const users = usePlatform((s) => s.users)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const envName = usePlatform((s) => s.environments.find((e) => e.id === s.environmentId)?.name)
  const caps = useCaps()
  const account = !server || caps.isInstallAdmin
  const q = useSearch()
  const { toast, fail } = useToast()
  const [pwUser, setPwUser] = useState<UserDef | null>(null)
  const [preview, setPreview] = useState(false)
  const [userDlg, setUserDlg] = useState<{ user: UserDef | null } | null>(null)
  const [delUser, setDelUser] = useState<UserDef | null>(null)
  const ulist = users.filter((u) => matches(q, u.name, u.email))
  const isMe = (u: UserDef) => (server ? u.id === session?.user.id : u.id === currentUserId)
  const cols = server ? 6 : 4

  return (
    <div data-testid="admin-users">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Users</h2>
          <p className="text-sm text-muted-foreground">{server ? `People who can sign in (accounts are shared by every environment), their roles in ${envName ?? 'this environment'} and their sign-in state.${account ? '' : ' Only install administrators add, disable or delete accounts.'}` : 'People you can run apps as in this browser (demo mode has no sign-in).'}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => go({ page: 'roles' })} data-testid="users-roles-link"><ShieldCheck /> Security roles</Button>
        {server && <Button size="sm" variant="outline" onClick={() => setPreview(true)} data-testid="users-test-as"><Eye /> Test as user</Button>}
        <Button size="sm" onClick={() => setUserDlg({ user: null })} disabled={!account} title={account ? undefined : 'Only install administrators add accounts'} data-testid="new-user-button"><Plus /> Add user</Button>
      </div>
      {!server && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0 text-primary" />
          Demo mode: passwords, disabling and sign-in need the local server. Switch between users from the avatar menu.
        </div>
      )}
      {users.length === 0 ? (
        <Empty icon={UserRound} title="No users yet" description="Add a user to run apps as them." action={<Button onClick={() => setUserDlg({ user: null })}><Plus /> Add user</Button>} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="users-table">
            <thead>
              <tr className="whitespace-nowrap border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Email</th><th className="px-4 py-2.5">Roles</th>{server && <th className="px-4 py-2.5">Sign-in</th>}{server && <th className="px-4 py-2.5">Last sign-in</th>}<th className="w-40 px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {ulist.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-accent/40" data-testid={`user-row-${u.id}`}>
                  <td className="px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-2.5">
                      <UserAvatar user={u} size={24} />
                      <span className="truncate">{u.name}</span>
                      {isMe(u) && <Badge variant="secondary">{server ? 'You' : 'Running as'}</Badge>}
                      {server && u.isInstallAdmin && <Badge variant="outline" className="border-rose-500/40 text-rose-700 dark:text-rose-300" title="Install administrator: environments, accounts; administers every environment" data-testid={`install-admin-${u.id}`}>Install admin</Badge>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {u.roleIds.map((id) => roles.find((r) => r.id === id)).filter((r): r is RoleDef => !!r).map((r) => <Badge key={r.id} variant="outline">{r.name}</Badge>)}
                      {u.roleIds.length === 0 && <span className="text-xs text-muted-foreground">No roles</span>}
                    </div>
                  </td>
                  {server && (
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1" data-testid={`user-state-${u.id}`}>
                        {u.status === 'disabled' ? <Badge variant="destructive">Disabled</Badge> : <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Active</Badge>}
                        {!u.hasPassword && <Badge variant="outline" title="Cannot sign in until an administrator sets a password">No password</Badge>}
                        {u.hasPassword && u.mustChangePassword && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300" title="An administrator set the password; the user chooses a new one at the next sign-in" data-testid={`must-change-${u.id}`}>Must change password</Badge>}
                      </div>
                    </td>
                  )}
                  {server && <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground" data-testid={`last-login-${u.id}`} title={u.lastLogin ? fmtDate(u.lastLogin) : undefined}>{u.lastLogin ? fmtRelative(u.lastLogin) : 'Never'}</td>}
                  <td className="px-4 py-1.5">
                    <div className="flex justify-end gap-1">
                      {server && <Button variant="ghost" size="icon-sm" aria-label={`${u.hasPassword ? 'Reset' : 'Set'} password for ${u.name}`} title={u.hasPassword ? 'Reset password' : 'Set password'} disabled={!account && !isMe(u)} onClick={() => setPwUser(u)} data-testid={`password-${u.id}`}><KeyRound /></Button>}
                      {server && <Button variant="ghost" size="icon-sm" aria-label={u.status === 'disabled' ? `Enable ${u.name}` : `Disable ${u.name}`} title={isMe(u) ? 'You cannot disable yourself' : u.status === 'disabled' ? 'Enable user' : 'Disable user'} disabled={isMe(u) || !account} data-testid={`toggle-status-${u.id}`} onClick={() => { platform.security.updateUser(u.id, { status: u.status === 'disabled' ? 'active' : 'disabled' }).then(() => toast(u.status === 'disabled' ? `${u.name} can sign in again` : `${u.name} is disabled and signed out`, 'success')).catch(fail) }}>{u.status === 'disabled' ? <CircleCheck /> : <Ban />}</Button>}
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.name}`} title="Edit name, email and roles" onClick={() => setUserDlg({ user: u })} data-testid={`edit-user-${u.id}`}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${u.name}`} title="Delete user" disabled={!account} onClick={() => setDelUser(u)}><Trash2 /></Button>
                    </div>
                  </td>
                </tr>
              ))}
              {ulist.length === 0 && <tr><td colSpan={cols} className="px-4 py-6 text-center text-sm text-muted-foreground">No users match "{q}".</td></tr>}
            </tbody>
          </table>
        </Panel>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><UsersIcon className="size-3.5" /> {users.length === 1 ? '1 user' : `${users.length} users`}. Departments, managers and teams arrive with P0 Kernel.</p>

      <UserDialog open={!!userDlg} onOpenChange={(o) => !o && setUserDlg(null)} user={userDlg?.user ?? null} onCreated={(u) => { if (server) setPwUser(u) }} />
      <UserPasswordDialog user={pwUser} onOpenChange={(o) => !o && setPwUser(null)} />
      <TestAsUserDialog open={preview} onOpenChange={setPreview} />
      <ConfirmDialog
        open={!!delUser}
        onOpenChange={(o) => !o && setDelUser(null)}
        title={`Delete user "${delUser?.name ?? ''}"?`}
        description="The account is removed from every environment of this install. Rows they own stay in the tables."
        onConfirm={async () => { if (delUser) { await platform.security.removeUser(delUser.id); toast('User deleted', 'success') } }}
      />
    </div>
  )
}
