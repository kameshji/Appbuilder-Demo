import type { AppDef } from '@/contracts'
import type { TraceEntry } from './host'

/** Studio <-> debug window messages on BroadcastChannel('appbuilder-app-<id>') */
export type ChannelMsg =
  | { t: 'def'; app: AppDef }
  | { t: 'hello' }
  | { t: 'log'; entries: TraceEntry[] }
  | { t: 'run-closed' }
  | { t: 'studio-closed' }

export interface Channel { post(msg: ChannelMsg): void; close(): void; ok: boolean }

export function openChannel(appId: string, onMessage: (msg: ChannelMsg) => void): Channel {
  let bc: BroadcastChannel | null = null
  try {
    bc = new BroadcastChannel('appbuilder-app-' + appId)
    bc.onmessage = (e: MessageEvent) => {
      const m = e.data as ChannelMsg
      if (m && typeof m === 'object' && typeof m.t === 'string') onMessage(m)
    }
  } catch {
    bc = null
  }
  return {
    ok: !!bc,
    post(msg) {
      try {
        bc?.postMessage(msg)
      } catch {
        /* closed or not cloneable */
      }
    },
    close() {
      try {
        bc?.close()
      } catch {
        /* ignore */
      }
    },
  }
}
