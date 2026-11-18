import type { AppDef } from '@/contracts'
import { platform } from '@/platform'
import { useStore, type AppStore } from './store'
import { openChannel, type Channel } from './channel'
import { errorMessage } from './data'

/** load an app definition from the platform into the store */
export async function loadAppDef(appId: string, store: AppStore = useStore): Promise<AppDef | null> {
  store.getState().setLoadState('loading')
  try {
    const def = await platform.apps.load(appId)
    if (!def) {
      store.getState().setLoadState('missing')
      return null
    }
    return def
  } catch (e) {
    store.getState().setLoadState('error', errorMessage(e))
    return null
  }
}

/**
 * Studio session: debounced autosave through platform.apps.save, plus broadcasting the definition
 * to debug windows (<=100 ms). Returns a disposer that flushes.
 */
export function startStudioSession(appId: string): () => void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let castTimer: ReturnType<typeof setTimeout> | null = null
  let pending: AppDef | null = null
  let saving = false

  const save = async () => {
    saveTimer = null
    if (!pending || saving) return
    const def = pending
    pending = null
    saving = true
    useStore.getState().setSaveState('saving')
    try {
      await platform.apps.save(appId, JSON.parse(JSON.stringify(def)) as AppDef)
      saving = false
      if (pending) void save()
      else useStore.getState().setSaveState('saved')
    } catch (e) {
      saving = false
      useStore.getState().setSaveState('error')
      useStore.getState().notify(`Could not save: ${errorMessage(e)}`, 'error')
    }
  }

  const channel: Channel = openChannel(appId, (msg) => {
    if (msg.t === 'hello') channel.post({ t: 'def', app: useStore.getState().app })
    else if (msg.t === 'log') useStore.getState().log(msg.entries)
  })

  const unsub = useStore.subscribe((s, prev) => {
    if (s.app === prev.app || s.appId !== appId) return
    pending = s.app
    useStore.getState().setSaveState('unsaved')
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), 700)
    if (castTimer) clearTimeout(castTimer)
    castTimer = setTimeout(() => {
      castTimer = null
      channel.post({ t: 'def', app: useStore.getState().app })
    }, 60)
  })

  const flush = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      void save()
    }
  }
  window.addEventListener('beforeunload', flush)
  return () => {
    unsub()
    flush()
    channel.post({ t: 'studio-closed' })
    channel.close()
    window.removeEventListener('beforeunload', flush)
    if (castTimer) clearTimeout(castTimer)
  }
}

/** open the debug window; returns false when the host blocks pop-ups */
export function openRunWindow(appId: string): boolean {
  const url = location.pathname + location.search + '#run-' + appId
  let w: Window | null = null
  try {
    w = window.open(url, 'appbuilder-run-' + appId, 'popup,width=1600,height=900')
  } catch {
    w = null
  }
  if (!w) return false
  try {
    w.focus()
  } catch {
    /* ignore */
  }
  return true
}
