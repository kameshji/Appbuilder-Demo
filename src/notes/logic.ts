/**
 * Pure helpers of the Notes page (docs/dev/notes.md): mentions, share diffing, search highlighting. No React, no DOM.
 */
import { noteMentionIds } from './sanitize.ts'

/* ------------------------------------------------------------------ mentions */

/** the "@na" being typed right before the caret (letters and digits of any script, so Hindi names work), or null */
export function mentionQuery(textBeforeCaret: string): string | null {
  const m = /(^|[\s (])@([\p{L}\p{M}\p{N}._-]{0,30})$/u.exec(textBeforeCaret)
  return m ? m[2] : null
}

/** people mentioned in `after` and not in `before` (they are notified once) */
export function addedMentions(before: string, after: string): string[] {
  const had = new Set(noteMentionIds(before))
  return noteMentionIds(after).filter((id) => !had.has(id))
}

/* ------------------------------------------------------------------ shares */

export type Access = 'read' | 'edit'
export interface ShareRow { id: string; PrincipalType: 'user' | 'team'; Principal: string; Access: Access }
export interface WantedShare { PrincipalType: 'user' | 'team'; Principal: string; Access: Access }

export interface ShareDiff {
  add: WantedShare[]
  change: { id: string; Access: Access }[]
  remove: string[]
}

const keyOf = (s: { PrincipalType: string; Principal: string }) => `${s.PrincipalType}:${s.Principal}`

/** what to write to go from the share rows there are to the ones wanted (one row per person or team) */
export function diffShares(current: ShareRow[], wanted: WantedShare[]): ShareDiff {
  const want = new Map<string, WantedShare>()
  for (const w of wanted) want.set(keyOf(w), w)
  const seen = new Set<string>()
  const out: ShareDiff = { add: [], change: [], remove: [] }
  for (const c of current) {
    const k = keyOf(c)
    const w = want.get(k)
    if (!w || seen.has(k)) {
      out.remove.push(c.id)
      continue
    }
    seen.add(k)
    if (w.Access !== c.Access) out.change.push({ id: c.id, Access: w.Access })
  }
  // only the three columns (the wanted entries may carry display fields such as a name)
  for (const [k, w] of want) if (!seen.has(k)) out.add.push({ PrincipalType: w.PrincipalType, Principal: w.Principal, Access: w.Access })
  return out
}

export const isEmptyDiff = (d: ShareDiff) => !d.add.length && !d.change.length && !d.remove.length

/* ------------------------------------------------------------------ search */

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** the words of a search (at most 8) */
export function searchTerms(q: string): string[] {
  return [...new Set(q.normalize('NFC').trim().split(/\s+/).filter(Boolean))].slice(0, 8)
}

export interface Segment { text: string; hit: boolean }

/** the text cut into plain and matching parts (case-insensitive, any script), for <mark> */
export function highlight(raw: string, q: string): Segment[] {
  const text = raw.normalize('NFC')
  const terms = searchTerms(q)
  if (!terms.length || !text) return text ? [{ text, hit: false }] : []
  const re = new RegExp(terms.sort((a, b) => b.length - a.length).map(escRe).join('|'), 'giu')
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), hit: false })
    out.push({ text: m[0], hit: true })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out
}

/** a short excerpt of `text` around the first match (or its start), at most `len` characters, on word boundaries */
export function snippet(text: string, q: string, len = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= len) return flat
  const terms = searchTerms(q)
  let at = -1
  if (terms.length) {
    const m = new RegExp(terms.map(escRe).join('|'), 'iu').exec(flat)
    at = m?.index ?? -1
  }
  if (at < 0) return flat.slice(0, len).replace(/\s+\S*$/, '') + '...'
  let start = Math.max(0, at - Math.floor(len / 3))
  if (start > 0) {
    const sp = flat.indexOf(' ', start)
    if (sp > 0 && sp < at) start = sp + 1
  }
  const end = Math.min(flat.length, start + len)
  let s = flat.slice(start, end)
  if (end < flat.length) s = s.replace(/\s+\S*$/, '') + '...'
  return (start > 0 ? '...' : '') + s
}

/** does a note match every search word (in its title or text)? */
export function matchesAll(title: string, text: string, q: string): boolean {
  const terms = searchTerms(q).map((t) => t.toLocaleLowerCase())
  if (!terms.length) return true
  const hay = `${title}\n${text}`.normalize('NFC').toLocaleLowerCase()
  return terms.every((t) => hay.includes(t))
}
