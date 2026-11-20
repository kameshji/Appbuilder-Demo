import { describe, expect, it } from 'vitest'
import { classify, keyboardInset } from './env'
import { fluidSurface, usesFluidLayout } from '@/runtime/layout'
import { nextState, type ConnectivityState } from './connectivity'
import { WedgeDetector } from './scan/wedge'
import { Debounce, parseFormats, ALL_FORMATS } from './scan/scanner'
import { exifOrientation, orientationTransform, swapsSides, targetSize } from './image'
import { nearestBox } from './hit'
import { installPlatform, startRouteOf } from './pwa'
import { backoffMs, isIdempotentRead, isNetworkError, readKey } from '@/platform/offline-hook'
import { TOUCH_MATRIX, wantsHitArea } from './touch'
import { controls } from '@/controls'
import { allowsNegative, applyNativeRange, barPinned, cardMode, cardPlan, dateToNative, dragDismiss, filterOptions, legendHeight, nativeToDate, nativeToTime, normalizeNumberText, numberInputMode, overlayPlacement, parseCardColumns, pointHitRadius, timeToNative, toggleSign } from './touch-logic'
import { initialValues } from '@/controls/inputs/formSchema'
import { locationError } from './device-fx'
import { pullDistance } from './PullToRefresh'
import { qrPath, appPhoneUrl } from './QrCode'
import { fx } from '@/fx'
import { val } from '@/fx/testutil'
import type { ColumnDef } from '@/platform/contracts'

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

describe('device classification', () => {
  it('phones, tablets, iPadOS and desktops', () => {
    expect(classify(ANDROID, true, 412, 915, 5)).toMatchObject({ kind: 'phone', android: true, touch: true })
    expect(classify(IPHONE, true, 390, 844, 5)).toMatchObject({ kind: 'phone', ios: true })
    expect(classify(IPAD, true, 820, 1180, 5)).toMatchObject({ kind: 'tablet', ios: true })
    expect(classify(DESKTOP, false, 1920, 1080, 0)).toMatchObject({ kind: 'desktop', touch: false })
  })
  it('keyboard inset ignores toolbar-sized differences', () => {
    expect(keyboardInset(800, 450, 0)).toBe(350)
    expect(keyboardInset(800, 760, 0)).toBe(0)
  })
})

describe('layout rule for phone and tablet designs', () => {
  const phone = { width: 360, height: 800, scaleMode: 'responsive' as const }
  it('is 1:1 at the device width, stretches wider, scales narrower, scrolls vertically', () => {
    expect(fluidSurface(phone, { w: 360, h: 740 })).toEqual({ w: 360, h: 800, scale: 1, scroll: true })
    expect(fluidSurface(phone, { w: 412, h: 915 })).toEqual({ w: 412, h: 915, scale: 1, scroll: false })
    const narrow = fluidSurface(phone, { w: 320, h: 640 })
    expect(narrow.w).toBe(360)
    expect(narrow.scale).toBeCloseTo(320 / 360)
    expect(narrow.h).toBe(800)
    expect(fluidSurface(phone, { w: 800, h: 360 })).toMatchObject({ w: 800, h: 800, scale: 1, scroll: true })
  })
  it('applies to phone/tablet designs on touch or narrow areas only, never to fit or desktop designs', () => {
    expect(usesFluidLayout(phone, { w: 1200, h: 800 }, true)).toBe(true)
    expect(usesFluidLayout(phone, { w: 1200, h: 800 }, false)).toBe(false)
    expect(usesFluidLayout(phone, { w: 400, h: 800 }, false)).toBe(true)
    expect(usesFluidLayout({ ...phone, scaleMode: 'fit' }, { w: 360, h: 800 }, true)).toBe(false)
    expect(usesFluidLayout({ width: 1920, height: 1080 }, { w: 360, h: 800 }, true)).toBe(false)
  })
})

