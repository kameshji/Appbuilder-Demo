/**
 * Small helpers of the identity package: the client's address, a readable device name from a User-Agent, IP allow-lists
 * (CIDR), random codes, cookie writing next to the session cookie.
 */
import net from 'node:net'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cookieIsSecure, type CookieOptions } from '../router.ts'

/** the peer address (IPv4-mapped IPv6 shortened); behind a trusted proxy the first X-Forwarded-For entry */
export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (xff && net.isIP(xff.replace(/^::ffff:/, ''))) return xff.replace(/^::ffff:/, '')
  }
  const a = req.socket?.remoteAddress ?? ''
  return a.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
}

/** "Chrome 131 on Windows", "Firefox 133 on Linux", "curl 8.5" ... (best effort, for people, never for decisions) */
export function deviceName(ua: string | null | undefined): string {
  const u = String(ua ?? '')
  if (!u) return 'Unknown device'
  const os = /Windows NT/.test(u) ? 'Windows' : /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /CrOS/.test(u) ? 'ChromeOS' : /Linux/.test(u) ? 'Linux' : ''
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(u)
    return m ? `${name} ${m[1].split('.')[0]}` : null
  }
  const browser = pick(/Edg\/([\d.]+)/, 'Edge') ?? pick(/OPR\/([\d.]+)/, 'Opera') ?? pick(/Firefox\/([\d.]+)/, 'Firefox')
    ?? pick(/HeadlessChrome\/([\d.]+)/, 'Headless Chrome') ?? pick(/Chrome\/([\d.]+)/, 'Chrome') ?? (/Safari\//.test(u) ? pick(/Version\/([\d.]+)/, 'Safari') : null)
    ?? pick(/curl\/([\d.]+)/, 'curl') ?? pick(/node(?:-fetch)?\/?([\d.]*)/i, 'Node.js')
  if (browser && os) return `${browser} on ${os}`
  return browser ?? (os || u.slice(0, 60))
}

/* ------------------------------------------------------------------ IP allow-lists */

function ipToBigInt(ip: string): { v: bigint; bits: 32 | 128 } | null {
  const plain = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
  if (net.isIPv4(plain)) {
    const p = plain.split('.').map(Number)
    return { v: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]), bits: 32 }
  }
  if (!net.isIPv6(plain)) return null
  let [head, tail] = plain.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : []
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : []
  const groups = [...h, ...fill, ...t]
  if (groups.length !== 8) return null
  let v = 0n
  for (const g of groups) v = (v << 16n) + BigInt(parseInt(g || '0', 16))
  return { v, bits: 128 }
}

/** "10.0.0.0/8", "192.168.1.20", "2001:db8::/32"; throws on anything else */
export function parseCidr(text: string): { v: bigint; bits: 32 | 128; prefix: number } {
  const [addr, len] = text.trim().split('/')
  const ip = ipToBigInt(addr)
  if (!ip) throw new Error(`"${text}" is not an IP address or range.`)
  const prefix = len === undefined ? ip.bits : Number(len)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) throw new Error(`"${text}" has an invalid prefix length.`)
  return { ...ip, prefix }
}

export function ipAllowed(ip: string, allow: string[] | null | undefined): boolean {
  if (!allow || !allow.length) return true
  const a = ipToBigInt(ip)
  if (!a) return false
  for (const entry of allow) {
    let c: ReturnType<typeof parseCidr>
    try {
      c = parseCidr(entry)
    } catch {
      continue
    }
    if (c.bits !== a.bits) continue
    const shift = BigInt(c.bits - c.prefix)
    if (a.v >> shift === c.v >> shift) return true
  }
  return false
}

/* ------------------------------------------------------------------ tokens and codes */

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')

/** unambiguous alphabet (no 0/O, 1/I/L) */
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** n random characters of the unambiguous alphabet, grouped by 4 with dashes */
export function randomCode(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHA[randomInt(ALPHA.length)]
  return s.replace(/(.{4})(?=.)/g, '$1-')
}
/** what the user typed -> the form that was hashed (case, spaces and dashes ignored) */
export const normaliseCode = (s: string): string => String(s ?? '').toUpperCase().replace(/[\s-]/g, '')
export const numericCode = (digits = 6): string => String(randomInt(10 ** digits)).padStart(digits, '0')

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/* ------------------------------------------------------------------ cookies */

export function setCookie(req: IncomingMessage, res: ServerResponse, name: string, value: string | null, maxAgeSeconds: number, o: CookieOptions = {}): void {
  const secure = cookieIsSecure(req, o) ? '; Secure' : ''
  const c = value === null
    ? `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
    : `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`
  const prev = res.getHeader('Set-Cookie')
  const list = Array.isArray(prev) ? prev.filter((x) => !x.startsWith(name + '=')) : typeof prev === 'string' ? [prev].filter((x) => !x.startsWith(name + '=')) : []
  res.setHeader('Set-Cookie', [...list, c])
}
