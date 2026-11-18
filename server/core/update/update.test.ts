/**
 * Package L, release packages and the updater with fake service control:
 *   npx vitest run server/core/update
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractZip, readZip, writeZip, ZipError } from './zip.ts'
import {
  checkSignature, compareVersions, generateReleaseKey, nodeSatisfies, parseSums, publicKeyFromText, signSums, trustedKeyEntry, verifyTree, writeSums,
  SIG_FILE, KEYS_FILE,
} from './release.ts'
import { applyUpdate, packageProblems, preparePackage, readHistory, type UpdateDeps } from './apply.ts'
import { parseEnvFile, type InstallInfo } from './layout.ts'
import type { HealthStatus } from '../../../src/platform/ops.ts'

const tmps: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-upd-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('zip', () => {
  it('round-trips, is deterministic and keeps the executable bit', () => {
    const entries = [{ name: 'a/b.txt', data: Buffer.from('hello '.repeat(100)) }, { name: 'run.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 }, { name: 'empty', data: Buffer.alloc(0) }]
    const z1 = writeZip(entries)
    const z2 = writeZip(entries)
    expect(z1.equals(z2)).toBe(true)
    const back = readZip(z1)
    expect(back.map((e) => [e.name, e.data.toString(), e.mode])).toEqual([['a/b.txt', 'hello '.repeat(100), 0o644], ['run.sh', '#!/bin/sh\necho hi\n', 0o755], ['empty', '', 0o644]])
    const d = tmp()
    extractZip(z1, d)
    expect(fs.statSync(path.join(d, 'run.sh')).mode & 0o111).not.toBe(0)
  })

  it('refuses unsafe names and damaged data', () => {
    expect(() => writeZip([{ name: '../x', data: Buffer.from('') }])).toThrow()
    expect(() => writeZip([{ name: '/etc/passwd', data: Buffer.from('') }])).toThrow()
    expect(() => writeZip([{ name: 'C:/x', data: Buffer.from('') }])).toThrow()
    const z = writeZip([{ name: 'f.txt', data: Buffer.from('abcdefgh'.repeat(10)) }])
    const bad = Buffer.from(z)
    bad[40] ^= 0xff // inside the compressed data
    expect(() => readZip(bad)).toThrow(ZipError)
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(ZipError)
  })

  it('reads a ZIP made by the zip tool', () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'src', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(d, 'src', 'sub', 'x.txt'), 'from zip(1)')
    const zipFile = path.join(d, 'o.zip')
    try {
      execFileSync('zip', ['-qr', zipFile, 'src'], { cwd: d })
    } catch {
      return // no zip tool here
    }
    expect(readZip(fs.readFileSync(zipFile)).map((e) => e.name)).toEqual(['src/sub/x.txt'])
  })
})

describe('versions', () => {
  it('orders semantic versions with pre-releases', () => {
    const sorted = ['1.0.0', '0.5.0', '0.5.0-dev', '0.5.0-dev.2', '0.5.0-dev.10', '0.10.0', '0.5.1', '0.5.0-rc.1'].sort(compareVersions)
    expect(sorted).toEqual(['0.5.0-dev', '0.5.0-dev.2', '0.5.0-dev.10', '0.5.0-rc.1', '0.5.0', '0.5.1', '0.10.0', '1.0.0'])
    expect(compareVersions('v22.18.0', '22.18')).toBe(0)
  })
  it('checks the Node.js range', () => {
    expect(nodeSatisfies('>=22.18', 'v22.18.0')).toBe(true)
    expect(nodeSatisfies('>=22.18', 'v22.17.9')).toBe(false)
    expect(nodeSatisfies('>=22.18', 'v24.22.3')).toBe(true)
    expect(nodeSatisfies('>=22.18', 'v20.19.0')).toBe(false)
  })
  it('parses the service environment file', () => {
    expect(parseEnvFile('\uFEFF# c\nPORT=5174\nexport A="x y"\nB=\'q\'\n bad line\nC=a=b\n')).toEqual({ PORT: '5174', A: 'x y', B: 'q', C: 'a=b' })
  })
})

/** a tiny "release" folder */
function makeRelease(dir: string, o: { version: string; commit?: string; schema?: number; node?: string; extra?: Record<string, string>; keys?: unknown[] }): string {
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ name: 'appbuilder', version: o.version, commit: o.commit ?? `c-${o.version}`, built: '2026-11-18T00:00:00.000Z', schemaVersion: o.schema ?? 7, node: o.node ?? '>=22.18' }))
  fs.writeFileSync(path.join(dir, 'server', 'main.ts'), `console.log(${JSON.stringify(o.version)})\n`)
  fs.writeFileSync(path.join(dir, 'RELEASE-NOTES.md'), `# ${o.version}\n- things\n`)
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify({ keys: o.keys ?? [] }))
  for (const [k, v] of Object.entries(o.extra ?? {})) fs.writeFileSync(path.join(dir, k), v)
  writeSums(dir)
  return dir
}

