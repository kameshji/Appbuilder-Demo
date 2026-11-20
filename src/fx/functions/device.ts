/**
 * Device functions (P2-A, docs/guide/maker/phone-apps.md). Values come from the host (the browser runtime resolves
 * 'Device()' and 'Location()'); on the server and in tests they are blank-filled records.
 *
 *   Device()          Kind ("Phone" | "Tablet" | "Desktop"), Platform ("Android" | "iOS" | "Other"), Touch, Online,
 *                     Standalone (opened from the home screen), ScreenWidth, ScreenHeight, Orientation. Formulas that
 *                     read it update when the connection, the size or the orientation changes.
 *   Location()        the device position, asked once (the browser asks the user for permission the first time):
 *                     Status ("Pending" | "Ready" | "Denied" | "Unavailable" | "NeedsHttps"), Latitude, Longitude,
 *                     Accuracy (metres), Altitude, Time, Message. Formulas update when the answer arrives.
 *   UpdateLocation()  behaviour: asks for a new position (Location() keeps the last one until it arrives).
 */
import type { FxRecord } from '../../contracts.ts'
import { def, type CallCtx, type FnDef } from './types.ts'

function hostRecord(c: CallCtx, key: string, blank: FxRecord): FxRecord {
  let v
  try {
    v = c.session.scope.resolve(key)
  } catch {
    v = undefined
  }
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? (v as FxRecord) : blank
}

export const BLANK_DEVICE: FxRecord = { Kind: 'Desktop', Platform: 'Other', Touch: false, Online: true, Standalone: false, ScreenWidth: null, ScreenHeight: null, Orientation: '' }
export const BLANK_LOCATION: FxRecord = { Status: 'Unavailable', Latitude: null, Longitude: null, Accuracy: null, Altitude: null, Time: null, Message: 'Location is only available in a browser.' }

export const deviceFns: FnDef[] = [
  def('Device', 'Device()', 'The device the app runs on: Kind ("Phone", "Tablet" or "Desktop"), Platform ("Android", "iOS" or "Other"), Touch, Online, Standalone (opened from the home screen), ScreenWidth, ScreenHeight and Orientation ("Portrait" or "Landscape").', 0, 0, (c) => hostRecord(c, 'Device()', BLANK_DEVICE)),
  def('Location', 'Location()', 'The position of the device, asked once (the browser asks for permission the first time): Status ("Pending", "Ready", "Denied", "Unavailable" or "NeedsHttps"), Latitude, Longitude, Accuracy in metres, Altitude, Time and Message. Formulas update when the position arrives.', 0, 0, (c) => hostRecord(c, 'Location()', BLANK_LOCATION)),
  def('UpdateLocation', 'UpdateLocation()', 'Asks the device for a new position; Location() keeps the last one until the new one arrives.', 0, 0, (c) => {
    try {
      c.session.scope.resolve('Location():update')
    } catch {
      /* no browser */
    }
    return true
  }, 'behaviour'),
]
