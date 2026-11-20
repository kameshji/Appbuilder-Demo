/**
 * User management: the primary place is Admin console > Users (#admin-users). Create users, set or reset their
 * password, enable or disable them, assign roles; shows the sign-in state the server returns (no password yet, must
 * change the password an administrator set, last sign-in). Roles themselves stay under Security roles (#roles).
 */
import { wipeDeviceData } from '@/phone/offline'
import { useEffect, useState } from 'react'
import { Ban, CircleCheck, Eye, Info, KeyRound, LogOut, Mail, MoreHorizontal, Pencil, Plus, ShieldCheck, ShieldOff, Smartphone, Trash2, Upload, UserRound, Users as UsersIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SessionList } from './Identity'
import {
  createResetCode, endUserSession, endUserSessions, inviteUser, resetUserMfa, revokeInvitation, userSessions, usersIdentity, type SessionEntry, type UserIdentityState,
} from './identityApi'
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
import { usePresence } from '@/platform/useLive'
import { matches, useSearch } from './Shell'
import { useCaps } from './security'
import { OrgFields, UserImportDialog, orgFieldsOf, orgPatch, type OrgFieldsValue } from './Organisation'
import { fetchDirectoryVisibility, saveDirectoryVisibility, type DirectoryVisibility } from './eventsApi'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

