/**
 * Shell state that belongs to the signed-in user and survives a reload (localStorage, every access in try/catch):
 * - the last mode (Dev / User) of makers and admins,
 * - the open app tabs of User mode (app ids, in tab order),
 * - recently opened apps.
 * Keys are per user (`<key>:<userId>`), so two people sharing a browser do not see each other's tabs, and the tabs and
 * recents belong to an environment (`<userId>@<environment>`; Default keeps the plain user key): switching environments
 * closes the other environment's tabs (their apps do not exist there) and brings back this one's.
 */
import { create } from 'zustand'
import { platform, usePlatform } from '@/platform'
import { go } from '@/router'
import type { ShellMode } from './modules'

const MODE_KEY = 'appbuilder-mode'
const TABS_KEY = 'appbuilder-tabs'
const RECENT_KEY = 'appbuilder-recent-apps'
export const MAX_RECENT = 8
export const MAX_TABS = 12

function read<T>(key: string, fallback: T, ok: (v: unknown) => v is T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    return ok(v) ? v : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage refused (private mode, sandbox): state lives for this page only */
  }
}
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isMode = (v: unknown): v is ShellMode => v === 'dev' || v === 'user'

export function readMode(user: string): ShellMode | null {
  return read<ShellMode | null>(`${MODE_KEY}:${user}`, null, (v): v is ShellMode | null => v === null || isMode(v))
}
export function writeMode(user: string, mode: ShellMode) {
  write(`${MODE_KEY}:${user}`, mode)
}

/** the id that keys the signed-in user's shell state ('' while signed out) */
export function useUserKey(): string {
  const mode = usePlatform((s) => s.mode)
  const sessionUser = usePlatform((s) => s.session?.user.id)
  const demoUser = usePlatform((s) => s.currentUserId)
  return (mode === 'server' ? sessionUser : demoUser) ?? ''
}

/** the key of the user's tabs and recents in the current environment ('' while signed out) */
export function useWorkspaceKey(): string {
  const user = useUserKey()
  const env = usePlatform((s) => s.environmentId)
  if (!user) return ''
  return env && env !== 'default' ? `${user}@${env}` : user
}

interface WorkspaceState {
  user: string
  /** open app tabs, in order */
  tabs: string[]
  recent: string[]
  /** switch to a user's saved tabs and recents */
  load(user: string): void
  openTab(id: string): void
  closeTab(id: string): void
  /** drop tabs and recents of apps that no longer exist or that the user may not run */
  prune(keep: (id: string) => boolean): void
  touch(id: string): void
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const save = () => {
    const { user, tabs, recent } = get()
    if (!user) return
    write(`${TABS_KEY}:${user}`, tabs)
    write(`${RECENT_KEY}:${user}`, recent)
  }
  return {
    user: '',
    tabs: [],
    recent: [],
    load(user) {
      if (user === get().user) return
      set({
        user,
        tabs: user ? read(`${TABS_KEY}:${user}`, [], isIdList).slice(0, MAX_TABS) : [],
        recent: user ? read(`${RECENT_KEY}:${user}`, [], isIdList).slice(0, MAX_RECENT) : [],
      })
    },
    openTab(id) {
      const { tabs } = get()
      if (!tabs.includes(id)) set({ tabs: [...tabs, id].slice(-MAX_TABS) })
      get().touch(id)
    },
    closeTab(id) {
      set({ tabs: get().tabs.filter((t) => t !== id) })
      save()
    },
    prune(keep) {
      const { tabs, recent } = get()
      const t = tabs.filter(keep)
      const r = recent.filter(keep)
      if (t.length !== tabs.length || r.length !== recent.length) {
        set({ tabs: t, recent: r })
        save()
      }
    },
    touch(id) {
      set({ recent: [id, ...get().recent.filter((r) => r !== id)].slice(0, MAX_RECENT) })
      save()
    },
  }
})

/** may the signed-in user run this app? (role app access; the server enforces) */
export function canRun(appId: string): boolean {
  try {
    return platform.security.canRunApp(appId)
  } catch {
    return false
  }
}

/** open an app as a tab in User mode (switches to User mode) */
export function openAppTab(id: string) {
  useWorkspace.getState().openTab(id)
  go({ page: 'u', id })
}

/** the standalone run route in its own browser window; false when the browser blocked it */
export function openAppWindow(id: string): boolean {
  let w: Window | null = null
  try {
    w = window.open(`${location.pathname}${location.search}#run-${id}`, `appbuilder-run-${id}`, 'popup,width=1600,height=900')
  } catch {
    w = null
  }
  if (!w) return false
  try {
    w.focus()
  } catch {
    /* ignore */
  }
  useWorkspace.getState().touch(id)
  return true
}

/** close a tab; when it was the active one, activate its neighbour (or the launcher) */
export function closeAppTab(id: string, activeId: string | null) {
  const { tabs } = useWorkspace.getState()
  const i = tabs.indexOf(id)
  useWorkspace.getState().closeTab(id)
  if (activeId !== id) return
  const rest = tabs.filter((t) => t !== id)
  const next = rest[Math.min(i, rest.length - 1)]
  go(next ? { page: 'u', id: next } : { page: 'u' })
}