describe('checksums and signatures', () => {
  it('detects changed, missing and extra files', () => {
    const d = makeRelease(path.join(tmp(), 'r'), { version: '1.0.0' })
    expect(verifyTree(d)).toMatchObject({ ok: true, files: 4 })
    fs.appendFileSync(path.join(d, 'server', 'main.ts'), '// changed\n')
    fs.writeFileSync(path.join(d, 'planted.js'), 'evil()')
    fs.rmSync(path.join(d, 'RELEASE-NOTES.md'))
    expect(verifyTree(d)).toMatchObject({ ok: false, changed: ['server/main.ts'], extra: ['planted.js'], missing: ['RELEASE-NOTES.md'] })
    expect(() => parseSums('zz  file\n')).toThrow()
  })

  it('Ed25519: valid with a trusted key; untrusted, invalid or unsigned otherwise', () => {
    const k = generateReleaseKey('a long test passphrase')
    const other = generateReleaseKey('another long passphrase')
    const trusted = [trustedKeyEntry(publicKeyFromText(k.publicPem), 'test vendor key')]
    const d = makeRelease(path.join(tmp(), 'r'), { version: '1.0.0' })
    expect(checkSignature(d, trusted)).toEqual({ state: 'unsigned' })
    const sums = fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8')
    fs.writeFileSync(path.join(d, SIG_FILE), JSON.stringify(signSums(sums, k.privatePem, 'a long test passphrase')))
    expect(checkSignature(d, trusted)).toEqual({ state: 'valid', keyId: k.id, comment: 'test vendor key' })
    expect(() => signSums(sums, k.privatePem, 'wrong passphrase!')).toThrow()
    // signed by a key the install does not trust
    fs.writeFileSync(path.join(d, SIG_FILE), JSON.stringify(signSums(sums, other.privatePem, 'another long passphrase')))
    expect(checkSignature(d, trusted)).toEqual({ state: 'untrusted', keyId: other.id })
    // the list was changed after signing
    fs.writeFileSync(path.join(d, SIG_FILE), JSON.stringify(signSums(sums, k.privatePem, 'a long test passphrase')))
    fs.appendFileSync(path.join(d, 'SHA256SUMS'), `${'0'.repeat(64)}  added\n`)
    expect(checkSignature(d, trusted)).toMatchObject({ state: 'invalid', keyId: k.id })
    // a key entry whose id does not match its key
    expect(checkSignature(d, [{ ...trusted[0], publicKey: trustedKeyEntry(publicKeyFromText(other.publicPem)).publicKey }])).toMatchObject({ state: 'invalid' })
  })

  it('packageProblems: an install that trusts keys refuses unsigned packages unless allowed', () => {
    const t = tmp()
    const d = makeRelease(path.join(t, 'r'), { version: '1.0.0' })
    const p = preparePackage(d, path.join(t, 'staged'), d)
    expect(packageProblems(p, 0)).toEqual([])
    expect(packageProblems(p, 1)[0]).toMatch(/not signed/)
    expect(packageProblems(p, 1, { allowUnsigned: true })).toEqual([])
  })
})