function UserDialog({ open, onOpenChange, user, onCreated, emailConfigured }: { open: boolean; onOpenChange(o: boolean): void; user: UserDef | null; onCreated(u: UserDef, invite: boolean): void; emailConfigured?: boolean }) {
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
  const [org, setOrg] = useState<OrgFieldsValue>(orgFieldsOf(null))
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState(true)
  useEffect(() => { if (open) { setName(user?.name ?? ''); setEmail(user?.email ?? ''); setRoleIds(user?.roleIds ?? []); setInstallAdmin(!!user?.isInstallAdmin); setOrg(orgFieldsOf(user)) } }, [open, user])
  useEffect(() => { if (open) setInvite(!!emailConfigured) }, [open, emailConfigured])
  const run = async () => {
    setBusy(true)
    try {
      const flag = server && caps.isInstallAdmin && installAdmin !== !!user?.isInstallAdmin ? { isInstallAdmin: installAdmin } : {}
      const orgChange = account ? orgPatch(user, org) : {}
      if (user) await platform.security.updateUser(user.id, account ? { name: name.trim(), email: email.trim(), roleIds, ...flag, ...orgChange } : { roleIds })
      else {
        const u = await platform.security.createUser({ name: name.trim(), email: email.trim(), roleIds, ...flag, ...orgChange } as Parameters<typeof platform.security.createUser>[0])
        toast(`Added ${name.trim()}`, 'success')
        onOpenChange(false)
        onCreated(u, server && !!emailConfigured && invite)
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
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl" data-testid="user-dialog">
        <DialogHeader><DialogTitle>{user ? 'Edit user' : 'Add user'}</DialogTitle><DialogDescription>{!server ? 'Users are people you can run apps as on this machine.' : user ? 'Name, email and roles of this account.' : emailConfigured ? 'Send an invitation (they choose their own password), or set a temporary password yourself.' : 'After adding a user you set a temporary password; they choose their own at the first sign-in. (Set up email in Admin console > Email to send invitations instead.)'}</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && email.trim()) void run() }}>
          <Field label="Name" htmlFor="user-name"><Input id="user-name" autoFocus value={name} disabled={!account} onChange={(e) => setName(e.target.value)} data-testid="user-name" /></Field>
          <Field label="Email" htmlFor="user-email"><Input id="user-email" type="email" value={email} disabled={!account} onChange={(e) => setEmail(e.target.value)} data-testid="user-email" /></Field>
          <OrgFields value={org} onChange={setOrg} userId={user?.id} disabled={!account} />
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
          {server && !user && caps.isInstallAdmin && emailConfigured && (
            <div className="grid gap-1.5 rounded-lg border border-border p-3 text-sm" role="radiogroup" aria-label="First password">
              <label className="flex items-center gap-2"><input type="radio" name="first-pw" checked={invite} onChange={() => setInvite(true)} data-testid="user-invite" /> Send an invitation email (link valid for 7 days)</label>
              <label className="flex items-center gap-2"><input type="radio" name="first-pw" checked={!invite} onChange={() => setInvite(false)} data-testid="user-temp-password" /> Set a temporary password now</label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim() || !email.trim()} data-testid="user-save">{user ? 'Save' : server && emailConfigured && invite ? 'Add and invite' : 'Add user'}</Button>
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
  const [importing, setImporting] = useState(false)
  const [idState, setIdState] = useState<{ users: Record<string, UserIdentityState>; emailConfigured: boolean } | null>(null)
  const [sessUser, setSessUser] = useState<UserDef | null>(null)
  const [resetCode, setResetCode] = useState<{ user: UserDef; code: string; expiresOn: string } | null>(null)
  const [mfaUser, setMfaUser] = useState<UserDef | null>(null)
  const reloadIdentity = () => { if (server) usersIdentity().then(setIdState).catch(() => setIdState(null)) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reloadIdentity, [server, users.length])
  const departments = usePlatform((s) => s.departments)
  const deptName = (id?: string) => departments.find((d) => d.id === id)?.name
  // service accounts have their own page (Admin console > Service accounts)
  const ulist = users.filter((u) => u.kind !== 'service' && matches(q, u.name, u.email))
  // who is online now (package H; administrators only, people hiding their presence are left out)
  const onlineMembers = usePresence(server ? 'online' : null, null)
  const online = new Set(onlineMembers.map((m) => m.id))
  const isMe = (u: UserDef) => (server ? u.id === session?.user.id : u.id === currentUserId)
  const cols = server ? 7 : 5

  return (
    <div data-testid="admin-users">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Users</h2>
          <p className="text-sm text-muted-foreground">{server ? `People who can sign in (accounts are shared by every environment), their roles in ${envName ?? 'this environment'} and their sign-in state.${account ? '' : ' Only install administrators add, disable or delete accounts.'}` : 'People you can run apps as in this browser (demo mode has no sign-in).'}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => go({ page: 'roles' })} data-testid="users-roles-link"><ShieldCheck /> Security roles</Button>
        {server && <Button size="sm" variant="outline" onClick={() => setPreview(true)} data-testid="users-test-as"><Eye /> Test as user</Button>}
        <Button size="sm" variant="outline" onClick={() => setImporting(true)} disabled={!account} title={account ? 'Add or update many users from a CSV file' : 'Only install administrators import accounts'} data-testid="import-users-button"><Upload /> Import CSV</Button>
        <Button size="sm" onClick={() => setUserDlg({ user: null })} disabled={!account} title={account ? undefined : 'Only install administrators add accounts'} data-testid="new-user-button"><Plus /> Add user</Button>
      </div>
      {server && <DirectoryVisibilitySetting />}
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
                <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Email</th><th className="px-4 py-2.5">Department</th><th className="px-4 py-2.5">Roles</th>{server && <th className="px-4 py-2.5">Sign-in</th>}{server && <th className="px-4 py-2.5">Last sign-in</th>}<th className="w-40 px-4 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {ulist.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-accent/40" data-testid={`user-row-${u.id}`}>
                  <td className="px-4 py-2.5 font-medium">
                    <span className="flex items-center gap-2.5">
                      <span className="relative">
                        <UserAvatar user={u} size={24} />
                        {server && (online.has(u.id) || isMe(u)) && <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-card" title="Online now" aria-label="Online now" data-testid={`user-online-${u.id}`} />}
                      </span>
                      <span className="truncate">{u.name}</span>
                      {isMe(u) && <Badge variant="secondary">{server ? 'You' : 'Running as'}</Badge>}
                      {server && u.isInstallAdmin && <Badge variant="outline" className="border-rose-500/40 text-rose-700 dark:text-rose-300" title="Install administrator: environments, accounts; administers every environment" data-testid={`install-admin-${u.id}`}>Install admin</Badge>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-2.5 text-xs" data-testid={`user-dept-${u.id}`}>{deptName(u.departmentId) ?? <span className="text-muted-foreground">None</span>}{u.jobTitle && <div className="text-muted-foreground">{u.jobTitle}</div>}</td>
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
                        {!u.hasPassword && !idState?.users[u.id]?.invitation && <Badge variant="outline" title="Cannot sign in until a password is set (invitation or temporary password)">No password</Badge>}
                        {u.hasPassword && u.mustChangePassword && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300" title="An administrator set the password; the user chooses a new one at the next sign-in" data-testid={`must-change-${u.id}`}>Must change password</Badge>}
                        {idState?.users[u.id]?.mfa && <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300" title={`Two-step verification: ${idState.users[u.id].mfaMethods.join(', ')}`} data-testid={`mfa-${u.id}`}>2-step</Badge>}
                        {idState?.users[u.id]?.invitation && <Badge variant="outline" title={`Invitation sent ${fmtDate(idState.users[u.id].invitation!.createdOn)}`} data-testid={`invited-${u.id}`}>Invited, until {fmtDate(idState.users[u.id].invitation!.expiresOn)}</Badge>}
                        {!u.hasPassword && idState?.users[u.id]?.invitationExpired && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">Invitation expired</Badge>}
                      </div>
                    </td>
                  )}
                  {server && <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground" data-testid={`last-login-${u.id}`} title={u.lastLogin ? fmtDate(u.lastLogin) : undefined}>{u.lastLogin ? fmtRelative(u.lastLogin) : 'Never'}</td>}
                  <td className="px-4 py-1.5">
                    <div className="flex justify-end gap-1">
                      {server && <Button variant="ghost" size="icon-sm" aria-label={`${u.hasPassword ? 'Reset' : 'Set'} password for ${u.name}`} title={u.hasPassword ? 'Reset password' : 'Set password'} disabled={!account && !isMe(u)} onClick={() => setPwUser(u)} data-testid={`password-${u.id}`}><KeyRound /></Button>}
                      {server && <Button variant="ghost" size="icon-sm" aria-label={u.status === 'disabled' ? `Enable ${u.name}` : `Disable ${u.name}`} title={isMe(u) ? 'You cannot disable yourself' : u.status === 'disabled' ? 'Enable user' : 'Disable user'} disabled={isMe(u) || !account} data-testid={`toggle-status-${u.id}`} onClick={() => { platform.security.updateUser(u.id, { status: u.status === 'disabled' ? 'active' : 'disabled' }).then(() => toast(u.status === 'disabled' ? `${u.name} can sign in again` : `${u.name} is disabled and signed out`, 'success')).catch(fail) }}>{u.status === 'disabled' ? <CircleCheck /> : <Ban />}</Button>}
                      {server && account && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Sign-in actions for ${u.name}`} title="Sessions, reset code, two-step verification, invitation" data-testid={`signin-menu-${u.id}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setSessUser(u)} data-testid={`sessions-${u.id}`}><LogOut /> Sessions{idState?.users[u.id]?.sessions ? ` (${idState.users[u.id].sessions})` : ''}</DropdownMenuItem>
                            {/* P2-A: a lost phone: its offline data can no longer be read or sent */}
                            {!isMe(u) && <DropdownMenuItem onSelect={() => { if (window.confirm(`Wipe the phone and offline data of ${u.name}? Changes still waiting on their devices are lost.`)) wipeDeviceData(u.id).then(() => toast(`Offline data of ${u.name} wiped on every device`, 'success')).catch(fail) }} data-testid={`wipe-devices-${u.id}`}><Smartphone /> Wipe phone and offline data</DropdownMenuItem>}
                            {!isMe(u) && <DropdownMenuItem onSelect={() => { createResetCode(u.id).then((r) => setResetCode({ user: u, code: r.code, expiresOn: r.expiresOn })).catch(fail) }} data-testid={`reset-code-${u.id}`}><KeyRound /> Create one-time reset code</DropdownMenuItem>}
                            {!isMe(u) && idState?.users[u.id]?.mfa && <DropdownMenuItem onSelect={() => setMfaUser(u)} data-testid={`mfa-reset-${u.id}`}><ShieldOff /> Reset two-step verification</DropdownMenuItem>}
                            {!u.hasPassword && idState?.emailConfigured && <DropdownMenuSeparator />}
                            {!u.hasPassword && idState?.emailConfigured && <DropdownMenuItem onSelect={() => { inviteUser(u.id).then(() => { toast(`Invitation sent to ${u.email}`, 'success'); reloadIdentity() }).catch(fail) }} data-testid={`invite-${u.id}`}><Mail /> {idState.users[u.id]?.invitation ? 'Resend invitation' : 'Send invitation'}</DropdownMenuItem>}
                            {idState?.users[u.id]?.invitation && <DropdownMenuItem onSelect={() => { revokeInvitation(u.id).then(() => { toast('Invitation revoked', 'success'); reloadIdentity() }).catch(fail) }} data-testid={`invite-revoke-${u.id}`}><Ban /> Revoke invitation</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
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
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><UsersIcon className="size-3.5" /> {users.length === 1 ? '1 user' : `${users.length} users`}. Departments, teams and the org chart have their own pages in this console.</p>

      <UserDialog
        open={!!userDlg} onOpenChange={(o) => !o && setUserDlg(null)} user={userDlg?.user ?? null} emailConfigured={!!idState?.emailConfigured}
        onCreated={(u, invite) => {
          if (!server) return
          if (invite) inviteUser(u.id).then(() => { toast(`Invitation sent to ${u.email}`, 'success'); reloadIdentity() }).catch((e) => { fail(e); setPwUser(u) })
          else setPwUser(u)
        }}
      />
      <UserSessionsDialog user={sessUser} onOpenChange={(o) => { if (!o) { setSessUser(null); reloadIdentity() } }} />
      <Dialog open={!!resetCode} onOpenChange={(o) => !o && setResetCode(null)}>
        <DialogContent data-testid="reset-code-dialog">
          <DialogHeader>
            <DialogTitle>One-time reset code for {resetCode?.user.name}</DialogTitle>
            <DialogDescription>Give it to {resetCode?.user.email} in person or by phone. On the sign-in screen they choose "Forgot your password?", then "I have a reset code". It works once, until {resetCode ? fmtDate(resetCode.expiresOn) : ''}. It is not shown again.</DialogDescription>
          </DialogHeader>
          <code className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-center font-mono text-xl tracking-widest" data-testid="reset-code-value">{resetCode?.code}</code>
          <DialogFooter><Button onClick={() => setResetCode(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!mfaUser}
        onOpenChange={(o) => !o && setMfaUser(null)}
        title={`Reset two-step verification of ${mfaUser?.name ?? ''}?`}
        description="Their authenticator app, email codes, recovery codes and remembered devices are removed and every session ends. They sign in with the password alone (and set it up again when your policy requires it). Recorded in the audit log."
        confirmLabel="Reset"
        onConfirm={async () => { if (mfaUser) { await resetUserMfa(mfaUser.id); toast(`Two-step verification of ${mfaUser.name} was reset`, 'success'); reloadIdentity() } }}
      />
      <UserPasswordDialog user={pwUser} onOpenChange={(o) => !o && setPwUser(null)} />
      <TestAsUserDialog open={preview} onOpenChange={setPreview} />
      <UserImportDialog open={importing} onOpenChange={setImporting} />
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

function UserSessionsDialog({ user, onOpenChange }: { user: UserDef | null; onOpenChange(o: boolean): void }) {
  const { toast, fail } = useToast()
  const [items, setItems] = useState<SessionEntry[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = () => { if (user) userSessions(user.id).then((r) => setItems(r.items)).catch(fail) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setItems(null); load() }, [user?.id])
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="user-sessions-dialog">
        <DialogHeader>
          <DialogTitle>Sessions of {user?.name}</DialogTitle>
          <DialogDescription>Where this account is signed in. Ending a session signs that browser out at once (open pages lose their live connection too).</DialogDescription>
        </DialogHeader>
        {items ? <SessionList items={items} busyId={busyId} onEnd={(x) => { if (!user) return; setBusyId(x.id); endUserSession(user.id, x.id).then(() => { toast('Session ended', 'success'); load() }).catch(fail).finally(() => setBusyId(null)) }} testId="user-session-list" /> : <Spinner />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="destructive" disabled={!items?.length || items.some((x) => x.current)} onClick={() => { if (user) endUserSessions(user.id).then(() => { toast(`${user.name} was signed out everywhere`, 'success'); load() }).catch(fail) }} data-testid="user-sessions-end-all"><LogOut /> Sign out everywhere</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** environment setting: whom non-administrators see in the Users table, person pickers, @mentions and the share dialog */
function DirectoryVisibilitySetting() {
  const { fail, toast } = useToast()
  const [v, setV] = useState<DirectoryVisibility | null>(null)
  useEffect(() => { fetchDirectoryVisibility().then(setV).catch(() => setV(null)) }, [])
  if (!v) return null
  return (
    <Panel className="mb-4 flex flex-wrap items-center gap-3 p-3 text-sm" data-testid="directory-visibility">
      <div className="min-w-0 flex-1">
        <div className="font-medium">Directory visibility</div>
        <div className="text-xs text-muted-foreground">Whom people who are not administrators see in the Users table, person pickers, @mentions and the share dialog of this environment. Everyone always sees themselves; administrators see everyone.</div>
      </div>
      <Select value={v} onValueChange={(x) => saveDirectoryVisibility(x as DirectoryVisibility).then((r) => { setV(r.visibility); toast('Directory visibility saved', 'success') }).catch(fail)}>
        <SelectTrigger size="sm" className="w-64" data-testid="directory-visibility-select"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="everyone">Everyone in this environment</SelectItem>
          <SelectItem value="department">People in the same department</SelectItem>
          <SelectItem value="admins">Only administrators see the directory</SelectItem>
        </SelectContent>
      </Select>
    </Panel>
  )
}