describe('connectivity', () => {
  const on: ConnectivityState = { status: 'online', since: null, browserOffline: false }
  it('goes offline on a failed request or the browser event, online only when the server answers', () => {
    const off = nextState(on, { t: 'request', ok: false }, 100)
    expect(off).toEqual({ status: 'offline', since: 100, browserOffline: false })
    expect(nextState(off, { t: 'request', ok: false }, 200).since).toBe(100)
    const b = nextState(on, { t: 'browser', online: false }, 5)
    expect(b).toMatchObject({ status: 'offline', browserOffline: true })
    expect(nextState(b, { t: 'browser', online: true }, 6)).toMatchObject({ status: 'offline', browserOffline: false })
    expect(nextState(b, { t: 'probe', ok: true }, 7)).toEqual(on)
  })
  it('retries only reads, with growing backoff', () => {
    expect(isIdempotentRead('GET', '/workspace')).toBe(true)
    expect(isIdempotentRead('POST', '/query')).toBe(true)
    // P3-C: the v1 query route is gone; a POST there is not a read the client retries
    expect(isIdempotentRead('POST', '/data/Orders/query')).toBe(false)
    expect(isIdempotentRead('POST', '/data/Orders/rows')).toBe(false)
    expect(isIdempotentRead('PATCH', '/data/Orders/rows/1')).toBe(false)
    expect(backoffMs(1, () => 0)).toBe(400)
    expect(backoffMs(2, () => 0)).toBe(1200)
    expect(backoffMs(3, () => 1)).toBe(4500)
    expect(isNetworkError(Object.assign(new Error('x'), { network: true }))).toBe(true)
    expect(isNetworkError(new Error('x'))).toBe(false)
    expect(readKey('/query', { plan: { table: 'A' } })).toBe('/query {"plan":{"table":"A"}}')
  })
})

describe('scanning helpers', () => {
  it('keyboard wedge: fast bursts ending in Enter only', () => {
    const w = new WedgeDetector()
    let t = 1000
    const type = (s: string, gap: number) => { for (const ch of s) expect(w.feed(ch, (t += gap))).toBeNull() }
    type('LOT-4711', 8)
    expect(w.feed('Enter', (t += 8))).toBe('LOT-4711')
    type('abc', 150)
    expect(w.feed('Enter', (t += 150))).toBeNull()
    // a person typed "x" slowly, then the scanner fired: only the burst counts
    type('x', 300)
    t += 400
    type('987654', 5)
    expect(w.feed('Enter', (t += 5))).toBe('987654')
    type('ab', 5)
    expect(w.feed('Enter', (t += 5))).toBeNull() // too short
    expect(w.feed('Shift', t)).toBeNull()
  })
  it('continuous mode reports a code again only after a pause', () => {
    const d = new Debounce(2000)
    expect(d.accept('A', 0)).toBe(true)
    expect(d.accept('A', 500)).toBe(false)
    expect(d.accept('A', 2400)).toBe(false) // still in view: seen 500 ms ago
    expect(d.accept('B', 2500)).toBe(true)
    expect(d.accept('A', 2600)).toBe(true)
  })
  it('formats text', () => {
    expect(parseFormats('All')).toEqual(ALL_FORMATS)
    expect(parseFormats('qr, EAN-13 code128 nonsense')).toEqual(['qr_code', 'ean_13', 'code_128'])
  })
})

describe('photos', () => {
  /** a minimal JPEG with an EXIF APP1 orientation tag */
  function jpegWithOrientation(o: number, little: boolean): ArrayBuffer {
    const b = new Uint8Array(2 + 2 + 2 + 6 + 8 + 2 + 12 + 4 + 2)
    const v = new DataView(b.buffer)
    let p = 0
    v.setUint16(p, 0xffd8); p += 2
    v.setUint16(p, 0xffe1); p += 2
    v.setUint16(p, b.length - 4); p += 2
    v.setUint32(p, 0x45786966); p += 4
    v.setUint16(p, 0); p += 2
    const tiff = p
    v.setUint16(p, little ? 0x4949 : 0x4d4d); p += 2
    v.setUint16(p, 42, little); p += 2
    v.setUint32(p, 8, little); p += 4
    v.setUint16(p, 1, little); p += 2
    v.setUint16(p, 0x0112, little)
    v.setUint16(p + 2, 3, little)
    v.setUint32(p + 4, 1, little)
    v.setUint16(p + 8, o, little)
    void tiff
    return b.buffer
  }
  it('reads EXIF orientation in both byte orders; absent = 1', () => {
    expect(exifOrientation(jpegWithOrientation(6, true))).toBe(6)
    expect(exifOrientation(jpegWithOrientation(8, false))).toBe(8)
    expect(exifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBe(1)
    expect(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBe(1)
  })
  it('sizes upright output with the longer side capped', () => {
    expect(targetSize(4000, 3000, 1, 1600)).toEqual({ w: 1600, h: 1200, scale: 0.4 })
    expect(targetSize(4000, 3000, 6, 1600)).toEqual({ w: 1200, h: 1600, scale: 0.4 })
    expect(targetSize(800, 600, 1, 1600)).toEqual({ w: 800, h: 600, scale: 1 })
    expect(swapsSides(5) && swapsSides(8) && !swapsSides(3)).toBe(true)
  })
  it('orientation transforms map the drawn image into the upright canvas', () => {
    // apply the transform to the corners of a 40x30 drawn image: they must land inside the upright canvas
    for (let o = 1; o <= 8; o++) {
      const [a, b, c, d, e, f] = orientationTransform(o, 40, 30)
      const W = swapsSides(o) ? 30 : 40
      const H = swapsSides(o) ? 40 : 30
      const pts = [[0, 0], [40, 0], [0, 30], [40, 30]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f])
      expect(pts.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H)).toBe(true)
      expect(new Set(pts.map((p) => p.join(','))).size).toBe(4)
    }
  })
})

