/**
 * Who is signed in, as the shell shows it: the avatar circle, the avatar menu at the right end of the top bar
 * (Studio command bar too) and the Settings entry at the bottom of the sidebar.
 */
import { beforeSignOut } from '@/phone/offline'
import { useState } from 'react'
import { Check, KeyRound, LogOut, Settings as Gear, UserRound, Users } from 'lucide-react'
import { platform, usePlatform, type UserDef } from '@/platform'
import { AVATAR_HEX, avatarColorOf, initialsOf, usePrefs } from '@/platform/preferences'
import { go, parseRoute, type Route } from '@/router'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ChangePasswordDialog } from './Auth'
import { useToast } from './kit'
import { useCaps } from './security'

/** the signed-in user (server mode) or the run-as user (demo mode); null while nobody is known */
export function useMe(): { user: UserDef | null; demo: boolean } {
  const mode = usePlatform((s) => s.mode)
  const session = usePlatform((s) => s.session)
  const users = usePlatform((s) => s.users)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const demo = mode !== 'server'
  return { user: demo ? (users.find((u) => u.id === currentUserId) ?? null) : (session?.user ?? null), demo }
}

/* ------------------------------------------------------------------ return route of Settings */

let settingsReturn: Route | null = null
/** open Settings (optionally a section), remembering where to come back to */
export function openSettings(section?: string) {
  const here = parseRoute(location.hash)
  if (here.page !== 'settings') settingsReturn = here
  go(section ? { page: 'settings', id: section } : { page: 'settings' })
}
/** where the Settings close button goes: the page Settings was opened from, else the start page of the mode */
export function settingsReturnRoute(fallback: Route): Route {
  return settingsReturn ?? fallback
}

/* ------------------------------------------------------------------ avatar */

/** circle with the initials; the colour is the user's choice (their own avatar) or derived from the id */
export function UserAvatar({ user, size = 28, className }: { user: Pick<UserDef, 'id' | 'name' | 'email'> | null; size?: number; className?: string }) {
  const meId = usePlatform((s) => s.session?.user.id ?? s.currentUserId)
  const choice = usePrefs((s) => s.avatarColor)
  if (!user) {
    return (
      <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground', className)} style={{ width: size, height: size }}>
        <UserRound style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    )
  }
  const color = avatarColorOf(user.id, user.id === meId ? choice : 'auto')
  return (
    <span
      aria-hidden
      data-avatar-color={color}
      className={cn('grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none text-white', className)}
      style={{ width: size, height: size, background: AVATAR_HEX[color], fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initialsOf(user.name, user.email)}
    </span>
  )
}

/* ------------------------------------------------------------------ avatar menu (top bar) */

/** the last item of the top bar: avatar, tooltip with name and email, and the account menu */
export function ProfileAvatar() {
  const { user, demo } = useMe()
  const users = usePlatform((s) => s.users)
  const roles = usePlatform((s) => s.roles)
  const currentUserId = usePlatform((s) => s.currentUserId)
  const caps = useCaps()
  const { fail, toast } = useToast()
  const [pw, setPw] = useState(false)
  const roleNames = user ? roles.filter((r) => user.roleIds.includes(r.id)).map((r) => r.name) : []

  const signOut = async () => {
    try {
      // P2-A: the offline store and the service worker caches of this user are deleted (asks first if changes wait)
      if (!(await beforeSignOut((t) => window.confirm(t)))) return
      await platform.auth.logout()
      toast('Signed out', 'info')
    } catch (e) {
      fail(e)
    }
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="avatar-menu"
                aria-label={user ? `Account: ${user.name}` : 'Account'}
                className="grid size-8 shrink-0 place-items-center rounded-full outline-none ring-offset-2 ring-offset-card transition-shadow hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <UserAvatar user={user} size={28} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            <div className="font-medium">{user?.name ?? 'Nobody signed in'}</div>
            {user?.email && <div className="opacity-80">{user.email}</div>}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64" data-testid="avatar-menu-content">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <UserAvatar user={user} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" data-testid="avatar-menu-name">{user?.name}</div>
              <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
              {roleNames.length > 0 && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{roleNames.join(', ')}</div>}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openSettings('profile')} data-testid="menu-profile-settings"><UserRound /> Profile settings</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings()} data-testid="menu-settings"><Gear /> Settings</DropdownMenuItem>
          {!demo && <DropdownMenuItem onSelect={() => setPw(true)} data-testid="menu-change-password"><KeyRound /> Change password</DropdownMenuItem>}
          {demo && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Switch user (demo)</DropdownMenuLabel>
              <div className="max-h-64 overflow-y-auto">
                {users.map((u) => (
                  <DropdownMenuItem
                    key={u.id}
                    data-testid={`run-as-${u.id}`}
                    onSelect={() => {
                      try {
                        platform.security.setCurrentUser(u.id)
                      } catch (e) {
                        fail(e)
                      }
                    }}
                  >
                    <UserAvatar user={u} size={22} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{u.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                    </div>
                    {u.id === currentUserId && <Check className="text-primary" />}
                  </DropdownMenuItem>
                ))}
              </div>
              {users.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No users. An administrator adds them in the Admin console.</div>}
              {caps.isAdmin && <DropdownMenuItem onSelect={() => go({ page: 'admin', id: 'users' })} data-testid="menu-manage-users"><Users /> Manage users...</DropdownMenuItem>}
              <div className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">Demo mode simulates security in this browser. Sign-in needs the local server.</div>
            </>
          )}
          {!demo && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { void signOut() }} data-testid="menu-sign-out"><LogOut /> Sign out</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!demo && <ChangePasswordDialog open={pw} onOpenChange={setPw} />}
    </>
  )
}

/* ------------------------------------------------------------------ Settings entry (sidebar bottom) */

/** bottom-left of the sidebar, like a desktop app: avatar, name, gear; opens Settings */
export function SettingsEntry() {
  const { user, demo } = useMe()
  return (
    <button
      type="button"
      data-testid="settings-entry"
      onClick={() => openSettings()}
      title="Settings"
      className="flex w-full shrink-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <UserAvatar user={user} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{user?.name ?? 'Not signed in'}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{demo ? 'Demo mode' : user?.email}</span>
      </span>
      <Gear className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
