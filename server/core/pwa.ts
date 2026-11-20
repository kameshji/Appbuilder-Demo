/**
 * Progressive web app (P2 package A, docs/dev/phone.md "PWA"): the web app manifests, the home screen icons and the
 * service worker script. Everything is generated here; nothing is added to the build.
 *
 *   GET /pwa/manifest.webmanifest              the install manifest (name "Appbuilder", start at My apps). No session needed.
 *   GET /pwa/apps/:id/manifest.webmanifest     one app's manifest (its name, an icon in its colour, starts the app).
 *                                              Signed-in users who may run the app; the page swaps <link rel=manifest>
 *                                              to it while the app is open, so "Add to Home screen" adds that app.
 *   GET /pwa/icon.png?s=&c=&t=&m=              a PNG icon: size 48..1024, colour (6 hex digits), up to 2 letters or
 *                                              digits, m=1 maskable (full bleed, content in the 80 % safe zone).
 *                                              Deterministic from the parameters; nothing about any app is read.
 *   GET /pwa/sw.js                             the service worker, scope "/" (Service-Worker-Allowed: /). Its text
 *                                              carries the build version, so a new build is a new worker (update flow).
 *
 * The service worker caches the application shell (dist/index.html, the single-file build) and these icons only. It
 * never answers /api/ requests from a cache (except the icons and manifests above), so no data is ever cached by it;
 * offline data lives in the explicit, encrypted offline store (src/phone/offline). See docs/dev/phone.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { HttpError } from './contracts.ts'
import type { Ctx, RawResponse, Services, ServerConfig } from './contracts.ts'
import type { ApiRouter } from './router.ts'
import { SECURITY_HEADERS } from './router.ts'
import { serverVersion } from './auth.ts'

/* ------------------------------------------------------------------ colours */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const hex2 = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0')

/** CSS colour -> "rrggbb" for #rgb, #rrggbb, rgb()/rgba() and oklch(); null when not understood */
export function colourHex(css: string | undefined | null): string | null {
  if (!css) return null
  const s = css.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return m[1].split('').map((c) => c + c).join('')
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s)
  if (m) return m[1]
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s)
  if (m) return [m[1], m[2], m[3]].map((v) => hex2(Number(v) / 255)).join('')
  m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/.exec(s)
  if (m) {
    const L = Number(m[1]) / (m[2] ? 100 : 1)
    const C = Number(m[3])
    const h = (Number(m[4]) * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    const lin = [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ]
    const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
    return lin.map((x) => hex2(gamma(clamp01(x)))).join('')
  }
  return null
}

export const DEFAULT_COLOUR = '4f46e5'

/** up to two letters or digits for an icon: the initials of the first two words ("Production log" -> "PL") */
export function initialsOf(name: string): string {
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'A'
  const t = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return t.toUpperCase()
}

/* ------------------------------------------------------------------ PNG icons */

/** 5x7 bitmap glyphs (rows top to bottom, 5 bits each, MSB = left) for A-Z and 0-9 */
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** RGBA pixels (w*h*4) -> PNG file */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/**
 * The icon: a rounded square (maskable: a full-bleed square) in the colour, with the letters in white, 4x supersampled
 * for smooth edges. Pure; unit-tested.
 */