describe('touch', () => {
  it('nearest box for forwarded taps', () => {
    const boxes = [{ left: 0, top: 0, right: 20, bottom: 20 }, { left: 30, top: 0, right: 50, bottom: 20 }]
    expect(nearestBox(boxes, 10, 30)).toBe(0)
    expect(nearestBox(boxes, 45, -10)).toBe(1)
    expect(nearestBox([], 0, 0)).toBe(-1)
  })
  it('every UI component of the registry has a touch matrix entry, and small interactive ones get a touch area', () => {
    const missing = controls.list().map((c) => c.type).filter((t) => !TOUCH_MATRIX[t])
    expect(missing).toEqual([])
    for (const c of controls.list()) {
      const e = TOUCH_MATRIX[c.type]
      expect(['works', 'fixed', 'limitation']).toContain(e.status)
      expect(e.note.length).toBeGreaterThan(3)
      const actions = c.props.some((p) => p.kind === 'action' && /^On(Select|Change|Scan|ItemSelect|Dismiss|Action|Search|Complete)$/.test(p.name))
      const small = c.defaultSize.height < 44 || c.defaultSize.width < 44
      // an interactive UI component that is smaller than 44 px by default must get the touch area (or say why not)
      if (actions && small && !wantsHitArea(c.type)) expect(e.status, c.type).toBe('limitation')
    }
  })
  it('pull distance has resistance and a cap', () => {
    expect(pullDistance(-5)).toBe(0)
    expect(pullDistance(100)).toBe(50)
    expect(pullDistance(1000)).toBe(96)
  })
})

