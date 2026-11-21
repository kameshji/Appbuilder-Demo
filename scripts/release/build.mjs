#!/usr/bin/env node
/**
 * `npm run release` (package L): builds the versioned, self-contained release folder and ZIP.
 *
 *   node scripts/release/build.mjs [--skip-build] [--version <v>] [--out <dir>] [--trust-key <public.pem>]... [--no-zip]
 *
 * Output: <out>/appbuilder-<version>/ and <out>/appbuilder-<version>.zip (+ .zip.sha256), default out = release/.
 *
 * Contents (nothing else): dist/ (the web app), the server sources the server actually imports (server/** and the
 * shared src/ modules, found by following the imports from server/main.ts; tests and test helpers excluded), the
 * production node_modules of the server's own dependencies (npm ci --omit=dev from package-lock.json, then pruned to
 * those packages), package.json + package-lock.json, scripts/install/** and scripts/setup-postgres.*, the notices and a
 * licence list, release.json + VERSION, release-keys.json (the vendor's public keys, plus --trust-key), RELEASE-NOTES.md
 * (from CHANGELOG.md) and SHA256SUMS over every file.
 *
 * Not compiled: the release runs the same TypeScript files the tests run, through Node's type stripping (Node 22.18+),
 * so there is no second build of the server to prove equivalent.
 *
 * Reproducible: file order, modes and timestamps are fixed (timestamps = the commit time, SOURCE_DATE_EPOCH), the ZIP
 * writer is deterministic; the same commit and lock file give the same SHA256SUMS and, normally, the same ZIP bytes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Windows: Node refuses to spawn .cmd files without a shell (EINVAL). All arguments here are fixed literals.
const WIN = process.platform === 'win32'
import { fileURLToPath } from 'node:url'
import { listFiles, sha256File, writeSums } from '../../server/core/update/release.ts'
import { isExec, zipRelease } from './lib.mjs'
import { SCHEMA_VERSION } from '../../server/core/meta-store.ts'
import { publicKeyFromText, trustedKeyEntry } from '../../server/core/update/release.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const say = (s) => process.stdout.write(s + '\n')
const die = (s) => { process.stderr.write(`ERROR: ${s}\n`); process.exit(1) }

/* ------------------------------------------------------------------ options */
const argv = process.argv.slice(2)
const opt = { skipBuild: false, version: null, out: path.join(root, 'release'), trustKeys: [], zip: true }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--skip-build') opt.skipBuild = true
  else if (a === '--no-zip') opt.zip = false
  else if (a === '--version') opt.version = argv[++i]
  else if (a === '--out') opt.out = path.resolve(argv[++i])
  else if (a === '--trust-key') opt.trustKeys.push(path.resolve(argv[++i]))
  else if (a === '-h' || a === '--help') { say(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 22).join('\n')); process.exit(0) }
  else die(`unknown option ${a}`)
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = opt.version ?? pkg.version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`not a semantic version: ${version}`)
let commit = git('rev-parse', 'HEAD') || 'unknown'
const dirty = commit !== 'unknown' && git('status', '--porcelain', '--untracked-files=no') !== ''
if (dirty) commit += '-dirty'
const commitTime = git('log', '-1', '--format=%cI') || new Date().toISOString()
const epoch = Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.parse(commitTime) / 1000)
const built = new Date(epoch * 1000).toISOString()
const name = `appbuilder-${version}`
const stage = path.join(opt.out, name)
say(`Building ${name} from ${commit.slice(0, 12)}${dirty ? ' (uncommitted changes: not reproducible from the commit)' : ''}, date ${built}`)

/* ------------------------------------------------------------------ 1. web app */
if (!opt.skipBuild) {
  say('[1/7] npm run build (typecheck + web app) ...')
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: WIN })
} else say('[1/7] using the existing dist/ (--skip-build)')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) die('dist/index.html is missing: run npm run build first')