export function iconPng(size: number, colourHex6: string, text: string, maskable = false): Buffer {
  const S = 4
  const n = size * S
  const r = parseInt(colourHex6.slice(0, 2), 16)
  const g = parseInt(colourHex6.slice(2, 4), 16)
  const b = parseInt(colourHex6.slice(4, 6), 16)
  // letters: glyphs 5x7 with 1 column gap, scaled to fit 52 % (maskable: 40 %) of the width
  const glyphs = text.split('').map((ch) => FONT[ch] ?? FONT.A)
  const cols = glyphs.length * 6 - 1
  const area = n * (maskable ? 0.4 : 0.52)
  const cell = Math.max(1, Math.floor(Math.min(area / cols, (n * 0.42) / 7)))
  const tw = cols * cell
  const th = 7 * cell
  const ox = Math.round((n - tw) / 2)
  const oy = Math.round((n - th) / 2)
  const radius = maskable ? 0 : n * 0.22
  const inShape = (x: number, y: number): boolean => {
    if (maskable) return true
    const cx = Math.min(Math.max(x, radius), n - radius)
    const cy = Math.min(Math.max(y, radius), n - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
  }
  const inText = (x: number, y: number): boolean => {
    const gx = x - ox
    const gy = y - oy
    if (gx < 0 || gy < 0 || gx >= tw || gy >= th) return false
    const col = Math.floor(gx / cell)
    const row = Math.floor(gy / cell)
    const gi = Math.floor(col / 6)
    const bit = col % 6
    if (bit === 5) return false
    return ((glyphs[gi][row] >> (4 - bit)) & 1) === 1
  }
  const out = new Uint8Array(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0
      let white = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px * S + sx + 0.5
          const y = py * S + sy + 0.5
          if (!inShape(x, y)) continue
          cover++
          if (inText(x, y)) white++
        }
      }
      const i = (py * size + px) * 4
      if (cover === 0) continue
      const wf = white / cover
      out[i] = Math.round(r + (255 - r) * wf)
      out[i + 1] = Math.round(g + (255 - g) * wf)
      out[i + 2] = Math.round(b + (255 - b) * wf)
      out[i + 3] = Math.round((cover / (S * S)) * 255)
    }
  }
  return encodePng(size, size, out)
}

/* ------------------------------------------------------------------ manifests */

export interface ManifestInput {
  name: string
  shortName?: string
  startUrl: string
  id: string
  colour: string
  letters: string
  description?: string
}

export function iconUrl(size: number, colour: string, letters: string, maskable = false): string {
  return `/api/v1/pwa/icon.png?s=${size}&c=${colour}&t=${encodeURIComponent(letters)}${maskable ? '&m=1' : ''}`
}

