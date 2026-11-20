/**
 * The licence service against the sandbox PostgreSQL (its own database), in process:
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/licence-service
 * Operator CLI (every command audited), the signed answer, the same answer for unknown and revoked keys, rate limits,
 * duplicate installs, check-ins without personal data, keygen outside the repository. Keys are generated at test time.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../core/testdb.ts'
import { generateLicenceKey, loadSigningKey, newInstallId, newNonce, trustedLicenceKey, verifyAnswer, type LicencePayload } from '../core/licence/answer.ts'
import { runLicenceCli, keygen } from './cli.ts'
import { createHandler, listen, DUPLICATE_GRACE_MS } from './service.ts'
import { openDb } from './store.ts'
import type { PgDb } from '../connectors/postgres/db.ts'

if (!PG_URL) process.stderr.write(`[server/licence-service integration] ${SKIP_PG}\n`)

const PASS = 'test-passphrase-only'
const ONE_INSTALL = newInstallId()

describe.skipIf(!PG_URL)('licence service (H-G, PostgreSQL)', () => {
  let dbName = ''
  let env: NodeJS.ProcessEnv = {}
  let db: PgDb
  let server: http.Server
  let base = ''
  let now = Date.UTC(2026, 10, 21, 9, 0, 0)
  const k = generateLicenceKey(PASS)
  const trusted = [trustedLicenceKey(k.publicPem)]
  const out: string[] = []
  const io = { out: (s: string) => { out.push(s) }, err: (s: string) => { out.push(`ERR ${s}`) } }
  const cli = async (...argv: string[]) => {
    out.length = 0
    const code = await runLicenceCli(argv, env, io)
    return { code, text: out.join('\n') }
  }
  const check = async (licenceId: string, key: string | null, installId = ONE_INSTALL, seats = { full: 2, operator: 3, external: 0 }) => {
    const nonce = newNonce()
    const res = await fetch(`${base}/v1/licence/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ v: 1, licenceId, installId, version: '0.8.0', nonce, seats }),
    })
    const body = await res.json()
    const v = res.status === 200 ? verifyAnswer(body, trusted) : null
    return { status: res.status, body, p: v && v.ok ? v.payload : (null as LicencePayload | null), nonce, installId }
  }
  let licId = ''
  let key = ''

  beforeAll(async () => {
    dbName = testDatabaseName('licsvc')
    await createDatabase(dbName)
    const c = pgServer!
    env = { APPBUILDER_LICENCE_DB_URL: `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${dbName}` }
    expect((await cli('migrate')).code).toBe(0)
    db = openDb(env)
    server = await listen(createHandler({ db, key: loadSigningKey(k.privatePem, PASS), clock: () => now, ratePerMinute: 1000, keyRatePerMinute: 1000 }), { host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const created = await cli('org', 'create', '--name', 'Acme Tools', '--plan', 'pilot', '--full', '5', '--operator', '20', '--paid-until', '2026-12-31')
    expect(created.code, created.text).toBe(0)
    licId = /licence id (lic_[a-z0-9]+)/.exec(created.text)![1]
    const issued = await cli('key', 'issue', licId)
    expect(issued.code, issued.text).toBe(0)
    key = /^(abl_\S+)$/m.exec(issued.text)![1]
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await db?.close()
    if (dbName) await dropDatabase(dbName)
  }, 30_000)

  it('answers a valid key with a signed, short-lived licence answer that echoes the nonce', async () => {
    const r = await check(licId, key)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ alg: 'ed25519', keyId: trusted[0].id })
    expect(r.p).toMatchObject({ licenceId: licId, installId: r.installId, nonce: r.nonce, status: 'active', plan: 'pilot', kind: 'subscription', seats: { full: 5, operator: 20, external: 0 } })
    expect(Date.parse(r.p!.validUntil) - Date.parse(r.p!.issuedAt)).toBe(72 * 3600_000)
    expect(r.p!.paidUntil!.slice(0, 10)).toBe('2026-12-31')
    // the key is never stored, only its hash
    const keys = await pgQuery<{ key_hash: string }>(dbName, `SELECT key_hash FROM lic.install_keys`)
    expect(keys.every((x) => x.key_hash.length === 64 && x.key_hash !== key)).toBe(true)
  })

  it('unknown, revoked, missing and another licence\'s key get the same signed "refused" answer', async () => {
    const issued = await cli('key', 'issue', licId)
    const second = /^(abl_\S+)$/m.exec(issued.text)![1]
    expect((await check(licId, second)).p!.status).toBe('active')
    expect((await cli('key', 'revoke', licId, '--key', /Install key (key_[a-f0-9]+)/.exec(issued.text)![1])).code).toBe(0)
    const other = await cli('org', 'create', '--name', 'Other Co')
    const otherId = /licence id (lic_[a-z0-9]+)/.exec(other.text)![1]
    const shape = (p: LicencePayload | null) => p && { ...p, installId: 'x', nonce: 'x', issuedAt: 'x', validUntil: 'x', serverTime: 'x' }
    const revoked = await check(licId, second)
    const unknown = await check(licId, 'abl_' + 'q'.repeat(43))
    const none = await check(licId, null)
    const wrongOrg = await check(otherId, key)
    expect(revoked.p!.status).toBe('refused')
    for (const r of [unknown, none, wrongOrg]) expect(shape(r.p)).toEqual({ ...shape(revoked.p), licenceId: r.p!.licenceId })
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(revoked.body).sort())
    expect(revoked.p!.seats).toBeNull()
  })

  it('refuses malformed requests (unsigned 400) and stores check-ins without addresses or people', async () => {
    const bad = await fetch(`${base}/v1/licence/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, licenceId: licId, email: 'a@b.c' }) })
    expect(bad.status).toBe(400)
    const big = await fetch(`${base}/v1/licence/check`, { method: 'POST', body: 'x'.repeat(10_000) })
    expect(big.status).toBe(413)
    const cols = (await pgQuery<{ column_name: string }>(dbName, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'lic' AND table_name = 'checkins'`)).map((c) => c.column_name).sort()
    expect(cols).toEqual(['at', 'id', 'install_id', 'org_id', 'outcome', 'seats', 'version'])
    const shown = await cli('checkins', licId)
    expect(shown.text).toMatch(/active\s+seats \{.*"operator":3/)
  })

  it('suspend, payment state and resume change the answer; every command is audited', async () => {
    expect((await cli('suspend', licId, '--notice-days', '2', '--message', 'Invoice 42 overdue')).code).toBe(0)
    let p = (await check(licId, key)).p!
    expect(p).toMatchObject({ status: 'suspended', message: 'Invoice 42 overdue', noticeDays: 2 })
    expect(Date.parse(p.readOnlyFrom!) - Date.now()).toBeGreaterThan(47 * 3600_000)
    expect((await cli('resume', licId)).code).toBe(0)
    expect((await check(licId, key)).p!.status).toBe('active')
    // unpaid: the paid-until date passed; read-only 14 days later (the notice)
    const saved = now
    now = Date.UTC(2027, 0, 5)
    p = (await check(licId, key)).p!
    expect(p.status).toBe('payment')
    expect(p.readOnlyFrom!.slice(0, 10)).toBe('2027-01-14')
    expect((await cli('payment', 'record', licId, '--paid-until', '2027-03-31', '--reference', 'INV-2027-001')).code).toBe(0)
    expect((await check(licId, key)).p!.status).toBe('active')
    now = saved
    expect((await cli('seats', 'set', licId, '--operator', '25')).code).toBe(0)
    expect((await cli('plan', 'set', licId, 'standard')).code).toBe(0)
    expect((await check(licId, key)).p).toMatchObject({ plan: 'standard', seats: { full: 5, operator: 25, external: 0 } })
    const failed = await cli('suspend', 'no-such-org')
    expect(failed.code).toBe(2)
    const audit = await pgQuery<{ command: string; ok: boolean; os_user: string }>(dbName, `SELECT command, ok, os_user FROM lic.audit ORDER BY id`)
    const cmds = audit.map((a) => `${a.command}:${a.ok}`)
    for (const c of ['migrate:true', 'org create:true', 'key issue:true', 'key revoke:true', 'suspend:true', 'resume:true', 'payment record:true', 'seats set:true', 'plan set:true', 'suspend:false']) expect(cmds).toContain(c)
    expect(audit.every((a) => a.os_user.length > 0)).toBe(true)
    // list and show work and print no install key
    const shown = await cli('org', 'show', licId)
    expect(shown.text).toContain('install keys:')
    expect(shown.text).not.toContain(key)
    expect((await cli('org', 'list')).text).toContain('Acme Tools')
  })

  it('two installs alternating on one licence: flagged at once, the older one answered "duplicate" after 7 days', async () => {
    const created = await cli('org', 'create', '--name', 'Dup Ltd', '--kind', 'lifetime', '--maintenance-until', '2028-01-01')
    const id = /licence id (lic_[a-z0-9]+)/.exec(created.text)![1]
    const dkey = /^(abl_\S+)$/m.exec((await cli('key', 'issue', id)).text)![1]
    const a = newInstallId(), b = newInstallId()
    const t0 = now
    expect((await check(id, dkey, a)).p).toMatchObject({ status: 'active', kind: 'lifetime', paidUntil: null })
    now = t0 + 3600_000
    expect((await check(id, dkey, b)).p!.status).toBe('active')
    expect((await cli('org', 'show', id)).text).toContain('DUPLICATE')
    // both keep checking (every few hours) for a week
    for (let t = t0 + 6 * 3600_000; t < t0 + DUPLICATE_GRACE_MS; t += 6 * 3600_000) {
      now = t
      expect((await check(id, dkey, b)).p!.status).toBe('active')
      expect((await check(id, dkey, a)).p!.status).toBe('active')
    }
    now = t0 + DUPLICATE_GRACE_MS + 7200_000
    expect((await check(id, dkey, b)).p!.status).toBe('active')
    expect((await check(id, dkey, a)).p!.status).toBe('duplicate')
    // the operator releases the old one (it was moved to a new server)
    expect((await cli('install', 'release', id, a)).code).toBe(0)
    expect((await check(id, dkey, b)).p!.status).toBe('active')
    now = t0
  })

  it('rate limits per address', async () => {
    const tight = await listen(createHandler({ db, key: loadSigningKey(k.privatePem, PASS), ratePerMinute: 3 }), { host: '127.0.0.1', port: 0 })
    try {
      const url = `http://127.0.0.1:${(tight.address() as AddressInfo).port}/v1/licence/check`
      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await fetch(url, { method: 'POST', body: '{}' })).status)
      expect(codes.slice(0, 3)).toEqual([400, 400, 400])
      expect(codes.slice(3)).toEqual([429, 429])
    } finally {
      await new Promise<void>((r) => tight.close(() => r()))
    }
  })

  it('keygen writes an encrypted key pair outside the repository and refuses a folder inside it', () => {
    const io2 = { out: () => {}, err: () => {} }
    expect(() => keygen(path.resolve('server', 'tmp-keys'), PASS, io2)).toThrow(/outside the repository/)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lickeys-'))
    try {
      const r = keygen(path.join(dir, 'k'), PASS, io2)
      const pem = fs.readFileSync(r.keyFile, 'utf8')
      expect(pem).toContain('ENCRYPTED PRIVATE KEY')
      expect(loadSigningKey(pem, PASS).keyId).toBe(r.id)
      expect(() => loadSigningKey(pem, 'wrong-passphrase')).toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
