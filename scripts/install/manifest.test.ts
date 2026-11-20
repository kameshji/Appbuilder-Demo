/**
 * Package L: the installer manifest pins every third-party download (https only, checksum, permissive licence), and the
 * installers take their versions from it rather than hard-coding them.
 *   npx vitest run scripts/install
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain JavaScript module
import { downloadsFor, readManifest } from './prepare-offline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'PostgreSQL', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'])

describe('installer manifest', () => {
  const m: Map<string, string> = readManifest()

  it('every download is https with a well-formed checksum', () => {
    const urls = [...m.keys()].filter((k) => k.endsWith('.url'))
    expect(urls.length).toBeGreaterThanOrEqual(7)
    for (const k of urls) {
      const base = k.slice(0, -4)
      expect(m.get(k), k).toMatch(/^https:\/\//)
      const sha256 = m.get(`${base}.sha256`)
      const sha512 = m.get(`${base}.sha512`)
      expect(!!sha256 || !!sha512, `${base} has a checksum`).toBe(true)
      if (sha256) expect(sha256, base).toMatch(/^[0-9a-f]{64}$/)
      if (sha512) expect(sha512, base).toMatch(/^[0-9a-f]{128}$/)
    }
    for (const k of [...m.keys()].filter((x) => /\.(keyurl|repo)$/.test(x))) expect(m.get(k), k).toMatch(/^https:\/\//)
    for (const k of [...m.keys()].filter((x) => x.endsWith('.fingerprint'))) expect(m.get(k), k).toMatch(/^[0-9A-F]{40}$/)
  })

  it('every component has a version and a permissive licence', () => {
    for (const c of ['node', 'postgres', 'winsw', 'caddy']) {
      expect(m.get(`${c}.version`), c).toMatch(/^\d+\.\d+/)
      expect(PERMISSIVE.has(m.get(`${c}.licence`) ?? ''), `${c}: ${m.get(`${c}.licence`)}`).toBe(true)
      // the version appears in each of its URLs (no URL left on an older version)
      for (const k of [...m.keys()].filter((x) => x.startsWith(`${c}.`) && x.endsWith('.url'))) expect(m.get(k), k).toContain(m.get(`${c}.version`))
    }
  })

  it('lists what each system needs', () => {
    expect(downloadsFor(m, 'windows').map((d: { key: string }) => d.key)).toEqual(['node.win-x64', 'postgres.win-x64', 'winsw.win', 'caddy.win-x64'])
    expect(downloadsFor(m, 'linux', { caddy: false }).map((d: { key: string }) => d.key)).toEqual(['node.linux-x64', 'node.linux-arm64'])
    expect(downloadsFor(m, 'windows').find((d: { key: string }) => d.key === 'caddy.win-x64').algo).toBe('sha512')
  })

  it('the installers read versions from the manifest, not from their own text', () => {
    const sh = fs.readFileSync(path.join(here, 'linux', 'install.sh'), 'utf8')
    const ps = fs.readFileSync(path.join(here, 'windows', 'install.ps1'), 'utf8')
    for (const v of [m.get('node.version'), m.get('caddy.version'), m.get('postgres.version')]) {
      expect(sh).not.toContain(v)
      expect(ps).not.toContain(v)
    }
    expect(sh).not.toMatch(/http:\/\/(?!localhost|127\.0\.0\.1)/)
    expect(ps).not.toMatch(/http:\/\/(?!localhost|127\.0\.0\.1)/)
  })
})
