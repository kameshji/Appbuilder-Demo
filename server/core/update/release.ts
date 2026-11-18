/**
 * Release packages (package L): the release metadata (release.json / VERSION), the checksum list (SHA256SUMS), the
 * Ed25519 signature over that list (SHA256SUMS.sig) and the trusted public keys (release-keys.json).
 *
 * Trust model (docs/dev/release-process.md): the vendor's private key never enters the repository. Its public key is
 * listed in scripts/release/release-keys.json and copied into every release at build time. The updater verifies a new
 * release against the keys of the release that is INSTALLED (not the keys inside the new one), so a package can only be
 * replaced by one signed with a key the running install already trusts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const SUMS_FILE = 'SHA256SUMS'
export const SIG_FILE = 'SHA256SUMS.sig'
export const RELEASE_FILE = 'release.json'
export const KEYS_FILE = 'release-keys.json'

/** the folder that holds server/ and dist/ (a release folder, or the repository in development) */
export const appRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export interface ReleaseInfo {
  name: 'appbuilder'
  version: string
  /** git commit the release was built from ("unknown" when not built from git) */
  commit: string
  /** ISO time of the commit (reproducible builds use it as the build date) */
  built: string
  /** the database schema version this release migrates to */
  schemaVersion: number
  /** Node.js versions it runs on, e.g. ">=22.18" */
  node: string
}

export function readReleaseInfo(root = appRoot()): ReleaseInfo | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, RELEASE_FILE), 'utf8')) as ReleaseInfo
    if (r && r.name === 'appbuilder' && typeof r.version === 'string') return r
  } catch { /* not a release folder */ }
  return null
}

/* ------------------------------------------------------------------ versions */

interface SemVer { main: number[]; pre: string[] }
function parseSemver(v: string): SemVer {
  const s = v.trim().replace(/^v/, '').split('+')[0]
  const [mainPart, ...preParts] = s.split('-')
  const main = mainPart.split('.').map((x) => Number.parseInt(x, 10) || 0)
  while (main.length < 3) main.push(0)
  return { main: main.slice(0, 3), pre: preParts.length ? preParts.join('-').split('.') : [] }
}

/** semantic-version order (pre-releases sort before the release): -1, 0, 1 */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a)
  const y = parseSemver(b)
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] < y.main[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return d < 0 ? -1 : 1; continue }
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** ">=22.18" style range (only >= is used) */
export function nodeSatisfies(range: string, nodeVersion = process.version): boolean {
  const m = /^>=\s*([\d.]+)$/.exec(range.trim())
  if (!m) return true
  return compareVersions(nodeVersion, m[1]) >= 0
}

/* ------------------------------------------------------------------ checksums */

