/**
 * Naming guard (master plan 11.1, P0 package M): user-facing text says "UI component", never "control".
 *
 * Code identifiers (src/controls, ControlType, controls.get, data-testid="control-...", storage keys), route names and
 * the formula language keep the old word. This test looks only at what a person reads:
 *   1. the UI component registry (labels, categories, property labels and descriptions) and the formula function
 *      signatures and summaries;
 *   2. the hand-written parts of the generated reference (scripts/docs);
 *   3. every string literal and JSX text in src/ and server/ (comments and tests excluded) that reads as a phrase.
 * Unrelated meanings are allowed by the phrase list below (access control, Cache-Control, the video player's
 * `Controls` property, the "Segmented control" component name).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { controls } from '@/controls'
import { fx } from '@/fx'
import { DESCRIPTIONS, NOTES } from './docs/controls'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OLD = /\bcontrols?\b/i

/** phrases where "control" means something else; matched case-insensitively and removed before the check */
const ALLOWED = [
  /segmented[- ]control/gi,
  /access[- ]control/gi,
  /control (access|who|what)\b/gi,
  /cache-control/gi,
  /version control/gi,
  /control flow/gi,
]

function offending(text: string): boolean {
  let t = text
  for (const a of ALLOWED) t = t.replace(a, '')
  return OLD.test(t)
}

/** a string that reads as words (has a space between letters), not a key such as 'appbuilder-recent-controls' */
const isPhrase = (s: string): boolean => /[A-Za-z][^\S\n]+[A-Za-z]/.test(s)

/** string literals and JSX text of a TS/TSX file, comments removed. A small scanner, good enough for this code base. */
export function userText(src: string): string[] {
  const out: string[] = []
  let code = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; continue }
        if (c !== '`' && src[j] === '\n') break
        s += src[j]
        j++
      }
      out.push(s)
      code += ' "" '
      i = j + 1
      continue
    }
    code += c
    i++
  }
  for (const m of code.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</g)) out.push(m[1]!)
  return out
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, acc) }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) acc.push(p)
  }
  return acc
}

describe('naming: "UI components", not "controls", in user-facing text', () => {
  it('the scanner finds string literals and JSX text and skips comments', () => {
    const found = userText(`// a control comment\nconst a = 'Search controls' /* control */\nconst b = <p>No control matches</p>\nconst k = 'appbuilder-recent-controls'`)
    expect(found).toContain('Search controls')
    expect(found).toContain('No control matches')
    expect(found.some((s) => s.includes('comment'))).toBe(false)
    expect(found.filter((s) => isPhrase(s) && offending(s))).toEqual(['Search controls', 'No control matches'])
  })

  it('UI component registry labels, categories and property texts', () => {
    const bad: string[] = []
    for (const c of [controls.get('Screen'), ...controls.list()]) {
      const texts: [string, string | undefined][] = [['label', c.label], ['category', c.category]]
      for (const p of controls.propsOf(c.type)) {
        const meta = p as unknown as Record<string, unknown>
        for (const k of ['displayName', 'label', 'description', 'hint', 'group']) if (typeof meta[k] === 'string') texts.push([`${p.name}.${k}`, meta[k] as string])
      }
      for (const [where, t] of texts) if (t && offending(t)) bad.push(`${c.type} ${where}: ${t}`)
    }
    expect(bad).toEqual([])
  })

  it('formula function signatures and summaries', () => {
    const bad = fx.functions().filter((f) => offending(`${f.signature} ${f.summary}`)).map((f) => `${f.name}: ${f.signature} ${f.summary}`)
    expect(bad).toEqual([])
  })

  it('hand-written parts of the generated reference', () => {
    const texts = [...Object.values(DESCRIPTIONS), ...Object.values(NOTES).flat()]
    expect(texts.filter(offending)).toEqual([])
    const page = readFileSync(resolve(root, 'docs/reference/ui-components.md'), 'utf8')
    const lines = page.split('\n').filter((l) => !l.startsWith('|') && offending(l))
    expect(lines).toEqual([])
  })

  it('string literals and JSX text in src/ and server/', () => {
    const bad: string[] = []
    for (const file of [...walk(resolve(root, 'src')), ...walk(resolve(root, 'server'))]) {
      for (const s of userText(readFileSync(file, 'utf8'))) {
        if (isPhrase(s) && offending(s)) bad.push(`${relative(root, file)}: ${s.trim().slice(0, 120)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
