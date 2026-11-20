// Licence allow-list gate. Run: npm run licences   (node scripts/check-licences.mjs)
// Fails (exit 1) when a PRODUCTION dependency (direct or transitive, read from node_modules) has a licence outside the
// allow-list, when a production dependency is on the deny-list of packages we must not embed in a sold product, or when
// our own source imports from a non-open edition path. Development dependencies are reported only.
// Rules and exceptions process: docs/dev/testing.md. Licence detection is shared with gen-notices.mjs (scripts/lib/licences.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED, classify, collectTree, findException, reliesOnChoice } from './lib/licences.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXCEPTIONS_FILE = join(ROOT, 'scripts', 'licence-exceptions.json')

/** Packages we do not embed in a sold product, whatever their licence field says. [name pattern, one-line reason]. */
export const DENIED_PACKAGES = [
  [/^n8n($|-)/, 'n8n: Sustainable Use License (fair-code), not open source; may not be embedded in a sold product'],
  [/^@n8n\//, 'n8n: Sustainable Use License (fair-code), not open source; may not be embedded in a sold product'],
  [/^nocodb($|-)/, 'NocoDB: AGPL-3.0 core, network copyleft'],
  [/^@directus\//, 'Directus: BUSL-1.1, production use above a revenue threshold needs a commercial licence'],
  [/^directus$/, 'Directus: BUSL-1.1, production use above a revenue threshold needs a commercial licence'],
  [/^handsontable$/, 'Handsontable: proprietary licence, commercial use needs a paid licence'],
  [/^tldraw$/, 'tldraw: custom licence, production use needs a paid licence or the watermark'],
  [/^@tldraw\//, 'tldraw: custom licence, production use needs a paid licence or the watermark'],
  [/^pm2$/, 'pm2: AGPL-3.0, network copyleft'],
  [/^@univerjs-pro\//, 'Univer Pro: commercial edition, not open source'],
]
export const denyReasonForName = (name) => DENIED_PACKAGES.find(([re]) => re.test(name))?.[1] ?? null

/** Import specifiers that point at non-open editions of a library (an /ee/ or /enterprise/ folder, Univer Pro). */
export function forbiddenImportReason(specifier) {
  if (/^@univerjs-pro(\/|$)/.test(specifier)) return '@univerjs-pro is the commercial Univer edition'
  const segments = specifier.split('/')
  if (segments.some((s) => s.toLowerCase() === 'ee')) return 'path contains /ee/ (enterprise edition code, usually not open source)'
  if (segments.some((s) => s.toLowerCase() === 'enterprise')) return 'path contains /enterprise/ (enterprise edition code, usually not open source)'
  return null
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g
export function findForbiddenImports(source) {
  const hits = []
  for (const m of source.matchAll(IMPORT_RE)) {
    const reason = forbiddenImportReason(m[2])
    if (reason) hits.push({ specifier: m[2], reason })
  }
  return hits
}

const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/
const TEST_FILE = /\.test\.[jt]sx?$/
function* sourceFiles(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* sourceFiles(full)
    else if (SOURCE_FILE.test(e.name) && !TEST_FILE.test(e.name)) yield full
  }
}

function loadExceptions() {
  if (!existsSync(EXCEPTIONS_FILE)) return []
  const list = JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')).exceptions ?? []
  const bad = list.filter((e) => !e.name || !e.versions || !e.reason || !e.approvedBy)
  if (bad.length) {
    console.error('scripts/licence-exceptions.json: every entry needs name, versions, reason and approvedBy.')
    process.exit(1)
  }
  return list
}

function main() {
  const exceptions = loadExceptions()
  const prod = collectTree(ROOT, 'prod')
  const dev = collectTree(ROOT, 'dev')
  if (prod.missing.length) {
    console.error('Production dependencies not installed, so the check cannot be complete. Run npm ci first:')
    for (const m of prod.missing) console.error(`  - ${m}`)
    process.exit(1)
  }
  const prodKeys = new Set(prod.packages.map((p) => `${p.name}@${p.version}`))
  const devOnly = dev.packages.filter((p) => !prodKeys.has(`${p.name}@${p.version}`))

  const failures = []
  const notes = []
  const choices = []
  const usedExceptions = new Set()
  for (const p of prod.packages) {
    const id = `${p.name}@${p.version}`
    const nameReason = denyReasonForName(p.name)
    if (nameReason) {
      failures.push(`${id}: on the do-not-embed list. ${nameReason}`)
      continue
    }
    const c = classify(p.license)
    if (c.status === 'allowed') {
      if (reliesOnChoice(c)) choices.push(`${id}: ${c.expression} -> relying on ${c.relied.join(' + ')}`)
      for (const n of c.notes) notes.push(`${id}: ${n}`)
      continue
    }
    const ex = findException(exceptions, p.name, p.version)
    if (ex) {
      usedExceptions.add(ex)
      notes.push(`${id}: licence "${c.expression}" accepted by exception (${ex.reason}; approved by ${ex.approvedBy})`)
      continue
    }
    failures.push(`${id}: licence "${c.expression}" (${c.reason})`)
  }

  const importFailures = []
  for (const top of ['src', 'server', 'scripts']) {
    for (const file of sourceFiles(join(ROOT, top))) {
      for (const hit of findForbiddenImports(readFileSync(file, 'utf8'))) {
        importFailures.push(`${relative(ROOT, file).replace(/\\/g, '/')}: imports "${hit.specifier}" (${hit.reason})`)
      }
    }
  }

  // Development dependencies: report only. AGPL dev tools get a warning (fine as separate, unmodified tools; never bundled).
  const devWarnings = []
  const devOther = []
  for (const p of devOnly) {
    const id = `${p.name}@${p.version}`
    const nameReason = denyReasonForName(p.name)
    const c = classify(p.license)
    if (nameReason) devWarnings.push(`${id}: ${nameReason}`)
    else if (/AGPL/i.test(p.license) && c.status !== 'allowed') devWarnings.push(`${id}: AGPL dev tool. Keep it a separate, unmodified tool; never bundle or import it into the product`)
    else if (c.status !== 'allowed') devOther.push(`${id}: ${c.expression} (${c.reason})`)
  }

  // P2-B: bundled font files (not npm packages) must sit next to an SIL Open Font License 1.1 text. OFL is accepted for
  // fonts only (it allows embedding in documents and bundling with software; the fonts may not be sold on their own)
  const fontDir = join(ROOT, 'server', 'core', 'print', 'fonts')
  if (existsSync(fontDir)) {
    const files = readdirSync(fontDir)
    const ofl = files.filter((f) => /^OFL.*\.txt$/.test(f)).some((f) => /SIL OPEN FONT LICENSE Version 1\.1/i.test(readFileSync(join(fontDir, f), 'utf8')))
    const fonts = files.filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
    if (fonts.length && !ofl) failures.push(`server/core/print/fonts: ${fonts.length} font file(s) without an SIL Open Font License 1.1 text next to them`)
    else if (fonts.length) notes.push(`server/core/print/fonts: ${fonts.length} font files under the SIL Open Font License 1.1 (fonts only; texts bundled)`)
  }

  for (const e of exceptions) if (!usedExceptions.has(e)) notes.push(`exception for ${e.name} ${e.versions} is not used by any production package; remove it`)

  console.log(`Licence check: ${prod.packages.length} production packages (${ALLOWED.length} allowed licences), ${devOnly.length} dev-only packages.`)
  const section = (title, lines) => {
    if (!lines.length) return
    console.log(`\n${title}`)
    for (const l of [...new Set(lines)].sort()) console.log(`  - ${l}`)
  }
  section('Dual-licence choices we rely on:', choices)
  section('Allowed with conditions:', notes)
  section('Dev dependencies, warnings (not failing):', devWarnings)
  section('Dev dependencies, outside the allow-list (report only, not shipped):', devOther)

  const all = [...failures, ...importFailures]
  if (all.length) {
    section('FAIL: production dependencies', failures)
    section('FAIL: forbidden imports in our source', importFailures)
    console.error(`\n${all.length} problem(s). Replace the package, or (after review) add an entry to scripts/licence-exceptions.json. See docs/dev/testing.md.`)
    process.exit(1)
  }
  console.log('\nOK: all production dependencies are on the allow-list.')
}

// Run only when executed directly, so the classifier helpers above can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
