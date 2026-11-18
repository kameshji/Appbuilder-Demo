import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AVATAR_COLORS, avatarColorOf, clearLocalData, defaultPrefs, exportPreferences, initialsOf, localDataKeys, parsePrefs, resolveTheme, usePrefs,
} from './preferences'

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
  usePrefs.setState({ user: '' })
})
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

describe('preferences', () => {
  it('parsePrefs keeps valid values and falls back field by field', () => {
    const d = defaultPrefs()
    expect(parsePrefs(null)).toEqual(d)
    expect(parsePrefs('junk')).toEqual(d)
    const p = parsePrefs({ theme: 'dark', reduceMotion: 'reduce', startMode: 'user', avatarColor: 'teal', chatSide: 'left', chatRestore: false, studioDefaultSize: 'phone', studioSnap: false, studioGrid: 16 })
    expect(p).toEqual({ theme: 'dark', reduceMotion: 'reduce', startMode: 'user', avatarColor: 'teal', chatSide: 'left', chatRestore: false, studioDefaultSize: 'phone', studioSnap: false, studioGrid: 16 })
    const bad = parsePrefs({ theme: 'neon', startMode: 1, avatarColor: '#fff', chatSide: 'top', chatRestore: 'yes', studioDefaultSize: '<script>', studioGrid: 7, extra: true })
    expect(bad).toEqual(d)
    expect('extra' in bad).toBe(false)
  })

  it('the default theme comes from the global key (signed-out screens use it too)', () => {
    store.set('appbuilder-theme', 'system')
    expect(defaultPrefs().theme).toBe('system')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('avatar colour is deterministic per user id unless chosen; initials', () => {
    expect(avatarColorOf('user_1')).toBe(avatarColorOf('user_1'))
    expect(AVATAR_COLORS).toContain(avatarColorOf('user_2'))
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((x) => avatarColorOf(`user_${x}`)))
    expect(seen.size).toBeGreaterThan(2)
    expect(avatarColorOf('user_1', 'rose')).toBe('rose')
    expect(initialsOf('Ada Byron Lovelace')).toBe('AL')
    expect(initialsOf('madonna')).toBe('MA')
    expect(initialsOf('', 'zed@x.io')).toBe('ZE')
    expect(initialsOf('')).toBe('?')
  })

  it('stored per user; switching users loads their own values; the theme also goes to the global key', () => {
    usePrefs.getState().load('u1')
    usePrefs.getState().set({ chatSide: 'left', theme: 'dark' })
    expect(JSON.parse(store.get('appbuilder-prefs:u1')!)).toMatchObject({ v: 1, chatSide: 'left', theme: 'dark' })
    expect(store.get('appbuilder-theme')).toBe('dark')
    usePrefs.getState().load('u2')
    expect(usePrefs.getState().chatSide).toBe('right')
    usePrefs.getState().load('u1')
    expect(usePrefs.getState().chatSide).toBe('left')
    usePrefs.getState().set({ studioGrid: 9 as never })
    expect(usePrefs.getState().studioGrid).toBe(8)
  })

  it('survives a storage that throws', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    usePrefs.getState().load('u9')
    usePrefs.getState().set({ chatRestore: false })
    expect(usePrefs.getState().chatRestore).toBe(false)
    expect(localDataKeys()).toEqual([])
  })

  it('export is plain JSON; clear removes only Appbuilder keys', () => {
    usePrefs.getState().load('u1')
    usePrefs.getState().set({ studioSnap: false })
    const out = JSON.parse(exportPreferences())
    expect(out).toMatchObject({ kind: 'appbuilder/preferences', version: 1, user: 'u1', preferences: { studioSnap: false } })
    store.set('appbuilder-tabs:u1', '[]')
    store.set('other-app', 'keep')
    expect(localDataKeys().sort()).toEqual(['appbuilder-prefs:u1', 'appbuilder-tabs:u1', 'appbuilder-theme'])
    expect(clearLocalData()).toBe(3)
    expect([...store.keys()]).toEqual(['other-app'])
  })
})
