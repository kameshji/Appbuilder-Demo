/**
 * The template catalogue (docs/dev/templates.md "Integrity"): the built-in templates shipped with the install, each
 * checked when loaded.
 *
 * Integrity: every package carries `signature.digest` = SHA-256 over its canonical JSON without the signature
 * (format.ts signedContent: key order and whitespace do not matter, so line endings of a checkout do not either). A
 * built-in package is usable only when that digest is right AND equals the digest the built-in manifest
 * (builtin/manifest.json) lists for its file. The manifest is a file of the release, so it is covered by the release's
 * SHA256SUMS, which the vendor signs with the Ed25519 release key (docs/dev/release-process.md). A package that is not
 * built in is usable only with `signature.ed25519` (over the digest) by a key in release-keys.json; nothing loads such
 * packages yet (an online catalogue is later), but the check is here and tested.
 *
 * Every package is also validated (format.ts validateTemplate) and its formulas checked (bind.ts checkTemplateFormulas);
 * a package that fails any of this is listed as damaged and cannot be used.
 */
import fs from 'node:fs'
import { createHash, verify } from 'node:crypto'
import type { TemplatePackage } from '../../../src/templates/format.ts'
import { signedContent, validateTemplate } from '../../../src/templates/format.ts'
import { checkTemplateFormulas } from '../../../src/templates/bind.ts'
import { keyIdOf, publicKeyFromText, readTrustedKeys, type TrustedKey } from '../update/release.ts'
import { compareVersions } from '../update/release.ts'
import { BUILTIN_MANIFEST_URL, BUILTIN_TEMPLATE_FILES } from './builtin/index.ts'

export interface CatalogueEntry {
  /** the built-in file, or "test:<id>" for packages a test registered */
  source: string
  pkg: TemplatePackage
  digest: string
  integrity: 'builtin' | 'signed' | 'damaged'
  note?: string
}

export interface TemplateManifest { format: 'appbuilder/template-manifest'; templates: { file: string; id: string; version: string; sha256: string }[] }

export const digestOf = (pkg: TemplatePackage): string => createHash('sha256').update(signedContent(pkg), 'utf8').digest('hex')

export function readManifest(): TemplateManifest {
  try {
    const m = JSON.parse(fs.readFileSync(BUILTIN_MANIFEST_URL, 'utf8')) as TemplateManifest
    return m && Array.isArray(m.templates) ? m : { format: 'appbuilder/template-manifest', templates: [] }
  } catch {
    return { format: 'appbuilder/template-manifest', templates: [] }
  }
}

/** an Ed25519 signature over the digest by a trusted (release) key */
export function checkEd25519(pkg: TemplatePackage, digest: string, keys: TrustedKey[]): { ok: boolean; note: string } {
  const sig = pkg.signature?.ed25519
  if (!sig) return { ok: false, note: 'The template is not built in and not signed.' }
  const k = keys.find((x) => x.id === sig.keyId)
  if (!k) return { ok: false, note: `The template is signed with a key this install does not trust (${String(sig.keyId).slice(0, 16)}).` }
  try {
    const pub = publicKeyFromText(k.publicKey)
    if (keyIdOf(pub) !== k.id) return { ok: false, note: 'The trusted key does not match its id.' }
    const ok = verify(null, Buffer.from(digest, 'utf8'), pub, Buffer.from(String(sig.signature ?? ''), 'base64'))
    return ok ? { ok: true, note: `Signed with the trusted key ${k.id}.` } : { ok: false, note: 'The signature does not match the template (it was changed after signing).' }
  } catch {
    return { ok: false, note: 'The signature could not be checked.' }
  }
}