describe('touch logic (pickers, native fields, cards, sheets, save bar)', () => {
  it('filterOptions: case-insensitive contains, blank keeps all, limit', () => {
    expect(filterOptions(['Apple', 'Banana', 'Grape'], 'AP')).toEqual([0, 2])
    expect(filterOptions(['Apple', 'Banana'], '  ')).toEqual([0, 1])
    expect(filterOptions(['a', 'a', 'a'], 'a', 2)).toEqual([0, 1])
    expect(filterOptions(['x'], 'zz')).toEqual([])
  })
  it('native date: local yyyy-mm-dd both ways, invalid and out of range are ignored', () => {
    expect(dateToNative(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dateToNative(null)).toBe('')
    expect(dateToNative(new Date(NaN))).toBe('')
    const d = nativeToDate('2026-03-09') as Date
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 2, 9, 0])
    expect(nativeToDate('')).toBeNull()
    expect(nativeToDate('2026-02-30')).toBeUndefined()
    expect(nativeToDate('09/03/2026')).toBeUndefined()
    const min = new Date(2026, 2, 10)
    const max = new Date(2026, 2, 20)
    expect(nativeToDate('2026-03-09', min, max)).toBeUndefined()
    expect(nativeToDate('2026-03-21', min, max)).toBeUndefined()
    expect(nativeToDate('2026-03-10', min, max)).toBeInstanceOf(Date)
    expect(nativeToDate('2026-03-20', min, max)).toBeInstanceOf(Date)
  })
  it('native range: never inverted, clearing the start clears the range, clearing the end keeps it open', () => {
    const a = new Date(2026, 4, 10)
    const b = new Date(2026, 4, 20)
    const c = new Date(2026, 4, 25)
    const early = new Date(2026, 4, 1)
    expect(applyNativeRange('start', c, { start: a, end: b })).toEqual({ start: c, end: c })
    expect(applyNativeRange('start', early, { start: a, end: b })).toEqual({ start: early, end: b })
    expect(applyNativeRange('end', early, { start: a, end: b })).toEqual({ start: early, end: early })
    expect(applyNativeRange('end', c, { start: a, end: b })).toEqual({ start: a, end: c })
    expect(applyNativeRange('start', null, { start: a, end: b })).toEqual({ start: null, end: null })
    expect(applyNativeRange('end', null, { start: a, end: b })).toEqual({ start: a, end: null })
  })
  it('native time: HH:MM both ways, seconds tolerated, bad text ignored', () => {
    expect(timeToNative({ h: 7, m: 5 })).toBe('07:05')
    expect(timeToNative(null)).toBe('')
    expect(nativeToTime('07:05')).toEqual({ h: 7, m: 5 })
    expect(nativeToTime('23:59:30')).toEqual({ h: 23, m: 59 })
    expect(nativeToTime('')).toBeNull()
    expect(nativeToTime('24:00')).toBeUndefined()
    expect(nativeToTime('7:5')).toBeUndefined()
  })
  it('NumberInput: keypad choice, sign button, decimal comma', () => {
    expect(numberInputMode(0, 100, 1)).toBe('numeric')
    expect(numberInputMode(1, 20, 5)).toBe('numeric')
    expect(numberInputMode(null, null, 1)).toBe('decimal')
    expect(numberInputMode(-5, 5, 1)).toBe('decimal')
    expect(numberInputMode(0, 10, 0.5)).toBe('decimal')
    expect(numberInputMode(0, 10.5, 1)).toBe('decimal')
    expect(allowsNegative(null)).toBe(true)
    expect(allowsNegative(-1)).toBe(true)
    expect(allowsNegative(0)).toBe(false)
    expect(normalizeNumberText('12,5')).toBe('12.5')
    expect(normalizeNumberText('-')).toBe('-')
    expect(normalizeNumberText('1.2.3')).toBeNull()
    expect(normalizeNumberText('1,2,3')).toBeNull()
    expect(normalizeNumberText('abc')).toBeNull()
    expect(toggleSign('5')).toBe('-5')
    expect(toggleSign('-5')).toBe('5')
    expect(toggleSign('')).toBe('-')
  })
  it('DataTable cards: only on a touch device in run mode below phone width', () => {
    expect(cardMode(true, 360)).toBe(true)
    expect(cardMode(true, 599)).toBe(true)
    expect(cardMode(true, 600)).toBe(false)
    expect(cardMode(false, 360)).toBe(false)
    expect(cardMode(true, 360, true)).toBe(false)
    expect(cardMode(true, 0)).toBe(false)
  })
  it('CardColumns parsing and the card plan (explicit priority and default)', () => {
    expect(parseCardColumns('Name, Status:Stage , name,, Amount')).toEqual(['Name', 'Status', 'Amount'])
    expect(parseCardColumns('')).toEqual([])
    const cols = [
      { field: 'Id', kind: 'number' }, { field: 'Name', kind: 'text' }, { field: 'Status', kind: 'text' },
      { field: 'A', kind: 'text' }, { field: 'B', kind: 'text' }, { field: 'C', kind: 'text' }, { field: 'D', kind: 'text' }, { field: 'E', kind: 'text' },
    ]
    const dflt = cardPlan(cols, [])!
    expect(dflt.title.field).toBe('Name')
    expect(dflt.subtitle).toBeNull()
    expect(dflt.lines.map((c) => c.field)).toEqual(['Id', 'Status', 'A', 'B', 'C'])
    const ex = cardPlan(cols, ['status', 'nope', 'Id', 'Name'])!
    expect([ex.title.field, ex.subtitle?.field, ex.lines.map((c) => c.field)]).toEqual(['Status', 'Id', ['Name']])
    expect(cardPlan(cols, ['nope'])!.title.field).toBe('Name')
    expect(cardPlan([{ field: 'N', kind: 'number' }], [])!.title.field).toBe('N')
    expect(cardPlan([], ['x'])).toBeNull()
  })
  it('Dialog and Sheet placement', () => {
    expect(overlayPlacement('Dialog', '', true, 360)).toBe('bottom-sheet')
    expect(overlayPlacement('Dialog', '', false, 360)).toBe('dialog')
    expect(overlayPlacement('Dialog', '', true, 900)).toBe('dialog')
    expect(overlayPlacement('Sheet', 'Right', true, 360)).toBe('bottom-sheet')
    expect(overlayPlacement('Sheet', 'left', true, 360)).toBe('bottom-sheet')
    expect(overlayPlacement('Sheet', 'right', false, 360)).toBe('right')
    expect(overlayPlacement('Sheet', 'right', true, 800)).toBe('right')
    expect(overlayPlacement('Sheet', 'top', true, 360)).toBe('top')
    expect(overlayPlacement('Sheet', 'bottom', true, 360)).toBe('bottom-sheet')
    expect(overlayPlacement('Sheet', 'bottom', false, 360)).toBe('bottom')
  })
  it('sheet drag: far or fast pulls dismiss, short slow ones and upward ones do not', () => {
    expect(dragDismiss(101, 800)).toBe(true)
    expect(dragDismiss(50, 40)).toBe(true)
    expect(dragDismiss(50, 400)).toBe(false)
    expect(dragDismiss(30, 10)).toBe(false)
    expect(dragDismiss(-200, 10)).toBe(false)
  })
  it('Form save bar pins only when the form end is hidden but a useful part is visible', () => {
    const base = { barHeight: 64, viewTop: 0, viewBottom: 500 }
    expect(barPinned({ ...base, formTop: 0, formBottom: 400 })).toBe(false)
    expect(barPinned({ ...base, formTop: 0, formBottom: 900 })).toBe(true)
    expect(barPinned({ ...base, formTop: 450, formBottom: 900 })).toBe(false)
    expect(barPinned({ ...base, formTop: -900, formBottom: -10 })).toBe(false)
    expect(barPinned({ ...base, formTop: 0, formBottom: 501 })).toBe(false)
  })
  it('chart touch sizes', () => {
    expect(legendHeight(false)).toBe(26)
    expect(legendHeight(true)).toBe(44)
    expect(pointHitRadius(3, true)).toBe(22)
    expect(pointHitRadius(30, true)).toBe(30)
    expect(pointHitRadius(3, false)).toBe(3)
  })
  it('DataTable exposes the additive CardColumns property', () => {
    const p = controls.list().find((c) => c.type === 'DataTable')!.props.find((x) => x.name === 'CardColumns')
    expect(p).toBeTruthy()
    expect(p!.simple).toBe(false)
  })
})

