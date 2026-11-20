/** P2-A start-up, called once from main.tsx before React renders. Each part is safe outside a browser. */
import { startPhoneEnvironment } from './env'
import { installHitForwarding } from './hit'
import { startConnectivity } from './connectivity'
import { startOffline } from './offline'
import { registerServiceWorker, startRouteOf } from './pwa'

export function startPhone(): void {
  if (typeof window === 'undefined') return
  // opened from a per-app home screen icon (/?app=<id>): open that app
  const route = startRouteOf(location.search, location.hash)
  if (route) history.replaceState(null, '', `${location.pathname}${location.search}${route}`)
  startPhoneEnvironment()
  installHitForwarding()
  startConnectivity()
  startOffline()
  void registerServiceWorker()
}
