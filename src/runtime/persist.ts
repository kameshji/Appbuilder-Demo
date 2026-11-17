import type { ControlNode } from '@/contracts'

/* ------------------------------------------------------------------ clipboard (across screens, apps and tabs) */

const CLIP_KEY = 'appbuilder-clipboard'
let memClip: ControlNode[] | null = null

function isNode(n: unknown): n is ControlNode {
  if (typeof n !== 'object' || n === null) return false
  const o = n as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.type === 'string' && typeof o.props === 'object' && o.props !== null && Array.isArray(o.children) && o.children.every(isNode)
}

export function writeClipboard(nodes: ControlNode[]) {
  memClip = nodes
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ kind: 'appbuilder/controls', nodes }))
  } catch {
    /* storage unavailable: in-memory only */
  }
}

export function readClipboard(): ControlNode[] | null {
  try {
    const t = localStorage.getItem(CLIP_KEY)
    if (t) {
      const v = JSON.parse(t) as { nodes?: unknown }
      if (Array.isArray(v.nodes) && v.nodes.every(isNode)) return v.nodes
    }
  } catch {
    /* ignore */
  }
  return memClip
}

/* ------------------------------------------------------------------ per-app UI prefs */

export interface AppPrefs { locked: string[]; viewport: { w: number; h: number } | null; zoom?: number }
const prefKey = (appId: string) => `appbuilder-ui:${appId}`

export function loadPrefs(appId: string): AppPrefs {
  try {
    const t = localStorage.getItem(prefKey(appId))
    if (t) {
      const v = JSON.parse(t) as Partial<AppPrefs>
      return { locked: Array.isArray(v.locked) ? v.locked.filter((x) => typeof x === 'string') : [], viewport: v.viewport && typeof v.viewport.w === 'number' ? v.viewport : null }
    }
  } catch {
    /* ignore */
  }
  return { locked: [], viewport: null }
}

export function savePrefs(appId: string, prefs: AppPrefs) {
  try {
    localStorage.setItem(prefKey(appId), JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ download (sandboxed hosts may block it; callers also offer Copy) */

export function downloadText(fileName: string, text: string, mime = 'text/plain') {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    return true
  } catch {
    return false
  }
}

export const safeFileName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
