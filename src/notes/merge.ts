/**
 * Conflict handling of notes (docs/dev/notes.md): when a save answers 409 (someone saved the note after this tab loaded
 * it: the data API's `ifModifiedOn` check), the page offers "keep mine", "take theirs" and, when the two edits touched
 * different paragraphs, "merge both". The merge is a three-way merge of the top-level blocks of the body (paragraphs,
 * headings, lists, tables): base = what this tab loaded, mine = this tab's text, theirs = the saved one.
 */
import { parseNoteHtml, serializeNote } from './sanitize.ts'

/** the top-level blocks of a body, each as its own HTML */
export function blocksOf(html: string): string[] {
  return parseNoteHtml(html).map((n) => serializeNote([n])).filter((b) => b !== '')
}

/** above this many cells of the comparison table no merge is attempted (the person chooses) */
const MAX_CELLS = 4_000_000

/** index pairs (i in a, j in b) of a longest common subsequence */
export function lcsPairs(a: string[], b: string[]): [number, number][] | null {
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return null
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return out
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i])

export type MergeResult = { ok: true; html: string } | { ok: false; reason: 'overlap' | 'too-large' }

/**
 * Three-way merge of blocks. A region changed on one side only takes that side; changed the same way on both sides
 * takes it once; changed differently on both sides is a conflict (no merge: the person chooses).
 */
export function mergeNotes(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { ok: true, html: mine }
  if (base === theirs) return { ok: true, html: mine }
  if (base === mine) return { ok: true, html: theirs }
  const B = blocksOf(base)
  const A = blocksOf(mine)
  const T = blocksOf(theirs)
  const ma = lcsPairs(B, A)
  const mt = lcsPairs(B, T)
  if (!ma || !mt) return { ok: false, reason: 'too-large' }
  const toA = new Map(ma.map(([i, j]) => [i, j]))
  const toT = new Map(mt.map(([i, j]) => [i, j]))
  // anchors: base blocks kept unchanged on both sides
  const anchors: [number, number, number][] = []
  for (let i = 0; i < B.length; i++) if (toA.has(i) && toT.has(i)) anchors.push([i, toA.get(i)!, toT.get(i)!])
  const out: string[] = []
  let pb = -1
  let pa = -1
  let pt = -1
  const region = (bi: number, ai: number, ti: number): boolean => {
    const b = B.slice(pb + 1, bi)
    const a = A.slice(pa + 1, ai)
    const t = T.slice(pt + 1, ti)
    if (same(a, b)) out.push(...t)
    else if (same(t, b)) out.push(...a)
    else if (same(a, t)) out.push(...a)
    else return false
    return true
  }
  for (const [bi, ai, ti] of anchors) {
    if (!region(bi, ai, ti)) return { ok: false, reason: 'overlap' }
    out.push(B[bi])
    pb = bi
    pa = ai
    pt = ti
  }
  if (!region(B.length, A.length, T.length)) return { ok: false, reason: 'overlap' }
  return { ok: true, html: out.join('') }
}
