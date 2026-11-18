/**
 * Per-user client preferences: ONE typed store for everything the Settings page changes that lives in this browser
 * (theme, motion, start mode, avatar colour, chat dock, Studio defaults). localStorage-backed, every access in
 * try/catch, keyed by user id (`appbuilder-prefs:<userId>`), so two people sharing a browser keep their own. The shape
 * is plain JSON on purpose: it can move to the server (a user-settings endpoint) later without changing callers.
 *
 * The theme is also written to the global key `appbuilder-theme` (src/runtime/ui.ts), because the sign-in and setup
 * screens are drawn before anyone is known. The environment choice is kept by the platform itself
 * (src/platform/environments.ts) and the Studio's per-app view state by src/runtime/persist.ts.
 */
import { create } from 'zustand'

export type ThemePref = 'light' | 'dark' | 'system'
export type MotionPref = 'system' | 'reduce'
export type StartModePref = 'last' | 'dev' | 'user'
export type ChatSide = 'right' | 'left'
export type GridSize = 4 | 8 | 16

export const AVATAR_COLORS = ['indigo', 'sky', 'teal', 'emerald', 'amber', 'orange', 'rose', 'violet'] as const
export type AvatarColor = (typeof AVATAR_COLORS)[number]
/** background colours of the avatar circle (white initials stay readable on all of them, light and dark theme) */
export const AVATAR_HEX: Record<AvatarColor, string> = {
  indigo: '#4f46e5', sky: '#0284c7', teal: '#0d9488', emerald: '#059669', amber: '#b45309', orange: '#c2410c', rose: '#e11d48', violet: '#7c3aed',
}

export interface Preferences {
  theme: ThemePref
  reduceMotion: MotionPref
  /** which mode the shell opens in when the address has no page (makers and admins) */
  startMode: StartModePref
  /** 'auto': picked from the user id */
  avatarColor: AvatarColor | 'auto'
  chatSide: ChatSide
  /** reopen the chat dock at start when it was open last time */
  chatRestore: boolean
  /** size preset id (src/runtime/sizes.ts) preselected for a new app */
  studioDefaultSize: string
  /** snap to the grid and to other controls while dragging (Alt still moves freely) */
  studioSnap: boolean
  studioGrid: GridSize
}

export const PREFS_VERSION = 1
const KEY = 'appbuilder-prefs'
const THEME_KEY = 'appbuilder-theme'

export function defaultPrefs(): Preferences {
  let theme: ThemePref = 'light'
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'light' || t === 'dark' || t === 'system') theme = t
  } catch {
    /* ignore */
  }
  return {
    theme, reduceMotion: 'system', startMode: 'last', avatarColor: 'auto', chatSide: 'right', chatRestore: true,
    studioDefaultSize: 'fhd', studioSnap: true, studioGrid: 8,
  }
}

const oneOf = <T extends string | number>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback)

/** anything (stored JSON, an imported file) -> valid preferences; unknown or broken fields fall back to the defaults */
export function parsePrefs(raw: unknown, base: Preferences = defaultPrefs()): Preferences {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    theme: oneOf(o.theme, ['light', 'dark', 'system'] as const, base.theme),
    reduceMotion: oneOf(o.reduceMotion, ['system', 'reduce'] as const, base.reduceMotion),
    startMode: oneOf(o.startMode, ['last', 'dev', 'user'] as const, base.startMode),
    avatarColor: oneOf(o.avatarColor, ['auto', ...AVATAR_COLORS] as const, base.avatarColor),
    chatSide: oneOf(o.chatSide, ['right', 'left'] as const, base.chatSide),
    chatRestore: typeof o.chatRestore === 'boolean' ? o.chatRestore : base.chatRestore,
    studioDefaultSize: typeof o.studioDefaultSize === 'string' && /^[a-z0-9-]{1,32}$/.test(o.studioDefaultSize) ? o.studioDefaultSize : base.studioDefaultSize,
    studioSnap: typeof o.studioSnap === 'boolean' ? o.studioSnap : base.studioSnap,
    studioGrid: oneOf(o.studioGrid, [4, 8, 16] as const, base.studioGrid),
  }
}

/** deterministic avatar colour for a user id (FNV-1a over the id), or the chosen one */
export function avatarColorOf(userId: string, choice: Preferences['avatarColor'] = 'auto'): AvatarColor {
  if (choice !== 'auto') return choice
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function initialsOf(name: string, email = ''): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const s = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0]?.slice(0, 2) ?? email.slice(0, 2))
  return s.toUpperCase() || '?'
}

export const prefersDarkScheme = (): boolean => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}
export const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
export const resolveTheme = (pref: ThemePref, systemDark: boolean): 'light' | 'dark' => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref)

function read(user: string): Preferences {
  try {
    const t = localStorage.getItem(`${KEY}:${user}`)
    return parsePrefs(t ? (JSON.parse(t) as unknown) : null)
  } catch {
    return defaultPrefs()
  }
}

interface PrefsState extends Preferences {
  /** the user the values belong to ('' while nobody is known) */
  user: string
  /** the system currently asks for reduced motion (kept in sync with the media query) */
  systemReducedMotion: boolean
  load(user: string): void
  set(patch: Partial<Preferences>): void
  /** back to the defaults for this user */
  reset(): void
}

const pick = (s: PrefsState): Preferences => parsePrefs(s)

export const usePrefs = create<PrefsState>((set, get) => {
  const save = () => {
    const { user } = get()
    const p = pick(get())
    try {
      localStorage.setItem(THEME_KEY, p.theme)
      if (user) localStorage.setItem(`${KEY}:${user}`, JSON.stringify({ v: PREFS_VERSION, ...p }))
    } catch {
      /* storage refused: the change lasts for this page only */
    }
  }
  return {
    ...defaultPrefs(),
    user: '',
    systemReducedMotion: prefersReducedMotion(),
    load(user) {
      if (user === get().user) return
      set({ user, ...(user ? read(user) : defaultPrefs()) })
    },
    set(patch) {
      set(parsePrefs({ ...pick(get()), ...patch }))
      save()
    },
    reset() {
      set({ ...defaultPrefs(), theme: 'light' })
      save()
    },
  }
})

/** effective reduced motion: the user asked for it here, or the operating system asks for it */
export const useReducedMotion = (): boolean => usePrefs((s) => s.reduceMotion === 'reduce' || s.systemReducedMotion)

/** a plain-JSON copy of this user's preferences (Settings > Data and privacy > Export) */
export function exportPreferences(): string {
  const s = usePrefs.getState()
  return JSON.stringify({ kind: 'appbuilder/preferences', version: PREFS_VERSION, exportedOn: new Date().toISOString(), user: s.user, preferences: pick(s) }, null, 2)
}

/** every key this product keeps in this browser's localStorage (all start with "appbuilder") */
export function localDataKeys(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('appbuilder')) out.push(k)
    }
  } catch {
    /* ignore */
  }
  return out
}

/** remove every Appbuilder key from localStorage (preferences, tabs, recents, mode, chat dock, Studio view state) */
export function clearLocalData(): number {
  const keys = localDataKeys()
  for (const k of keys) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  return keys.length
}