/* ------------------------------------------------------------------ the updater with fakes */

interface Fake { deps: UpdateDeps; events: string[]; setHealth(fn: () => HealthStatus | 'down'): void; schema: { v: number | null } }

function fakeDeps(o: { node?: string; schema?: number | null } = {}): Fake {
  const events: string[] = []
  let health: () => HealthStatus | 'down' = () => 'ok'
  let running = true
  const schema = { v: o.schema === undefined ? 7 : o.schema }
  return {
    events,
    schema,
    setHealth: (fn) => { health = fn },
    deps: {
      control: {
        stop: async () => { events.push('stop'); running = false },
        start: async () => { events.push('start'); running = true },
        running: async () => running,
      },
      probe: async () => (running ? health() : 'down'),
      readSchema: async () => schema.v,
      findBackup: async () => '/data/backups/appbuilder-install-pre.abbak',
      nodeVersion: async () => o.node ?? 'v24.22.3',
      secure: async (dir) => { events.push(`secure ${path.basename(dir)}`) },
      log: () => {},
      sleep: async () => {},
    },
  }
}

function install(root: string, version = '1.0.0', keys: unknown[] = []): InstallInfo {
  makeRelease(path.join(root, 'app'), { version, keys })
  return { platform: 'linux', root, dataDir: path.join(root, 'data'), workspace: path.join(root, 'data', 'workspace'), serviceName: 'appbuilder', serviceAccount: 'appbuilder', port: 5174, node: '/x/node', https: 'none', envFile: '', installerVersion: version, installedOn: '' }
}

const version = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')).version

