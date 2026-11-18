/**
 * Reference pages generated from the code, plus the staleness check.
 *
 *   npm run docs:gen   writes docs/reference/*.md
 *   npm test           fails when a page differs from what the code would generate
 *
 * Write mode is on when DOCS_WRITE=1 or when started through `npm run docs:gen`
 * (npm sets npm_lifecycle_event, which works the same in PowerShell, cmd and bash).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { controls } from '@/controls'
import { fx } from '@/fx'
import { buildControlsPage } from './controls'
import { buildFormulasPage } from './formulas'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WRITE = process.env.DOCS_WRITE === '1' || process.env.npm_lifecycle_event === 'docs:gen'

const normalise = (s: string): string => s.replace(/\r\n/g, '\n')

function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n')
  const e = expected.split('\n')
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) return `first difference at line ${i + 1}:\n  file:      ${JSON.stringify(a[i] ?? '(end of file)')}\n  generated: ${JSON.stringify(e[i] ?? '(end of file)')}`
  }
  return 'no difference found'
}

/** Writes the page (write mode) or checks that the file on disk is identical to it. */
function writeOrCheck(relPath: string, text: string): void {
  const file = resolve(root, relPath)
  if (WRITE) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    return
  }
  let onDisk: string
  try {
    onDisk = normalise(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${relPath} does not exist. Run \`npm run docs:gen\` and commit the result.`)
  }
  if (onDisk !== text) {
    throw new Error(`${relPath} is stale. Run \`npm run docs:gen\` and commit the result.\n${firstDifference(onDisk, text)}`)
  }
}

function warn(page: string, warnings: string[]): void {
  for (const w of warnings) console.warn(`[docs] ${page}: ${w}`)
}

describe('generated reference docs', () => {
  it('docs/reference/formulas.md matches the formula engine', () => {
    const { text, warnings } = buildFormulasPage(fx, controls)
    warn('formulas.md', warnings)
    expect(text.length).toBeGreaterThan(1000)
    writeOrCheck('docs/reference/formulas.md', text)
  })

  it('every control has a description', () => {
    const { missingDescriptions } = buildControlsPage(controls, fx.enums())
    expect(missingDescriptions, `Add a one-line description in scripts/docs/controls.ts (DESCRIPTIONS) for: ${missingDescriptions.join(', ')}`).toEqual([])
  })

  it('docs/reference/controls.md matches the control registry', () => {
    const { text, warnings } = buildControlsPage(controls, fx.enums())
    warn('controls.md', warnings)
    expect(text.length).toBeGreaterThan(1000)
    writeOrCheck('docs/reference/controls.md', text)
  })

  it('generation is deterministic', () => {
    expect(buildFormulasPage(fx, controls).text).toBe(buildFormulasPage(fx, controls).text)
    expect(buildControlsPage(controls, fx.enums()).text).toBe(buildControlsPage(controls, fx.enums()).text)
  })
})