/* ------------------------------------------------------------------ 2. server files by import closure */
say('[2/7] following the server imports ...')
const IMPORT_RE = /^\s*(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|(?:^|[^\w$.'"/])import\(\s*['"]([^'"]+)['"]\s*\)/gm
const isTest = (f) => /\.(test|spec)\.[cm]?[tj]s$/.test(f) || /(^|\/)(testdb|kernel-testkit)\.ts$/.test(f)
const files = new Set()
const externals = new Set()
// the licence service is a second entry point: the fleet tool runs it from the release folder (scripts/fleet/lib/licence.ts)
const queue = ['server/main.ts', 'server/licence-service/main.ts']
while (queue.length) {
  const rel = queue.shift()
  if (files.has(rel)) continue
  if (isTest(rel)) die(`the server imports a test file: ${rel}`)
  files.add(rel)
  // comments out (a "//" inside a string on an import line is not expected); type-only imports are erased by Node
  const text = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
  // a dynamic import with a computed path cannot be followed: refuse rather than ship an incomplete server
  if (/import\(\s*[^'"\s)]/.test(text)) die(`${rel} has a dynamic import with a computed path`)
  for (const m of text.matchAll(IMPORT_RE)) {
    if (/^\W?(import|export)\s+type\s/.test(m[0].trimStart()) || /^(import|export)\s+type\s/.test(m[0].trim())) continue
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec || spec.startsWith('node:')) continue
    if (spec.startsWith('@/')) die(`${rel} imports ${spec}: the "@/" alias exists only in the browser build`)
    if (spec.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      if (!fs.existsSync(path.join(root, target))) die(`${rel} imports ${spec}, which does not exist`)
      queue.push(target)
    } else {
      externals.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
}
// data files the server reads next to its modules (new URL('./x', import.meta.url))
for (const f of [...files]) {
  const text = fs.readFileSync(path.join(root, f), 'utf8')
  for (const m of text.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
    if (target === 'package.json' || target.startsWith('..')) continue
    if (fs.existsSync(path.join(root, target)) && fs.statSync(path.join(root, target)).isFile()) files.add(target)
  }
}
const deps = pkg.dependencies ?? {}
for (const e of externals) if (!deps[e]) die(`the server imports ${e}, which is not a production dependency in package.json`)
say(`      ${files.size} source files (${[...files].filter((f) => f.startsWith('src/')).length} shared from src/), packages: ${[...externals].sort().join(', ')}`)

/* ------------------------------------------------------------------ 3. stage */
say(`[3/7] staging ${path.relative(root, stage) || stage} ...`)
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
const copy = (rel, to = rel) => {
  const dst = path.join(stage, to)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(path.join(root, rel), dst)
}
for (const f of [...files].sort()) copy(f)
for (const f of listFiles(path.join(root, 'dist'))) copy(`dist/${f}`)
copy('scripts/setup-postgres.sh')
copy('scripts/setup-postgres.ps1')
for (const f of listFiles(path.join(root, 'scripts', 'install'))) {
  if (/(^|\/)(tests?|__tests__)\//.test(f) || /\.tests?\.(ps1|sh)$/.test(f)) continue
  copy(`scripts/install/${f}`)
}
// the fleet tool (hosting many organisations on one server): everything but its tests and CI helpers
if (fs.existsSync(path.join(root, 'scripts', 'fleet'))) {
  for (const f of listFiles(path.join(root, 'scripts', 'fleet'))) {
    if (/(^|\/)(tests?|testing|ci|__tests__)\//.test(f) || /\.test\.(ts|mjs)$/.test(f)) continue
    copy(`scripts/fleet/${f}`)
  }
}
copy('THIRD-PARTY-NOTICES.md')
if (fs.existsSync(path.join(root, 'LICENSE'))) copy('LICENSE')
copy('SECURITY.md')

/* ------------------------------------------------------------------ 4. production node_modules */
say('[4/7] npm ci --omit=dev, pruned to the server packages ...')
copy('package.json')
copy('package-lock.json')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmEnv = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage, stdio: 'inherit', env: npmEnv, shell: WIN })
const relPkg = {
  name: 'appbuilder', version, private: true, type: 'module',
  description: 'Appbuilder server release',
  scripts: { start: 'node server/main.ts' },
  engines: pkg.engines,
  dependencies: Object.fromEntries([...externals].sort().map((e) => [e, deps[e]])),
  overrides: pkg.overrides,
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(relPkg, null, 2) + '\n')
execFileSync(npm, ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage, stdio: 'inherit', env: npmEnv, shell: WIN })
fs.rmSync(path.join(stage, 'node_modules', '.bin'), { recursive: true, force: true })
// packages' own licence list
const licences = []
const walkPkgs = (dir) => {
  if (!fs.existsSync(dir)) return
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const p = path.join(dir, d.name)
    if (d.name.startsWith('@')) { walkPkgs(p); continue }
    const pj = path.join(p, 'package.json')
    if (fs.existsSync(pj)) {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
      const lic = typeof j.license === 'string' ? j.license : j.license?.type ?? (Array.isArray(j.licenses) ? j.licenses.map((l) => l.type ?? l).join(' OR ') : 'UNKNOWN')
      licences.push(`${j.name}@${j.version}\t${lic}\t${path.relative(stage, p).split(path.sep).join('/')}`)
    }
    walkPkgs(path.join(p, 'node_modules'))
  }
}
walkPkgs(path.join(stage, 'node_modules'))
licences.sort()
fs.mkdirSync(path.join(stage, 'licenses'), { recursive: true })
fs.writeFileSync(path.join(stage, 'licenses', 'node_modules.tsv'), 'package\tlicence\tfolder (its LICENSE file is there)\n' + licences.join('\n') + '\n')
// every external the server imports must resolve from the release
for (const e of externals) if (!fs.existsSync(path.join(stage, 'node_modules', e, 'package.json'))) die(`${e} is missing from the release node_modules`)
say(`      ${licences.length} packages`)

/* ------------------------------------------------------------------ 5. metadata */
say('[5/7] release.json, VERSION, keys, release notes ...')
const info = { name: 'appbuilder', version, commit, built, schemaVersion: SCHEMA_VERSION, node: pkg.engines?.node ?? '>=22.18' }
fs.writeFileSync(path.join(stage, 'release.json'), JSON.stringify(info, null, 2) + '\n')
fs.writeFileSync(path.join(stage, 'VERSION'), `version=${version}\ncommit=${commit}\nbuilt=${built}\nschema=${SCHEMA_VERSION}\nnode=${info.node}\n`)
const keysFile = path.join(root, 'scripts', 'release', 'release-keys.json')
const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')).keys ?? [] : []
for (const f of opt.trustKeys) {
  const k = trustedKeyEntry(publicKeyFromText(fs.readFileSync(f, 'utf8')), `added at build: ${path.basename(f)}`)
  if (!keys.some((x) => x.id === k.id)) keys.push(k)
}
fs.writeFileSync(path.join(stage, 'release-keys.json'), JSON.stringify({ keys }, null, 2) + '\n')
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const sections = changelog.split(/^## /m).slice(1)
const section = sections.find((s) => s.startsWith(`[${version}]`) || s.startsWith(`${version}`)) ?? sections.find((s) => /^\[?Unreleased/i.test(s)) ?? ''
fs.writeFileSync(path.join(stage, 'RELEASE-NOTES.md'), `# Appbuilder ${version}\n\nCommit ${commit}, built ${built}.\n\n## ${section.trim()}\n`)
fs.writeFileSync(path.join(stage, 'README.txt'), [
  `Appbuilder ${version}`,
  '',
  'Install on Windows (elevated PowerShell):   .\\scripts\\install\\windows\\install.ps1',
  'Install on Linux (root):                     sudo bash scripts/install/linux/install.sh',
  'Update an existing install:                  appbuilder update <this zip>',
  '',
  'Documentation: docs/admin/installation.md in the source repository.',
  'Check this package: every file is listed with its SHA-256 in SHA256SUMS; SHA256SUMS.sig (when present) is the',
  "vendor's Ed25519 signature over that list.",
  '',
].join('\n'))

/* ------------------------------------------------------------------ 6. normalise and checksum */
say('[6/7] normalising timestamps and modes, writing SHA256SUMS ...')
const all = listFiles(stage)
for (const f of all) {
  const p = path.join(stage, f)
  fs.chmodSync(p, isExec(f) ? 0o755 : 0o644)
  fs.utimesSync(p, epoch, epoch)
}
writeSums(stage)
fs.utimesSync(path.join(stage, 'SHA256SUMS'), epoch, epoch)

/* ------------------------------------------------------------------ 7. zip */
let zipFile = null
if (opt.zip) {
  say('[7/7] writing the ZIP ...')
  zipFile = zipRelease(stage)
}

let bytes = 0
for (const f of listFiles(stage)) bytes += fs.statSync(path.join(stage, f)).size
say('')
say(`Release ${name}: ${listFiles(stage).length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB unpacked`)
say(`  folder  ${stage}`)
say(`  SHA256SUMS ${sha256File(path.join(stage, 'SHA256SUMS'))}`)
if (zipFile) say(`  zip     ${zipFile} (${(fs.statSync(zipFile).size / 1024 / 1024).toFixed(1)} MB) sha256 ${sha256File(zipFile)}`)
say('  unsigned: sign it with  npm run release:sign -- ' + path.relative(process.cwd(), stage))