export function sha256File(file: string): string {
  const h = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

/** every regular file under dir, relative with forward slashes, sorted by byte order; symbolic links are refused */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in a release: ${r}`)
      if (d.isDirectory()) walk(r)
      else if (d.isFile()) out.push(r)
    }
  }
  walk('')
  return out.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))))
}

export function formatSums(entries: { file: string; sha256: string }[]): string {
  return entries.map((e) => `${e.sha256}  ${e.file}\n`).join('')
}

export function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const r = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''))
    if (!r) throw new Error(`Malformed line in ${SUMS_FILE}: ${line.slice(0, 80)}`)
    if (m.has(r[2])) throw new Error(`Duplicate entry in ${SUMS_FILE}: ${r[2]}`)
    m.set(r[2], r[1])
  }
  return m
}

/** writes SHA256SUMS for every file in dir (except SHA256SUMS and its signature) */
export function writeSums(dir: string): string {
  const files = listFiles(dir).filter((f) => f !== SUMS_FILE && f !== SIG_FILE)
  const text = formatSums(files.map((file) => ({ file, sha256: sha256File(path.join(dir, file)) })))
  fs.writeFileSync(path.join(dir, SUMS_FILE), text)
  return text
}

export interface TreeCheck {
  ok: boolean
  /** listed but not on disk */
  missing: string[]
  /** on disk with another checksum */
  changed: string[]
  /** on disk but not listed */
  extra: string[]
  files: number
}

/** checks a release folder against its SHA256SUMS; ignore: extra files that may exist (e.g. logs a tool wrote) */
export function verifyTree(dir: string, opts: { ignoreExtra?: (rel: string) => boolean } = {}): TreeCheck {
  const sumsPath = path.join(dir, SUMS_FILE)
  if (!fs.existsSync(sumsPath)) return { ok: false, missing: [SUMS_FILE], changed: [], extra: [], files: 0 }
  const sums = parseSums(fs.readFileSync(sumsPath, 'utf8'))
  const missing: string[] = []
  const changed: string[] = []
  for (const [file, hash] of sums) {
    const p = path.join(dir, ...file.split('/'))
    if (!fs.existsSync(p)) missing.push(file)
    else if (sha256File(p) !== hash) changed.push(file)
  }
  const extra = listFiles(dir).filter((f) => f !== SUMS_FILE && f !== SIG_FILE && !sums.has(f) && !(opts.ignoreExtra?.(f) ?? false))
  return { ok: !missing.length && !changed.length && !extra.length, missing, changed, extra, files: sums.size }
}

/* ------------------------------------------------------------------ signatures */

export interface TrustedKey { id: string; publicKey: string; comment?: string }
export interface SignatureFile { alg: 'ed25519'; keyId: string; signature: string }

/** key id: the first 16 hex characters of SHA-256 over the public key (SPKI DER) */
export function keyIdOf(pub: KeyObject): string {
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
}

export function publicKeyFromText(text: string): KeyObject {
  const t = text.trim()
  if (t.startsWith('-----BEGIN')) return createPublicKey(t)
  return createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' })
}

export function trustedKeyEntry(pub: KeyObject, comment?: string): TrustedKey {
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error('Release keys must be Ed25519 keys.')
  return { id: keyIdOf(pub), publicKey: pub.export({ type: 'spki', format: 'der' }).toString('base64'), ...(comment ? { comment } : {}) }
}

export function readTrustedKeys(root = appRoot()): TrustedKey[] {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(root, KEYS_FILE), 'utf8')) as { keys?: TrustedKey[] }
    return Array.isArray(r.keys) ? r.keys.filter((k) => k && typeof k.publicKey === 'string') : []
  } catch {
    return []
  }
}

/** a new vendor key pair: private key as encrypted PKCS#8 PEM (AES-256-CBC with the passphrase), public as SPKI PEM */
export function generateReleaseKey(passphrase: string): { privatePem: string; publicPem: string; id: string } {
  if (passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters for the release key.')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { privatePem: privateKey, publicPem: publicKey, id: keyIdOf(createPublicKey(publicKey)) }
}

export function signSums(sumsText: string, privatePem: string, passphrase?: string): SignatureFile {
  const key = createPrivateKey(passphrase === undefined ? privatePem : { key: privatePem, passphrase })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be an Ed25519 key.')
  const signature = sign(null, Buffer.from(sumsText, 'utf8'), key).toString('base64')
  return { alg: 'ed25519', keyId: keyIdOf(createPublicKey(key)), signature }
}

export type SignatureStatus =
  | { state: 'valid'; keyId: string; comment?: string }
  | { state: 'unsigned' }
  | { state: 'untrusted'; keyId: string }
  | { state: 'invalid'; keyId: string; reason: string }

/** checks SHA256SUMS.sig in dir against the trusted keys (of the INSTALLED release) */
export function checkSignature(dir: string, trusted: TrustedKey[]): SignatureStatus {
  const sigPath = path.join(dir, SIG_FILE)
  if (!fs.existsSync(sigPath)) return { state: 'unsigned' }
  let sig: SignatureFile
  try {
    sig = JSON.parse(fs.readFileSync(sigPath, 'utf8')) as SignatureFile
  } catch {
    return { state: 'invalid', keyId: '?', reason: `${SIG_FILE} is not readable.` }
  }
  const keyId = String(sig.keyId ?? '?')
  const k = trusted.find((t) => t.id === keyId)
  if (!k) return { state: 'untrusted', keyId }
  let pub: KeyObject
  try {
    pub = publicKeyFromText(k.publicKey)
  } catch {
    return { state: 'invalid', keyId, reason: 'The trusted key is malformed.' }
  }
  if (keyIdOf(pub) !== k.id) return { state: 'invalid', keyId, reason: 'The trusted key does not match its id.' }
  const sums = fs.readFileSync(path.join(dir, SUMS_FILE))
  let ok = false
  try {
    ok = sig.alg === 'ed25519' && verify(null, sums, pub, Buffer.from(String(sig.signature ?? ''), 'base64'))
  } catch {
    ok = false
  }
  return ok ? { state: 'valid', keyId, ...(k.comment ? { comment: k.comment } : {}) } : { state: 'invalid', keyId, reason: 'The signature does not match the checksum list (the package was changed or signed with another key).' }
}
