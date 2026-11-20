/**
 * The built-in catalogue: every template is valid, sealed and listed in the manifest (and the manifest is up to date);
 * a changed template is refused; the Ed25519 path (signed by a trusted key, untrusted, tampered); and the release build
 * ships every built-in file (scripts/release/build.mjs takes data files only from literal new URL('./x', import.meta.url)).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign } from 'node:crypto'
import { catalogue, checkEd25519, checkPackage, digestOf, readManifest } from './catalogue.ts'
import { expectedManifest } from './manifest.ts'
import { keyIdOf, trustedKeyEntry } from '../update/release.ts'
import type { TemplatePackage } from '../../../src/templates/format.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('built-in template catalogue', () => {
  it('has one usable template of each P2 kind and the two solution templates, each verified against the manifest', () => {
    const all = catalogue()
    expect(all.map((e) => e.pkg.kind).sort()).toEqual(['app', 'component', 'dataModel', 'screen', 'solution', 'solution', 'solution', 'solution', 'solution'])
    expect(all.filter((e) => e.pkg.kind === 'solution').map((e) => e.pkg.id).sort()).toEqual(['builtin.business-model', 'builtin.crm', 'builtin.erp-lite', 'builtin.manufacturing', 'builtin.visitor-log'])
    for (const e of all) expect(e.integrity, `${e.source}: ${e.note}`).toBe('builtin')
  })
  it('the manifest and the digests are up to date (run node server/core/templates/manifest.ts --write after an edit)', () => {
    const { manifest, stale } = expectedManifest()
    expect(stale).toEqual([])
    expect(readManifest()).toEqual(manifest)
  })
  it('every file in builtin/ is listed, and every listed file is referenced the way the release build ships it', () => {
    const files = fs.readdirSync(path.join(here, 'builtin')).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort()
    expect(readManifest().templates.map((t) => t.file).sort()).toEqual(files)
    const index = fs.readFileSync(path.join(here, 'builtin', 'index.ts'), 'utf8')
    // the same expression scripts/release/build.mjs uses
    const shipped = [...index.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1].replace(/^\.\//, ''))
    expect(shipped.sort()).toEqual([...files, 'manifest.json'].sort())
    const build = fs.readFileSync(path.join(here, '..', '..', '..', 'scripts', 'release', 'build.mjs'), 'utf8')
    expect(build).toContain('new URL\\(\\s*[\'"](\\.[^\'"]+)[\'"]\\s*,\\s*import\\.meta\\.url\\s*\\)')
  })
  it('a template changed after it was sealed is damaged; one that does not match the manifest too', () => {
    const e = catalogue().find((x) => x.pkg.kind === 'component')!
    const changed = JSON.parse(JSON.stringify(e.pkg)) as TemplatePackage
    changed.payload.controls![0].props.X = '=999'
    const r = checkPackage(changed, e.source, { manifest: readManifest(), builtin: true })
    expect(r.integrity).toBe('damaged')
    expect(r.note).toMatch(/changed after it was sealed/)
    // re-sealed by someone else: the digest is right, but the manifest does not list it
    const resealed = { ...changed, signature: { alg: 'sha256' as const, digest: digestOf(changed) } }
    expect(checkPackage(resealed, e.source, { manifest: readManifest(), builtin: true }).note).toMatch(/does not match the built-in manifest/)
    // key order and whitespace do not matter
    const reverse = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v)
    const reordered = reverse(e.pkg) as TemplatePackage
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(e.pkg))
    expect(digestOf(reordered)).toBe(e.digest)
  })
  it('the common business model in the catalogue has the tables and columns of the solution package (no drift)', async () => {
    const { businessModelTables } = await import('../../routes/meta/business-model.ts')
    const pkg = catalogue().find((e) => e.pkg.id === 'builtin.business-model')!.pkg
    const want = businessModelTables().map((t) => ({ name: t.name, display: t.displayName, primary: t.primaryColumn, unique: t.uniqueTogether ?? null, cols: t.columns.filter((c) => !c.system).map((c) => [c.name, c.type, c.lookupTable ?? null, !!c.required, !!c.unique, c.default ?? null, c.choices ?? null, c.prefix ?? null]) }))
    const got = pkg.slots.map((s) => ({ name: s.create!.name, display: s.create!.displayName, primary: s.create!.primaryColumn, unique: s.create!.uniqueTogether ?? null, cols: s.columns.map((c) => [c.id, c.create?.type ?? c.types[0], c.lookupSlot ?? c.lookupSystem ?? null, !!c.create?.required, !!c.create?.unique, c.create?.default ?? null, c.create?.choices ?? null, c.create?.prefix ?? null]) }))
    expect(got).toEqual(want)
  })
  it('a package that is not built in needs an Ed25519 signature by a trusted key', () => {
    const e = catalogue().find((x) => x.pkg.kind === 'screen')!
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const key = trustedKeyEntry(publicKey, 'test')
    const digest = e.digest
    const signed: TemplatePackage = { ...e.pkg, signature: { alg: 'sha256', digest, ed25519: { keyId: keyIdOf(publicKey), signature: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64') } } }
    expect(checkPackage(signed, 'x', { builtin: false, keys: [key] }).integrity).toBe('signed')
    expect(checkPackage(signed, 'x', { builtin: false, keys: [] }).note).toMatch(/does not trust/)
    expect(checkPackage({ ...e.pkg }, 'x', { builtin: false, keys: [key] }).note).toMatch(/not built in and not signed/)
    const other = generateKeyPairSync('ed25519')
    const forged = { ...signed, signature: { ...signed.signature!, ed25519: { keyId: key.id, signature: sign(null, Buffer.from(digest, 'utf8'), other.privateKey).toString('base64') } } }
    expect(checkEd25519(forged, digest, [key]).ok).toBe(false)
  })
})
