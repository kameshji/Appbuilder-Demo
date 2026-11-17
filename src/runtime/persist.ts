import type { AppDef, ControlNode, FxRecord } from '@/contracts'

const KEY = 'appbuilder-demo:v1'

export interface Persisted { app: AppDef; collections: Record<string, FxRecord[]> | null }

function stringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    function (this: Record<string, unknown>, key: string, v: unknown) {
      const raw = this[key]
      if (raw instanceof Date) return { $date: raw.toISOString() }
      return v
    },
    space,
  )
}

function parse(text: string): unknown {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $date?: unknown }).$date === 'string' && Object.keys(v).length === 1) {
      return new Date((v as { $date: string }).$date)
    }
    return v
  })
}

function isNode(n: unknown): n is ControlNode {
  if (typeof n !== 'object' || n === null) return false
  const o = n as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.type === 'string' &&
    typeof o.props === 'object' &&
    o.props !== null &&
    Array.isArray(o.children) &&
    o.children.every(isNode)
  )
}

export function isAppDef(x: unknown): x is AppDef {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    o.formatVersion === 1 &&
    typeof o.name === 'string' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number' &&
    typeof o.appProps === 'object' &&
    Array.isArray(o.screens) &&
    o.screens.length > 0 &&
    o.screens.every((s) => isNode(s) && s.type === 'Screen')
  )
}

export function readImport(text: string): Persisted {
  const data = parse(text) as Record<string, unknown>
  if (isAppDef(data)) return { app: data, collections: null }
  if (data && isAppDef(data.app)) {
    const c = data.collections
    return { app: data.app, collections: c && typeof c === 'object' ? (c as Record<string, FxRecord[]>) : null }
  }
  throw new Error('Not an Appbuilder file')
}

export function loadPersisted(): Persisted | null {
  try {
    const t = localStorage.getItem(KEY)
    return t ? readImport(t) : null
  } catch {
    return null
  }
}

export function savePersisted(app: AppDef, collections: Record<string, FxRecord[]>) {
  try {
    localStorage.setItem(KEY, stringify({ app, collections }))
  } catch {
    /* quota or private mode: ignore */
  }
}

export function clearPersisted() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function downloadJson(app: AppDef, collections: Record<string, FxRecord[]>) {
  const text = stringify({ app, collections }, 2)
  // Sandboxed hosts block downloads; the clipboard copy is the fallback there.
  try { void navigator.clipboard?.writeText(text).catch(() => {}) } catch { /* ignore */ }
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${app.name.replace(/[^\w-]+/g, '_') || 'app'}.appbuilder.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