/** checks one package: structure, formulas, digest, and the manifest (built in) or the Ed25519 signature */
export function checkPackage(raw: unknown, source: string, o: { manifest?: TemplateManifest; keys?: TrustedKey[]; builtin: boolean }): CatalogueEntry {
  const pkg = raw as TemplatePackage
  const problems = validateTemplate(raw)
  if (problems.length) return { source, pkg, digest: '', integrity: 'damaged', note: `The template is malformed: ${problems.slice(0, 3).join(' ')}` }
  const formulaProblems = checkTemplateFormulas(pkg)
  if (formulaProblems.length) return { source, pkg, digest: '', integrity: 'damaged', note: `The template's formulas are not usable: ${formulaProblems.slice(0, 3).join(' ')}` }
  const digest = digestOf(pkg)
  if (pkg.signature?.alg !== 'sha256' || pkg.signature.digest !== digest) return { source, pkg, digest, integrity: 'damaged', note: 'The template was changed after it was sealed (its digest does not match).' }
  if (o.builtin) {
    const listed = o.manifest?.templates.find((t) => t.file === source)
    if (!listed) return { source, pkg, digest, integrity: 'damaged', note: 'The template is not in the built-in manifest.' }
    if (listed.sha256 !== digest || listed.id !== pkg.id || listed.version !== pkg.version) return { source, pkg, digest, integrity: 'damaged', note: 'The template does not match the built-in manifest (it was changed).' }
    return { source, pkg, digest, integrity: 'builtin', note: 'Built in: checked against the manifest that ships with this release.' }
  }
  const sig = checkEd25519(pkg, digest, o.keys ?? readTrustedKeys())
  return { source, pkg, digest, integrity: sig.ok ? 'signed' : 'damaged', note: sig.note }
}

let cache: CatalogueEntry[] | null = null
const registered: CatalogueEntry[] = []

/** the built-in templates (read once) plus packages tests registered */
export function catalogue(): CatalogueEntry[] {
  if (!cache) {
    const manifest = readManifest()
    cache = BUILTIN_TEMPLATE_FILES.map(({ file, url }) => {
      let raw: unknown
      try {
        raw = JSON.parse(fs.readFileSync(url, 'utf8'))
      } catch (e) {
        return { source: file, pkg: { id: file, name: file, kind: 'component', version: '0.0.0', slots: [], payload: {}, modes: ['copy'], description: '', minPlatformVersion: '0.0.0', format: 'appbuilder/template', formatVersion: 1 } as TemplatePackage, digest: '', integrity: 'damaged' as const, note: `The file could not be read: ${(e as Error).message}` }
      }
      return checkPackage(raw, file, { manifest, builtin: true })
    })
  }
  return [...cache, ...registered]
}

/** the newest usable entry of a template id (or that exact version) */
export function findTemplate(id: string, version?: string): CatalogueEntry | undefined {
  const all = catalogue().filter((e) => e.pkg.id === id && (!version || e.pkg.version === version))
  return all.sort((a, b) => compareVersions(b.pkg.version, a.pkg.version))[0]
}

/**
 * TESTS ONLY: adds packages to the catalogue as if they were built in (a newer version for an upgrade, a package that
 * carries secrets for the safety check). `damaged` lists them as damaged instead. Returns a function that removes them.
 */
export function registerTestTemplates(list: TemplatePackage[], o: { damaged?: boolean } = {}): () => void {
  const entries = list.map((pkg): CatalogueEntry => {
    const source = `test:${pkg.id}@${pkg.version}`
    const sealed = { ...pkg, signature: { alg: 'sha256' as const, digest: digestOf(pkg) } }
    const manifest: TemplateManifest = { format: 'appbuilder/template-manifest', templates: [{ file: source, id: pkg.id, version: pkg.version, sha256: sealed.signature.digest }] }
    const e = checkPackage(sealed, source, { manifest, builtin: true })
    return o.damaged ? { ...e, integrity: 'damaged', note: 'Registered as damaged by a test.' } : e
  })
  registered.push(...entries)
  return () => { for (const e of entries) registered.splice(registered.indexOf(e), 1) }
}

/** drops the cache (a test that rewrote files) */
export function reloadCatalogue(): void {
  cache = null
}
