// Writes THIRD-PARTY-NOTICES.md from the production dependency tree in node_modules.
// Run: npm run notices   (node scripts/gen-notices.mjs). Only reads files; needs node_modules to be installed.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')
const ACCEPTED = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'PSF-2.0', 'Zlib']
const ACCEPTED_SET = new Set(ACCEPTED)
const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i
const CODE_FILE = /\.(m?c?js|ts|json|map|d\.ts)$/i

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const upper = (t) => (t ?? '').toUpperCase()
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Node module resolution: <dir>/node_modules/<name>, then each parent directory in turn.
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function licenseOf(pkg) {
  let license = pkg.license ?? pkg.licenses
  if (license && typeof license === 'object' && !Array.isArray(license)) license = license.type
  if (Array.isArray(license)) {
    license = license.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ')
  }
  return typeof license === 'string' && license.trim() ? license.trim() : 'UNKNOWN'
}

// Checks an SPDX-style expression. "A OR B" passes if either side is accepted, "A AND B" needs both,
// and "X WITH exception" is judged on X. Anything unparseable or unknown does not pass.
function isAccepted(expr) {
  if (expr === 'UNKNOWN') return false
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]
  function parseOr() {
    let value = parseAnd()
    while (upper(peek()) === 'OR') {
      next()
      const right = parseAnd()
      value = value || right
    }
    return value
  }
  function parseAnd() {
    let value = parseAtom()
    while (upper(peek()) === 'AND') {
      next()
      const right = parseAtom()
      value = value && right
    }
    return value
  }
  function parseAtom() {
    const t = next()
    if (t === '(') {
      const value = parseOr()
      return next() === ')' && value
    }
    if (t === undefined || t === ')') return false
    if (upper(peek()) === 'WITH') {
      next()
      next()
    }
    return ACCEPTED_SET.has(t)
  }
  const result = parseOr()
  return Boolean(result) && i === tokens.length
}

function licenseFilesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name) && !CODE_FILE.test(e.name))
    .map((e) => e.name)
    .sort(byText)
}

// Walks the production tree: root dependencies, then each package's dependencies (and optionalDependencies
// when installed), deduplicated by name@version.
function collectTree() {
  const rootPkg = readJson(join(ROOT, 'package.json'))
  const packages = new Map()
  const missing = []
  const queue = []
  const enqueue = (deps, fromDir, optional) => {
    for (const name of Object.keys(deps ?? {})) queue.push({ name, fromDir, optional })
  }
  enqueue(rootPkg.dependencies, ROOT, false)
  for (let q = 0; q < queue.length; q++) {
    const { name, fromDir, optional } = queue[q]
    const dir = resolvePackageDir(name, fromDir)
    if (!dir) {
      if (!optional) missing.push(`${name} (required from ${fromDir === ROOT ? 'the project' : fromDir.slice(ROOT.length + 1)})`)
      continue
    }
    const pkg = readJson(join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (packages.has(key)) continue
    packages.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), dir })
    enqueue(pkg.dependencies, dir, false)
    enqueue(pkg.optionalDependencies, dir, true)
  }
  return { packages: [...packages.values()], missing }
}

function fenceFor(text) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|')
}

const { packages, missing } = collectTree()

if (missing.length > 0) {
  console.error('Not installed, so the notices cannot be complete. Run npm ci or npm install first:')
  for (const m of missing) console.error(`  - ${m}`)
  process.exitCode = 1
} else {
  const entries = packages
    .map((p) => ({ ...p, accepted: isAccepted(p.license), files: licenseFilesIn(p.dir) }))
    .sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version))

  // Accepted, but only because one option of an OR is on the list: still listed, so the choice is visible.
  const usesOtherOption = (expr) =>
    (expr.match(/[^\s()]+/g) ?? []).some((t) => !['AND', 'OR', 'WITH'].includes(upper(t)) && !ACCEPTED_SET.has(t))
  for (const e of entries) e.needsReview = !e.accepted || (usesOtherOption(e.license) && e.license !== 'UNKNOWN')
  const review = entries.filter((e) => e.needsReview)
  const out = []
  out.push('# Third-party notices', '')
  out.push(
    'Appbuilder includes the open-source packages listed below. Each one is covered by its own license. Where a package ' +
      'ships its license file, the full text is reproduced here. This file is generated by `npm run notices` from the ' +
      'production dependencies in `node_modules`; do not edit it by hand.',
    '',
    `Production packages: ${entries.length} (unique name@version, from the \`dependencies\` tree; development tools are not included).`,
    '',
  )

  out.push('## Needs review', '')
  if (review.length === 0) {
    out.push(`None. Every package uses one of the accepted licenses: ${ACCEPTED.join(', ')}.`, '')
  } else {
    out.push(
      `These packages use a license that is not on the accepted list (${ACCEPTED.join(', ')}). Check each one before release.`,
      '',
    )
    for (const e of review) {
      out.push(`- ${e.name}@${e.version}: ${e.license}${e.accepted ? ' (accepted here only through the option on the list)' : ''}`)
    }
    out.push('')
  }

  out.push('## Summary', '', '| Package | Version | License |', '| --- | --- | --- |')
  for (const e of entries) out.push(`| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.license)} |`)
  out.push('')

  out.push('## License texts', '')
  for (const e of entries) {
    out.push(`### ${e.name}@${e.version}`, '')
    if (e.files.length === 0) {
      out.push(`License text not found in the package; license field: ${e.license}`, '')
      continue
    }
    for (const file of e.files) {
      const text = readFileSync(join(e.dir, file), 'utf8').replace(/\r\n?/g, '\n').trimEnd()
      const fence = fenceFor(text)
      out.push(`File: ${file}`, '', `${fence}text`, text, fence, '')
    }
  }

  writeFileSync(OUT, out.join('\n') + '\n')
  console.log(`${entries.length} production packages, ${review.length} need review. Wrote ${OUT}`)
}
