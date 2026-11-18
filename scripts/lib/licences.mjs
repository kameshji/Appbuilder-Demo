// Shared licence detection for `npm run notices` (gen-notices.mjs) and `npm run licences` (check-licences.mjs).
// Both scripts import this file, so they cannot disagree about what a package's licence is or whether it is allowed.
// Pure functions plus a node_modules walker; no output, no process.exit.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Licences we ship under without asking. Matching is case-insensitive (SPDX ids are). */
export const ALLOWED = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'PSF-2.0',
  'Zlib',
  'CC-BY-4.0',
  'MPL-2.0',
]
const ALLOWED_BY_UPPER = new Map(ALLOWED.map((id) => [id.toUpperCase(), id]))

/** Allowed, but with a condition that must stay visible in reports. Keyed by canonical id. */
export const NOTES = {
  'MPL-2.0': 'file-level copyleft: do not modify in place',
  'CC-BY-4.0': 'attribution; allowed for data and fonts only, not code',
}

/** Licence families that are always refused, with the reason shown to the developer. First match wins. */
export const DENIED = [
  [/^AGPL/i, 'AGPL: network copyleft, cannot be embedded in a sold product'],
  [/^LGPL/i, 'LGPL: copyleft; only acceptable as one side of a dual licence with an allowed licence'],
  [/^GPL/i, 'GPL: copyleft, cannot be embedded in a sold product'],
  [/^SSPL/i, 'SSPL: not open source, service-source clause'],
  [/^BUSL|^BSL-1/i, 'BUSL: source-available, production use restricted'],
  [/^ELASTIC/i, 'Elastic License: not open source, forbids managed-service use'],
  [/COMMONS[-\s]?CLAUSE/i, 'Commons Clause: forbids selling the software'],
  [/SUSTAINABLE[-\s]?USE/i, 'Sustainable Use License: not open source, internal/non-commercial use only'],
  [/FAIR[-\s]?CODE/i, 'fair-code: not open source, commercial use restricted'],
  [/^UNLICENSED$/i, 'UNLICENSED: no licence granted'],
]

const upper = (t) => (t ?? '').toUpperCase()
const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i
const CODE_FILE = /\.(m?c?js|ts|json|map|d\.ts)$/i
export const isLicenceFileName = (name) => LICENSE_FILE.test(name) && !CODE_FILE.test(name)

/**
 * Turns whatever package.json holds (string, {type}, legacy `licenses` array, nothing) into one expression string.
 * Returns 'UNKNOWN' when there is nothing usable. An array is read as alternatives ("A OR B"), as npm does.
 */
export function licenceOf(pkg) {
  let value = pkg?.license ?? pkg?.licenses
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.type
  if (Array.isArray(value)) {
    value = value
      .map((x) => (typeof x === 'string' ? x : x?.type))
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim())
      .join(' OR ')
  }
  return typeof value === 'string' && value.trim() ? value.trim() : 'UNKNOWN'
}

function parse(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]
  // Each node evaluates to { ok: boolean, relied: string[] } where relied lists the allowed ids the result stands on.
  function parseOr() {
    let value = parseAnd()
    while (upper(peek()) === 'OR') {
      next()
      const right = parseAnd()
      if (value.ok && right.ok) continue // both sides allowed: keep the first listed, it is the one we rely on
      value = value.ok ? value : right.ok ? right : { ok: false, relied: [] }
    }
    return value
  }
  function parseAnd() {
    let value = parseAtom()
    while (upper(peek()) === 'AND') {
      next()
      const right = parseAtom()
      value = { ok: value.ok && right.ok, relied: [...value.relied, ...right.relied] }
    }
    return value
  }
  function parseAtom() {
    const t = next()
    if (t === '(') {
      const value = parseOr()
      return next() === ')' ? value : { ok: false, relied: [] }
    }
    if (t === undefined || t === ')') return { ok: false, relied: [] }
    if (upper(peek()) === 'WITH') {
      // "X WITH exception": judged on X alone (an exception never makes a denied licence allowed).
      next()
      next()
    }
    const id = ALLOWED_BY_UPPER.get(upper(t.replace(/\+$/, '')))
    // A trailing "+" ("or later") on an allowed id is fine; every allowed id we list is not a GPL-style or-later case anyway.
    return id ? { ok: true, relied: [id] } : { ok: false, relied: [] }
  }
  const result = parseOr()
  if (i !== tokens.length) return { ok: false, relied: [] }
  return result
}

function deniedReason(expr) {
  const ids = expr.match(/[^\s()]+/g) ?? []
  for (const id of ids) {
    if (['AND', 'OR', 'WITH'].includes(upper(id))) continue
    for (const [re, why] of DENIED) if (re.test(id)) return why
  }
  for (const [re, why] of DENIED) if (re.test(expr)) return why
  return null
}

/**
 * Classifies a licence value (package.json `license` string, object, array, or a whole package.json fragment's value).
 * Returns { status, expression, relied, notes, reason }:
 *   status 'allowed'  every obligation is on the allow-list; `relied` names the allowed id(s) we rely on
 *   status 'denied'   matches the explicit deny list, or is missing; `reason` says why
 *   status 'unknown'  not on the allow-list and not on the deny list (custom text, "SEE LICENSE IN ...", unlisted SPDX id)
 * "A OR B" is allowed when either side is; "A AND B" needs both; "X WITH exception" is judged on X.
 * A deny-listed family that is the other side of an allowed OR (e.g. "(MIT OR GPL-3.0)") does not fail the package.
 */