describe('applyUpdate', () => {
  it('swaps the app folder, keeps the previous one, writes the history', async () => {
    const t = tmp()
    const info = install(path.join(t, 'root'))
    const pkg = makeRelease(path.join(t, 'pkg', 'appbuilder-1.1.0'), { version: '1.1.0', schema: 8 })
    const zip = path.join(t, 'appbuilder-1.1.0.zip')
    const files: { name: string; data: Buffer }[] = []
    for (const f of ['release.json', 'server/main.ts', 'RELEASE-NOTES.md', KEYS_FILE, 'SHA256SUMS']) files.push({ name: `appbuilder-1.1.0/${f}`, data: fs.readFileSync(path.join(pkg, f)) })
    fs.writeFileSync(zip, writeZip(files))
    const f = fakeDeps()
    let probes = 0
    f.setHealth(() => (version(path.join(info.root, 'app')) === '1.0.0' ? 'ok' : ++probes < 4 ? 'starting' : 'ok'))
    const hist = path.join(t, 'history.json')
    const r = await applyUpdate(info, zip, f.deps, { yes: true }, hist)
    expect(r, (r as { message?: string }).message).toMatchObject({ result: 'updated', from: '1.0.0', to: '1.1.0' })
    expect(version(path.join(info.root, 'app'))).toBe('1.1.0')
    expect(version(path.join(info.root, 'app.previous'))).toBe('1.0.0')
    expect(fs.existsSync(path.join(info.root, 'app.staging'))).toBe(false)
    expect(f.events).toEqual(['stop', 'secure app', 'start'])
    expect(readHistory(hist)[0]).toMatchObject({ from: '1.0.0', to: '1.1.0', result: 'updated', backup: '/data/backups/appbuilder-install-pre.abbak' })
  })

  it('rolls the app folder back when the new release does not become healthy, and offers the database restore', async () => {
    const t = tmp()
    const info = install(path.join(t, 'root'))
    const pkg = makeRelease(path.join(t, 'pkg'), { version: '1.1.0', schema: 8 })
    const f = fakeDeps()
    // the new release migrates the database, then fails its health check; the old one cannot use the database then
    f.setHealth(() => (version(path.join(info.root, 'app')) === '1.1.0' ? (f.schema.v = 8, 'degraded') : f.schema.v === 8 ? 'degraded' : 'ok'))
    const r = await applyUpdate(info, pkg, f.deps, { yes: true, healthTimeoutMs: 0, rollbackTimeoutMs: 0 }, path.join(t, 'h.json'))
    expect(r.result).toBe('rolled-back')
    if (r.result !== 'rolled-back') return
    expect(r.schemaChanged).toBe(true)
    expect(r.backup).toBe('/data/backups/appbuilder-install-pre.abbak')
    expect(r.message).toMatch(/appbuilder restore ".*pre\.abbak" --force/)
    expect(version(path.join(info.root, 'app'))).toBe('1.0.0')
    expect(version(path.join(info.root, 'app.failed'))).toBe('1.1.0')
    expect(f.events).toEqual(['stop', 'secure app', 'start', 'stop', 'start'])
  })

  it('rolls back without a database note when the schema did not change', async () => {
    const t = tmp()
    const info = install(path.join(t, 'root'))
    const pkg = makeRelease(path.join(t, 'pkg'), { version: '1.0.1' })
    const f = fakeDeps()
    f.setHealth(() => (version(path.join(info.root, 'app')) === '1.0.1' ? 'down' : 'ok'))
    const r = await applyUpdate(info, pkg, f.deps, { yes: true, healthTimeoutMs: 0, rollbackTimeoutMs: 0 })
    expect(r).toMatchObject({ result: 'rolled-back', schemaChanged: false, backup: null })
    expect(r.message).toContain('is healthy')
    expect(r.message).not.toContain('restore')
  })

  it('refuses: tampered package, unsigned for a key-trusting install, downgrade, old Node, older schema, unhealthy server, same release', async () => {
    const t = tmp()
    const k = generateReleaseKey('a long test passphrase')
    const trustedKey = trustedKeyEntry(publicKeyFromText(k.publicPem))
    const mk = (name: string, o: Parameters<typeof makeRelease>[1]) => makeRelease(path.join(t, name), o)

    const plain = install(path.join(t, 'plain'))
    const tampered = mk('tampered', { version: '1.1.0' })
    fs.appendFileSync(path.join(tampered, 'server', 'main.ts'), 'evil()\n')
    expect((await applyUpdate(plain, tampered, fakeDeps().deps, { yes: true })).message).toMatch(/does not match its checksum list/)
    expect((await applyUpdate(plain, mk('old', { version: '0.9.0' }), fakeDeps().deps, { yes: true })).message).toMatch(/older than the installed/)
    expect((await applyUpdate(plain, mk('node', { version: '1.2.0', node: '>=26.0' }), fakeDeps().deps, { yes: true })).message).toMatch(/needs Node.js >=26.0/)
    expect((await applyUpdate(plain, mk('schema', { version: '1.3.0', schema: 6 }), fakeDeps().deps, { yes: true })).message).toMatch(/schema version 7/)
    const sick = fakeDeps()
    sick.setHealth(() => 'degraded')
    expect((await applyUpdate(plain, mk('sick', { version: '1.4.0' }), sick.deps, { yes: true })).message).toMatch(/not healthy/)
    expect(sick.events).toEqual([])
    expect(await applyUpdate(plain, path.join(plain.root, 'app'), fakeDeps().deps, { yes: true })).toMatchObject({ result: 'unchanged' })
    expect(version(path.join(plain.root, 'app'))).toBe('1.0.0')

    const signedInstall = install(path.join(t, 'signed'), '1.0.0', [trustedKey])
    const unsigned = mk('unsigned', { version: '1.5.0' })
    expect((await applyUpdate(signedInstall, unsigned, fakeDeps().deps, { yes: true })).message).toMatch(/not signed/)
    // signed with the trusted key: accepted
    fs.writeFileSync(path.join(unsigned, SIG_FILE), JSON.stringify(signSums(fs.readFileSync(path.join(unsigned, 'SHA256SUMS'), 'utf8'), k.privatePem, 'a long test passphrase')))
    expect(await applyUpdate(signedInstall, unsigned, fakeDeps().deps, { yes: true })).toMatchObject({ result: 'updated', to: '1.5.0' })
  })
})
