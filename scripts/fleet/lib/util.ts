/**
 * Small pure helpers of the fleet tool (scripts/fleet; docs/admin/fleet-operations.md): ids, passwords, SCRAM verifiers,
 * argument parsing, redaction, the env-file format. No system effects here (lib/system.ts holds those).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** n random base32 characters (lowercase) */
export function b32(n: number, rnd: (n: number) => Buffer = randomBytes): string {
  return [...rnd(n)].map((x) => B32[x & 31]).join('')
}

/** an organisation's opaque id: "o" + 8 base32 characters (spec section 1; never the organisation's name) */
export function newOrgId(rnd?: (n: number) => Buffer): string {
  return `o${b32(8, rnd)}`
}

export const ORG_ID = /^o[a-z2-7]{8}$/

/** host name labels the fleet itself uses or that look official: never given to an organisation */
export const RESERVED_SLUGS = new Set(['licence', 'license', 'www', 'admin', 'api', 'mail', 'smtp', 'imap', 'status', 'ops', 'operator', 'fleet', 'caddy', 'postgres', 'root', 'support', 'billing', 'app', 'apps', 'static', 'cdn', 'test', 'localhost'])

/** the host name label of an organisation: a-z 0-9 and inner hyphens, 2 to 32 characters */
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/.test(slug)) return 'The name must be 2 to 32 characters: lowercase letters, digits and inner hyphens (it becomes <name>.<domain>).'
  if (slug.includes('--')) return 'The name must not contain two hyphens in a row.'
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved for the fleet itself.`
  return null
}

/** a random password of base64url characters (no quoting problems anywhere) */
export function newPassword(bytes = 30): string {
  return randomBytes(bytes).toString('base64url')
}

/** 32 random bytes as 64 hex characters: an install's .secret-key */
export function newSecretKey(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802/7677, as the installers make it), so the plain
 * password never appears in SQL text, in the server log or in pg_stat_statements.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, iterations, 32, 'sha256')
  const hmac = (k: Buffer, s: string) => createHmac('sha256', k).update(s).digest()
  const stored = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`
}

/** a PostgreSQL identifier in double quotes */
export const qi = (s: string): string => `"${s.replace(/"/g, '""')}"`
/** a PostgreSQL string literal */
export const ql = (s: string): string => `'${s.replace(/'/g, "''")}'`

export interface Parsed { args: string[]; o: Record<string, string | true> }

/** --flag value / --flag (for names in `bool`) / --flag=value; everything else is a positional argument */
export function parseArgs(argv: string[], bool: readonly string[]): Parsed {
  const o: Record<string, string | true> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { args.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) o[k] = a.slice(eq + 1)
      else if (bool.includes(k)) o[k] = true
      else {
        const v = argv[i + 1]
        if (v === undefined || v.startsWith('--')) o[k] = true
        else { o[k] = v; i++ }
      }
    } else args.push(a)
  }
  return { args, o }
}

export const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

/** flags whose values never reach the audit log or the screen */
const SECRET_FLAGS = /pass(word|phrase)?|secret|token|key$/i

/** argv as it may be written to the operator audit (values of secret-looking flags and URL passwords replaced) */
export function redactArgv(argv: string[]): string[] {
  return redactFlags(argv).map((a) => a.replace(/\/\/([^:@/\s]+):[^@/\s]+@/g, '//$1:***@'))
}

function redactFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--([^=]+)(=.*)?$/.exec(a)
    if (m && SECRET_FLAGS.test(m[1]) && !/-file$/.test(m[1])) {
      if (m[2]) out.push(`--${m[1]}=***`)
      else { out.push(a); if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { out.push('***'); i++ } }
    } else out.push(a)
  }
  return out
}

/** removes every given secret from a text (command output shown to a person or written to a log) */
export function scrub(text: string, secrets: readonly (string | null | undefined)[]): string {
  let t = text
  for (const s of secrets) if (s && s.length >= 6) t = t.split(s).join('***')
  // invitation and reset links carry one-time tokens
  return t.replace(/#(invite|reset)=[A-Za-z0-9_%.-]+/g, '#$1=***').replace(/\babl_[A-Za-z0-9_-]{10,}/g, 'abl_***')
}

/** KEY=value lines; values are written as they are (the server's parser takes the rest of the line) */
export function envFileText(header: string[], vars: Record<string, string | undefined>): string {
  const lines = header.map((h) => `# ${h}`)
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be one line`)
    lines.push(`${k}=${v}`)
  }
  return lines.join('\n') + '\n'
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    let v = line.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

/** "1.5G", "1536M", "512K", "2048" (bytes) -> bytes; null when not a size */
export function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(s.trim())
  if (!m) return null
  const mul = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T']
  return Math.round(Number(m[1]) * mul)
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

export const iso = (ms: number): string => new Date(ms).toISOString()

/** a fixed-width text table */
export function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(w[i])).join('  ').trimEnd()
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n')
}

/** AES-256-GCM of a small file (the PostgreSQL globals dump): "ABFLEET1" | iv 12 | tag 16 | ciphertext */
export function sealBlob(masterKeyHex: string, purpose: string, plain: Buffer): Buffer {
  const key = createHmac('sha256', Buffer.from(masterKeyHex, 'hex')).update(`appbuilder-fleet-seal:${purpose}`).digest()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([Buffer.from('ABFLEET1'), iv, c.getAuthTag(), body])
}

export function openBlob(masterKeyHex: string, purpose: string, sealed: Buffer): Buffer {
  if (sealed.subarray(0, 8).toString() !== 'ABFLEET1') throw new Error('not a sealed fleet file')
  const key = createHmac('sha256', Buffer.from(masterKeyHex, 'hex')).update(`appbuilder-fleet-seal:${purpose}`).digest()
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(8, 20))
  d.setAuthTag(sealed.subarray(20, 36))
  return Buffer.concat([d.update(sealed.subarray(36)), d.final()])
}

/** a per-organisation passphrase for its fleet backups: HMAC of the fleet's backup master key and the org id */
export function orgPassphrase(masterKeyHex: string, orgId: string): string {
  return createHmac('sha256', Buffer.from(masterKeyHex, 'hex')).update(`appbuilder-fleet-backup:${orgId}`).digest('base64url')
}
