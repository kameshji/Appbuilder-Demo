/**
 * Layering of the formula engine (docs/dev/architecture.md, rule 3): src/fx is shared with the server, so its
 * non-test source files may only import
 *  - other files inside src/fx, with relative paths and an explicit `.ts` extension (Node type stripping);
 *  - with `import type` only (erased at run time): src/contracts.ts, src/platform/query.ts, src/platform/http.ts.
 * Never react, a package, the `@/` alias, src/runtime, src/studio, src/portal, src/controls or src/platform code.
 * It also must not touch browser globals when a module loads.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fxDir = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(fxDir, '..')
const TYPE_ONLY_OUTSIDE = new Set(['contracts.ts', 'platform/query.ts', 'platform/http.ts'].map((p) => path.resolve(srcDir, p)))
const FORBIDDEN_DIRS = ['runtime', 'studio', 'portal', 'controls', 'platform', 'components', 'chat'].map((d) => path.resolve(srcDir, d) + path.sep)

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'testutil.ts' && e.name !== 'testdata.ts' ? [p] : []
  })
}

interface Imp { spec: string; typeOnly: boolean; line: number }

function importsOf(file: string): Imp[] {
  const text = fs.readFileSync(file, 'utf8')
  const out: Imp[] = []
  const lines = text.split('\n')
  // static imports / re-exports (single or multi-line), and dynamic import()
  const re = /(^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const spec = m[5] ?? m[7] ?? m[8]!
    const typeOnly = !!m[3] || (m[2] === 'import' && /^\{\s*type\s/.test(m[4] ?? '') && !/,\s*(?!type\s)[A-Za-z_$]/.test((m[4] ?? '').replace(/^\{\s*type\s/, '')))
    const line = text.slice(0, m.index).split('\n').length + (m[1] === '\n' || m[6] === '\n' ? 1 : 0)
    out.push({ spec, typeOnly, line: Math.min(line, lines.length) })
  }
  return out
}

describe('src/fx layering', () => {
  const files = sources(fxDir)

  it('finds the engine and translator sources', () => {
    const rel = files.map((f) => path.relative(fxDir, f).split(path.sep).join('/'))
    expect(rel).toContain('index.ts')
    expect(rel).toContain('engine.ts')
    expect(rel).toContain('query/translate.ts')
  })

  it('imports only relative .ts files inside src/fx, plus type-only shared contracts', () => {
    const problems: string[] = []
    for (const f of files) {
      for (const imp of importsOf(f)) {
        const where = `${path.relative(srcDir, f)}:${imp.line} '${imp.spec}'`
        if (!imp.spec.startsWith('.')) { problems.push(`${where}: package or alias import`); continue }
        if (!imp.spec.endsWith('.ts')) { problems.push(`${where}: needs an explicit .ts extension`); continue }
        const target = path.resolve(path.dirname(f), imp.spec)
        if (!fs.existsSync(target)) { problems.push(`${where}: file not found`); continue }
        if (target.startsWith(fxDir + path.sep)) continue
        if (TYPE_ONLY_OUTSIDE.has(target)) {
          if (!imp.typeOnly) problems.push(`${where}: outside src/fx, only 'import type' is allowed`)
          continue
        }
        if (FORBIDDEN_DIRS.some((d) => target.startsWith(d))) problems.push(`${where}: src/fx must not import ${path.relative(srcDir, target)}`)
        else problems.push(`${where}: outside src/fx`)
      }
    }
    expect(problems).toEqual([])
  })

  it('does not use browser globals or React', () => {
    const problems: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const g of ['window.', 'document.', 'localStorage', 'sessionStorage', 'navigator.', 'React.', 'jsx']) {
        if (text.includes(g)) problems.push(`${path.relative(srcDir, f)} uses ${g}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('the shared type files keep their own imports type-only and relative', () => {
    for (const f of TYPE_ONLY_OUTSIDE) {
      for (const imp of importsOf(f)) {
        expect(imp.typeOnly, `${path.relative(srcDir, f)} '${imp.spec}'`).toBe(true)
      }
    }
  })
})
