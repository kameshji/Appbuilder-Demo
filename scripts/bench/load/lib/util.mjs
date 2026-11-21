/**
 * Small helpers of the load harness (scripts/bench/load). DEVELOPER TOOL, not part of the product.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
export const WIN = process.platform === 'win32'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)
export const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null)

const T0 = Date.now()
export function log(m) {
  process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)} s] ${m}\n`)
}

/** a seeded PRNG (mulberry32): the same seed gives the same scenario sequence */
export function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    /** exponential with the given mean (inter-arrival times of a Poisson process) */
    exp: (mean) => -Math.log(1 - next()) * mean,
    weighted(entries) {
      const total = entries.reduce((s, e) => s + e[1], 0)
      let x = next() * total
      for (const [k, w] of entries) { x -= w; if (x <= 0) return k }
      return entries[entries.length - 1][0]
    },
  }
}

/** percentile of a sorted copy (nearest rank) */
export function pct(values, p) {
  if (!values.length) return null
  const s = Float64Array.from(values).sort()
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}
export function summary(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null }
  const s = Float64Array.from(values).sort()
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
  let sum = 0
  for (const v of s) sum += v
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1], mean: sum / s.length }
}
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
export const stdev = (a) => {
  if (a.length < 2) return null
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}

export function folderBytes(dir) {
  let b = 0
  const walk = (d) => {
    let list = []
    try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else try { b += fs.statSync(p).size } catch { /* gone */ }
    }
  }
  walk(dir)
  return b
}

export const MB = (b) => r1(Number(b) / 2 ** 20)

/** a PNG of w x h pixels of noise (incompressible, like a phone photo of the same byte size) */
export async function noisePng(w, h, seed = 1) {
  const zlib = await import('node:zlib')
  const g = rng(seed)
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (g.next() * 256) | 0
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}

/** a random UUID v4 (client-made row ids, as the phone outbox makes them) */
export { randomUUID as uuid } from 'node:crypto'