export function classify(value) {
  const expression = typeof value === 'string' ? (value.trim() || 'UNKNOWN') : licenceOf({ license: value })
  if (expression === 'UNKNOWN') {
    return { status: 'denied', expression, relied: [], notes: [], reason: 'no licence declared' }
  }
  const { ok, relied } = parse(expression)
  if (ok) {
    const unique = [...new Set(relied)].sort()
    return { status: 'allowed', expression, relied: unique, notes: unique.filter((id) => NOTES[id]).map((id) => `${id}: ${NOTES[id]}`), reason: null }
  }
  const why = deniedReason(expression)
  if (why) return { status: 'denied', expression, relied: [], notes: [], reason: why }
  const reason = /^SEE\s+LICEN[CS]E\s+IN\b/i.test(expression)
    ? 'licence given only as a file reference; read it and add a reviewed exception or replace the package'
    : 'not on the allow-list'
  return { status: 'unknown', expression, relied: [], notes: [], reason }
}

/** True when the allowed result relies on only part of the expression (a dual licence), i.e. a choice was made. */
export const reliesOnChoice = (c) => c.status === 'allowed' && /\bOR\b/i.test(c.expression) && c.relied.length > 0

// ---- Version ranges (just enough for the exceptions file: *, exact, x-ranges, ^, ~, comparator sets, "||") ----
const parseV = (v) => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/i.exec(String(v).trim())
  if (!m) return null
  const part = (s) => (s === undefined || /^[x*]$/i.test(s) ? null : Number(s))
  return [Number(m[1]), part(m[2]), part(m[3])]
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function comparatorMatches(version, c) {
  c = c.trim()
  if (c === '' || c === '*' || c === 'x') return true
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(c)
  if (!m) return false
  const op = m[1] ?? '='
  const p = parseV(m[2])
  if (!p) return false
  const v = version
  const lo = [p[0], p[1] ?? 0, p[2] ?? 0]
  switch (op) {
    case '>=': return cmp(v, lo) >= 0
    case '>': return p[2] === null ? cmp(v, [p[0], (p[1] ?? 0) + 1, 0]) >= 0 : cmp(v, lo) > 0
    case '<': return cmp(v, lo) < 0
    case '<=': return p[2] === null ? cmp(v, [p[0], (p[1] ?? -1) + 1, 0]) < 0 : cmp(v, lo) <= 0
    case '^': {
      const hi = p[0] > 0 ? [p[0] + 1, 0, 0] : p[1] > 0 ? [0, p[1] + 1, 0] : [0, 0, (p[2] ?? 0) + 1]
      return cmp(v, lo) >= 0 && cmp(v, hi) < 0
    }
    case '~': return cmp(v, lo) >= 0 && cmp(v, p[1] === null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]) < 0
    default: // exact or x-range
      return v[0] === p[0] && (p[1] === null || v[1] === p[1]) && (p[2] === null || v[2] === p[2])
  }
}

/** Does `version` (e.g. "1.2.3") satisfy `range`? Supports "*", "1.2.3", "1.x", "^1.2.0", "~1.2.0", ">=1 <2", "a || b". */
export function versionInRange(version, range) {
  const v = parseV(version)
  if (!v || typeof range !== 'string') return false
  const vv = [v[0], v[1] ?? 0, v[2] ?? 0]
  return range.split('||').some((alt) => {
    const parts = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').trim().split(/\s+/)
    return parts.every((c) => comparatorMatches(vv, c))
  })
}

/** Finds a reviewed exception for name@version, or undefined. */
export function findException(exceptions, name, version) {
  return (exceptions ?? []).find((e) => e.name === name && versionInRange(version, e.versions))
}

// ---- Dependency tree ----
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** Node module resolution: <dir>/node_modules/<name>, then each parent directory in turn. */
export function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Walks the installed tree from the root package.json. `scope` 'prod' starts at `dependencies`; 'dev' starts at
 * `devDependencies`. Each package's `dependencies` and `optionalDependencies` (when installed) are followed.
 * Deduplicated by name@version. Returns { packages: [{ name, version, license, dir }], missing: string[] }.
 */
export function collectTree(root, scope = 'prod') {
  const rootPkg = readJson(join(root, 'package.json'))
  const packages = new Map()
  const missing = []
  const queue = []
  const enqueue = (deps, fromDir, optional) => {
    for (const name of Object.keys(deps ?? {})) queue.push({ name, fromDir, optional })
  }
  enqueue(scope === 'dev' ? rootPkg.devDependencies : rootPkg.dependencies, root, false)
  for (let q = 0; q < queue.length; q++) {
    const { name, fromDir, optional } = queue[q]
    const dir = resolvePackageDir(name, fromDir)
    if (!dir) {
      if (!optional) missing.push(`${name} (required from ${fromDir === root ? 'the project' : fromDir.slice(root.length + 1)})`)
      continue
    }
    const pkg = readJson(join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (packages.has(key)) continue
    packages.set(key, { name: pkg.name, version: pkg.version, license: licenceOf(pkg), dir })
    enqueue(pkg.dependencies, dir, false)
    enqueue(pkg.optionalDependencies, dir, true)
  }
  return { packages: [...packages.values()], missing }
}