export function manifestOf(m: ManifestInput): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    short_name: (m.shortName ?? m.name).slice(0, 24),
    description: m.description ?? 'Apps built with Appbuilder',
    start_url: m.startUrl,
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: `#${m.colour}`,
    icons: [
      { src: iconUrl(192, m.colour, m.letters), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl(512, m.colour, m.letters), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconUrl(192, m.colour, m.letters, true), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: iconUrl(512, m.colour, m.letters, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/* ------------------------------------------------------------------ service worker */

/** the build the service worker belongs to: dist/index.html's size and mtime plus the server version */
export function shellVersion(distDir: string): string {
  let id = 'nobuild'
  try {
    const st = fs.statSync(path.join(distDir, 'index.html'))
    id = `${st.size}-${Math.round(st.mtimeMs)}`
  } catch {
    /* not built yet */
  }
  return createHash('sha256').update(`${serverVersion()}:${id}`).digest('hex').slice(0, 16)
}

/**
 * The service worker's source. Plain JS (it runs in the browser's worker), kept as a template so the version is part
 * of the bytes: the browser installs a new worker exactly when the build changes.
 */
export function serviceWorkerSource(version: string): string {
  return `/* Appbuilder service worker (generated by server/core/pwa.ts). Build ${version}. */
'use strict';
const VERSION = ${JSON.stringify(version)};
const SHELL = 'ab-shell-' + VERSION;
const SHELL_URLS = ['/', '/api/v1/pwa/manifest.webmanifest'];
// never from a cache: the API (data, sessions), uploads, the live socket. Only these API paths are static:
const STATIC_API = /^\\/api\\/v1\\/pwa\\/(icon\\.png|manifest\\.webmanifest|apps\\/[^/]+\\/manifest\\.webmanifest)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)));
  // no skipWaiting here: an open page keeps its version until the user chooses "Reload" (safe update flow)
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ab-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const t = event.data && event.data.type;
  if (t === 'skip-waiting') self.skipWaiting();
  else if (t === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
  else if (t === 'clear') {
    // sign-out or "wipe device data": drop every cache this worker made
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ab-')).map((k) => caches.delete(k)))).then(() => {
      if (event.ports && event.ports[0]) event.ports[0].postMessage({ cleared: true });
    }));
  }
});

async function shell(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match('/');
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put('/', res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && !url.pathname.startsWith('/api/')) {
    // the app is one page: every page navigation gets the cached shell of this worker's build (works offline).
    // Navigations to /api/ are files and server pages (PDF previews, attachments opened in a tab, downloads,
    // the unsubscribe page): they must reach the server, never the shell.
    event.respondWith(shell(req).catch(() => fetch(req)));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (!STATIC_API.test(url.pathname)) return; // network only: data is never cached here
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && url.pathname.endsWith('icon.png')) cache.put(req, res.clone());
      return res;
    })());
  }
});
`
}

/* ------------------------------------------------------------------ routes */

const LETTERS = /^[A-Z0-9]{1,2}$/
const raw = (body: Buffer | string, type: string, extra: Record<string, string> = {}): RawResponse => ({
  raw: true,
  status: 200,
  headers: { ...SECURITY_HEADERS, 'Content-Type': type, ...extra },
  body,
})

export function pwaRoutes(router: ApiRouter, services: Services & { config: ServerConfig }): void {
  router.add('GET', '/pwa/manifest.webmanifest', () => {
    const m = manifestOf({ id: '/', name: 'Appbuilder', startUrl: '/', colour: DEFAULT_COLOUR, letters: 'AB' })
    return raw(JSON.stringify(m), 'application/manifest+json; charset=utf-8', { 'Cache-Control': 'no-cache' })
  }, { auth: 'none' })

  router.add('GET', '/pwa/apps/:id/manifest.webmanifest', async (ctx: Ctx) => {
    const u = ctx.user!
    const a = await services.meta.apps.get(ctx.params.id)
    if (!a) throw new HttpError(404, 'not-found', 'App not found.')
    // P2 security re-check (finding P2-7): the same answer as an app that does not exist (no existence oracle)
    if (!u.privileges.isAdmin && !u.privileges.isMaker && !u.canRunApp(a.meta.id)) throw new HttpError(404, 'not-found', 'App not found.')
    const def = a.definition as { theme?: { primary?: string }; offline?: { color?: string } }
    const colour = colourHex(def.theme?.primary) ?? DEFAULT_COLOUR
    const id = encodeURIComponent(a.meta.id)
    const m = manifestOf({ id: `/?app=${id}`, name: a.meta.name, startUrl: `/?app=${id}`, colour, letters: initialsOf(a.meta.name), description: a.meta.description || undefined })
    return raw(JSON.stringify(m), 'application/manifest+json; charset=utf-8', { 'Cache-Control': 'no-cache' })
  }, { auth: 'user' })

  router.add('GET', '/pwa/icon.png', (ctx: Ctx) => {
    const s = Number(ctx.query.get('s') ?? '192')
    if (!Number.isInteger(s) || s < 48 || s > 1024) throw new HttpError(422, 'invalid', 's must be a whole number from 48 to 1024.', 's')
    const c = (ctx.query.get('c') ?? DEFAULT_COLOUR).toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(c)) throw new HttpError(422, 'invalid', 'c must be 6 hex digits.', 'c')
    const t = (ctx.query.get('t') ?? 'AB').toUpperCase()
    if (!LETTERS.test(t)) throw new HttpError(422, 'invalid', 't must be one or two letters or digits.', 't')
    const png = iconPng(s, c, t, ctx.query.get('m') === '1')
    return raw(png, 'image/png', { 'Cache-Control': 'public, max-age=86400', 'Content-Length': String(png.length) })
  }, { auth: 'none' })

  router.add('GET', '/pwa/sw.js', () => {
    const src = serviceWorkerSource(shellVersion(services.config.distDir))
    return raw(src, 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' })
  }, { auth: 'none' })
}
