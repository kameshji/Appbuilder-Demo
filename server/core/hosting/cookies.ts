/**
 * The __Host- cookie prefix of an install served over HTTPS at a locked public URL (H-A; spec threat model row 5).
 *
 * Sibling installs (a.<domain>, b.<domain>) are the same site to a browser: a page on A could set a cookie with
 * Domain=<domain> that B then receives ("cookie tossing"). A browser accepts a __Host- cookie only when it is Secure, has
 * Path=/ and no Domain, so a __Host- cookie can only come from the install's own host.
 *
 * Done at the HTTP boundary, so every Appbuilder cookie (ab_session, ab_mfa, ab_td, ab_dev) gets it without the code
 * that sets or reads them knowing:
 *   - in:  the Cookie header is rewritten to hold only the __Host-ab_* cookies, under their plain names; plain ab_*
 *          cookies (old sessions from before the switch, or tossed ones) are ignored;
 *   - out: just before the head is written, every Set-Cookie of an ab_* cookie is renamed to __Host-ab_*, made Secure,
 *          Path=/ and stripped of any Domain; the plain cookies the request carried are cleared (Max-Age=0).
 *
 * Migration: when the prefix is switched on, existing sessions are not carried over (accepting a plain cookie would keep
 * the tossing hole open). People sign in once more; the old cookies are cleared on their first request; a remembered
 * device asks for the second step once. No error is shown: the client sees "not signed in" and opens the sign-in page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const HOST_PREFIX = '__Host-'
const OURS = /^ab_[a-z0-9_]+$/i

const LEGACY = Symbol('abLegacyCookies')
const ADAPTED = Symbol('abHostCookies')

/** rewrites the request's Cookie header (idempotent); returns the plain ab_* names it dropped */
export function adaptCookiesIn(req: IncomingMessage): string[] {
  const r = req as IncomingMessage & { [LEGACY]?: string[] }
  if (r[LEGACY]) return r[LEGACY]!
  const header = req.headers.cookie
  const legacy: string[] = []
  if (header) {
    const kept: string[] = []
    for (const part of header.split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      const name = part.slice(0, i).trim()
      const value = part.slice(i + 1).trim()
      if (name.startsWith(HOST_PREFIX) && OURS.test(name.slice(HOST_PREFIX.length))) kept.push(`${name.slice(HOST_PREFIX.length)}=${value}`)
      else if (OURS.test(name)) {
        if (!legacy.includes(name)) legacy.push(name)
      } else kept.push(`${name}=${value}`)
    }
    if (kept.length) req.headers.cookie = kept.join('; ')
    else delete req.headers.cookie
  }
  r[LEGACY] = legacy
  return legacy
}

/** one Set-Cookie value with the prefix: __Host-name, Secure, Path=/, no Domain */
export function hostCookie(setCookie: string): string {
  const i = setCookie.indexOf('=')
  if (i < 0) return setCookie
  const name = setCookie.slice(0, i).trim()
  if (!OURS.test(name)) return setCookie
  const [first, ...attrs] = setCookie.split(';')
  const keep = attrs.map((a) => a.trim()).filter((a) => a && !/^(domain|path|secure)(=|$)/i.test(a))
  return [`${HOST_PREFIX}${first.trim()}`, ...keep, 'Path=/', 'Secure'].join('; ')
}

/** renames the response's Set-Cookie headers just before the head is written (all ways of writing it go through writeHead) */
export function adaptCookiesOut(req: IncomingMessage, res: ServerResponse): void {
  const r = res as ServerResponse & { [ADAPTED]?: boolean }
  if (r[ADAPTED]) return
  r[ADAPTED] = true
  const legacy = adaptCookiesIn(req)
  const original = res.writeHead
  const fix = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]).map(hostCookie)
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    const set = fix(this.getHeader('set-cookie'))
    // headers passed to writeHead itself (an object, or a flat [k, v, ...] array)
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        const h = a as Record<string, unknown>
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'set-cookie') {
            set.push(...fix(h[k]))
            delete h[k]
          }
        }
      }
    }
    // the plain cookies the browser sent (from before the switch) are cleared: they are never read again
    const cleared = legacy.map((n) => `${n}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    if (set.length || cleared.length) this.setHeader('Set-Cookie', [...set, ...cleared])
    return (original as (...a: unknown[]) => ServerResponse).apply(this, args)
  } as ServerResponse['writeHead']
}
