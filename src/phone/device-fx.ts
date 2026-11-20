/**
 * Browser values for Device() and Location() (src/fx/functions/device.ts). The evaluator resolves 'Device()',
 * 'Location()' and 'Location():update' here and records the dependencies 'q:device' / 'q:location'; changes bump them
 * through runtime/data.ts so only formulas that read them re-run.
 */
import type { FxRecord } from '@/contracts'
import { currentDevice, subscribeDevice } from './env'
import { useConnectivity } from './connectivity'

let notify: (deps: string[]) => void = () => {}
/** runtime/data.ts installs the dependency bump */
export function setDeviceNotifier(fn: (deps: string[]) => void): void {
  notify = fn
}

let watching = false
function watch() {
  if (watching) return
  watching = true
  subscribeDevice(() => notify(['q:device']))
  useConnectivity.subscribe(() => notify(['q:device']))
}

export function deviceRecord(): FxRecord {
  watch()
  const d = currentDevice()
  return {
    Kind: d.kind === 'phone' ? 'Phone' : d.kind === 'tablet' ? 'Tablet' : 'Desktop',
    Platform: d.android ? 'Android' : d.ios ? 'iOS' : 'Other',
    Touch: d.touch,
    Online: d.online && useConnectivity.getState().status === 'online',
    Standalone: d.standalone,
    ScreenWidth: d.screenWidth,
    ScreenHeight: d.screenHeight,
    Orientation: d.orientation === 'portrait' ? 'Portrait' : 'Landscape',
  }
}

/* ------------------------------------------------------------------ location */

export type LocationStatus = 'Pending' | 'Ready' | 'Denied' | 'Unavailable' | 'NeedsHttps'
let loc: FxRecord | null = null
let asking = false

/** maker-facing record for a geolocation error code (1 denied, 2 unavailable, 3 timeout) */
export function locationError(code: number, secure: boolean): FxRecord {
  if (!secure) return { Status: 'NeedsHttps', Latitude: null, Longitude: null, Accuracy: null, Altitude: null, Time: null, Message: 'Location needs a secure (HTTPS) connection.' }
  if (code === 1) return { Status: 'Denied', Latitude: null, Longitude: null, Accuracy: null, Altitude: null, Time: null, Message: 'Location access was refused. Allow it for this site in the browser settings.' }
  return { Status: 'Unavailable', Latitude: null, Longitude: null, Accuracy: null, Altitude: null, Time: null, Message: code === 3 ? 'The position could not be found in time.' : 'The position is not available.' }
}

export function requestLocation(): void {
  if (asking || typeof navigator === 'undefined') return
  const secure = typeof window !== 'undefined' && window.isSecureContext
  if (!navigator.geolocation || !secure) {
    loc = locationError(2, secure)
    notify(['q:location'])
    return
  }
  asking = true
  if (!loc) loc = { Status: 'Pending', Latitude: null, Longitude: null, Accuracy: null, Altitude: null, Time: null, Message: 'Finding the position…' }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      asking = false
      loc = { Status: 'Ready', Latitude: p.coords.latitude, Longitude: p.coords.longitude, Accuracy: p.coords.accuracy, Altitude: p.coords.altitude, Time: new Date(p.timestamp), Message: '' }
      notify(['q:location'])
    },
    (e) => {
      asking = false
      loc = locationError(e.code, true)
      notify(['q:location'])
    },
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
  )
}

export function locationRecord(): FxRecord {
  if (!loc) requestLocation()
  return loc ?? locationError(2, false)
}
