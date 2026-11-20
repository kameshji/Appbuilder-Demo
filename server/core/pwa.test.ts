import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { colourHex, iconPng, initialsOf, manifestOf, serviceWorkerSource } from './pwa.ts'
import { deriveOfflineKey, idempotencyHash, idempotencyKeyOf } from './offline.ts'
import { htmlCsp, SECURITY_HEADERS } from './router.ts'

/** decode our own PNG (8-bit RGBA, filter 0) back to pixels */
function decodePng(buf: Buffer): { w: number; h: number; px: Uint8Array } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  let p = 8
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.subarray(p + 4, p + 8).toString('ascii')
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) raw.copy(Buffer.from(px.buffer), y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))
  return { w, h, px }
}

describe('PWA', () => {
  it('colours: hex, rgb, oklch (the app theme format)', () => {
    expect(colourHex('#abc')).toBe('aabbcc')
    expect(colourHex('#4F46E5')).toBe('4f46e5')
    expect(colourHex('rgb(255, 0, 10)')).toBe('ff000a')
    expect(colourHex('oklch(1 0 0)')).toBe('ffffff')
    expect(colourHex('oklch(0 0 0)')).toBe('000000')
    // the default indigo primary is close to #4f46e5
    const indigo = colourHex('oklch(0.51 0.19 277)')!
    expect(parseInt(indigo.slice(4, 6), 16)).toBeGreaterThan(parseInt(indigo.slice(0, 2), 16))
    expect(colourHex('var(--x)')).toBeNull()
  })
  it('initials', () => {
    expect(initialsOf('Production log')).toBe('PL')
    expect(initialsOf('stock')).toBe('ST')
    expect(initialsOf('Ünïcode  äpp')).toBe('UA')
    expect(initialsOf('!!!')).toBe('A')
  })
  it('icons: valid PNG, transparent rounded corners, coloured background, white letters; maskable is full bleed', () => {
    const { w, h, px } = decodePng(iconPng(64, '102030', 'PL'))
    expect([w, h]).toEqual([64, 64])
    expect(px[3]).toBe(0) // corner transparent
    const mid = (32 * 64 + 4) * 4 // left edge, middle row: background
    expect([px[mid], px[mid + 1], px[mid + 2], px[mid + 3]]).toEqual([0x10, 0x20, 0x30, 255])
    let white = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255) white++
    expect(white).toBeGreaterThan(100)
    const m = decodePng(iconPng(64, '102030', 'PL', true))
    expect(m.px[3]).toBe(255)
  })
  it('manifest: standalone, scope /, any + maskable icons', () => {
    const m = manifestOf({ id: '/?app=a1', name: 'Production log', startUrl: '/?app=a1', colour: '102030', letters: 'PL' }) as { icons: Array<{ purpose: string; src: string }>; display: string; scope: string; theme_color: string }
    expect(m.display).toBe('standalone')
    expect(m.scope).toBe('/')
    expect(m.theme_color).toBe('#102030')
    expect(m.icons.map((i) => i.purpose)).toEqual(['any', 'any', 'maskable', 'maskable'])
    expect(m.icons[0].src).toBe('/api/v1/pwa/icon.png?s=192&c=102030&t=PL')
  })
  it('service worker: versioned, waits for the user, never caches the API (except PWA files)', () => {
    const src = serviceWorkerSource('abc123')
    expect(src).toContain('"abc123"')
    expect(src).not.toMatch(/install[\s\S]{0,200}skipWaiting\(\)/)
    expect(src).toContain("if (t === 'skip-waiting') self.skipWaiting()")
    expect(src).toContain('if (!STATIC_API.test(url.pathname)) return;')
    expect(src).toContain("if (req.method !== 'GET') return;")
    // it parses as a script
    expect(() => new Function(src)).not.toThrow()
  })
  it('CSP is unchanged by P2-A (worker and manifest fall back to self)', () => {
    expect(htmlCsp()).toBe("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'")
    expect(SECURITY_HEADERS['Permissions-Policy']).toBeUndefined()
  })
})

describe('service worker navigation', () => {
  it('never answers an /api/ navigation with the app shell (files, PDF previews, unsubscribe page)', () => {
    const src = serviceWorkerSource('abc123')
    expect(src).toContain("req.mode === 'navigate' && !url.pathname.startsWith('/api/')")
    // run the fetch handler with fake events: a page navigation is answered, an /api/ navigation is left to the network
    const listeners: Record<string, (e: unknown) => void> = {}
    const self = { location: { origin: 'https://x.test' }, addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f }, skipWaiting() {}, clients: { claim() {} }, registration: {} }
    const caches = { open: async () => ({ match: async () => undefined, put: async () => {}, addAll: async () => {} }), keys: async () => [], delete: async () => true, match: async () => undefined }
    new Function('self', 'caches', 'fetch', 'URL', 'Response', 'Request', src)(self, caches, async () => new Response('net'), URL, Response, Request)
    const run = (path: string) => {
      let answered = false
      listeners.fetch({ request: { method: 'GET', url: `https://x.test${path}`, mode: 'navigate', headers: new Headers() }, respondWith: (p: Promise<unknown>) => { answered = true; void Promise.resolve(p).catch(() => {}) }, waitUntil() {} })
      return answered
    }
    expect(run('/')).toBe(true)
    expect(run('/api/v1/attachments/att_1')).toBe(false)
    expect(run('/api/v1/notifications/unsubscribe?t=x')).toBe(false)
  })
})

describe('offline support on the server', () => {
  const secret = Buffer.alloc(32, 7)
  it('the offline key is stable per user, device and epoch, and different otherwise', () => {
    const k = deriveOfflineKey(secret, 'u1', 'dev00001', 0)
    expect(Buffer.from(k, 'base64url')).toHaveLength(32)
    expect(deriveOfflineKey(secret, 'u1', 'dev00001', 0)).toBe(k)
    expect(deriveOfflineKey(secret, 'u1', 'dev00001', 1)).not.toBe(k)
    expect(deriveOfflineKey(secret, 'u2', 'dev00001', 0)).not.toBe(k)
    expect(deriveOfflineKey(secret, 'u1', 'dev00002', 0)).not.toBe(k)
    expect(deriveOfflineKey(Buffer.alloc(32, 8), 'u1', 'dev00001', 0)).not.toBe(k)
  })
  it('idempotency keys are per environment and user, and validated', () => {
    expect(idempotencyHash('e', 'u1', 'k')).not.toBe(idempotencyHash('e', 'u2', 'k'))
    expect(idempotencyHash('e1', 'u1', 'k')).not.toBe(idempotencyHash('e2', 'u1', 'k'))
    const ctx = (v?: string) => ({ req: { headers: v === undefined ? {} : { 'idempotency-key': v } } }) as never
    expect(idempotencyKeyOf(ctx())).toBeNull()
    expect(idempotencyKeyOf(ctx('ob_abc.0'))).toBe('ob_abc.0')
    expect(() => idempotencyKeyOf(ctx('short'))).toThrow(/Idempotency-Key/)
    expect(() => idempotencyKeyOf(ctx('has space in it'))).toThrow()
  })
})