describe('PWA and phone helpers', () => {
  it('install instructions per platform', () => {
    expect(installPlatform(ANDROID)).toBe('android-chrome')
    expect(installPlatform(IPHONE)).toBe('ios-safari')
    expect(installPlatform(IPAD, 5)).toBe('ios-safari')
    expect(installPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1')).toBe('ios-other')
    expect(installPlatform('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36')).toBe('other')
    expect(installPlatform(DESKTOP)).toBe('desktop-chromium')
  })
  it('the home screen start address opens the app; a hash wins; bad ids are ignored', () => {
    expect(startRouteOf('?app=app_123', '')).toBe('#u-app_123')
    expect(startRouteOf('?app=app_123', '#u')).toBeNull()
    expect(startRouteOf('?app=../x', '')).toBeNull()
    expect(startRouteOf('', '')).toBeNull()
    expect(appPhoneUrl('app_1', 'https://plant.local')).toBe('https://plant.local/?app=app_1')
    expect(qrPath('https://plant.local/?app=app_1').size).toBeGreaterThan(20)
  })
  it('Device(), Location() and UpdateLocation() exist and are blank-filled without a browser', () => {
    expect(val('=Device().Kind')).toBe('Desktop')
    expect(val('=Location().Status')).toBe('Unavailable')
    expect(fx.check('=UpdateLocation()')).toEqual([])
    expect(locationError(1, true).Status).toBe('Denied')
    expect(locationError(1, false).Status).toBe('NeedsHttps')
  })
})

describe('Form in New mode', () => {
  const cols = [{ name: 'Line', type: 'text' }, { name: 'Code', type: 'text' }, { name: 'Qty', type: 'number' }] as unknown as ColumnDef[]
  it('takes starting values from an Item that is not a row (scan to fill)', () => {
    expect(initialValues(cols, 'New', { Code: 'LOT-4711' })).toMatchObject({ Code: 'LOT-4711', Line: '' })
  })
  it('ignores a row Item (as before)', () => {
    expect(initialValues(cols, 'New', { __id: 'r1', id: 'r1', Code: 'X' }).Code).toBe('')
  })
})
