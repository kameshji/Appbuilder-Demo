/**
 * H-B follow-ups of H-A / H-C, against the sandbox PostgreSQL:
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/hosting/followups
 *  1. the sign-in throttle keys on the client's address as the rest of the server derives it: behind the one trusted
 *     proxy (X-Forwarded-For) one client's failures no longer lock every client out; without a trusted proxy the
 *     header is ignored (a client cannot choose its own key);
 *  2. with APPBUILDER_INSTANCE_DIR a backup folder outside the install's folder and any PostgreSQL tools folder are
 *     refused from the Admin console (nothing is created there first); on-premises unchanged;
 *  4. GET /install/public-address tells the Admin console that the public address is locked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKIP_PG, PG_URL } from '../testdb.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { configureHosting, hostingSettings } from './settings.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/hosting follow-ups integration] ${SKIP_PG}\n`)

const PASSWORD = 'admin-password-1'

async function login(base: string, xff: string | null, password: string): Promise<number> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Appbuilder': '1', ...(xff ? { 'X-Forwarded-For': xff } : {}) },
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })
  await res.arrayBuffer()
  return res.status
}

describe.skipIf(!PG_URL)('sign-in throttle behind a trusted proxy (follow-up 1)', () => {
  let proxied: KernelHarness
  let direct: KernelHarness
  beforeAll(async () => {
    proxied = await startHarness('hbthr', { env: { APPBUILDER_TRUST_PROXY: '1' } })
    direct = await startHarness('hbthd')
  }, 120_000)
  afterAll(async () => {
    await proxied?.close()
    await direct?.close()
  }, 60_000)

  it('one client behind the proxy failing does not lock out another client of the same account', async () => {
    for (let i = 0; i < 8; i++) expect(await login(proxied.base, '203.0.113.1', 'wrong-password-1')).toBe(401)
    // that client is throttled (per email and client address)
    expect(await login(proxied.base, '203.0.113.1', PASSWORD)).toBe(429)
    // another person behind the same proxy signs in (before the fix: 429, the key was the proxy's address)
    expect(await login(proxied.base, '198.51.100.9', PASSWORD)).toBe(200)
  })

  it('without a trusted proxy X-Forwarded-For is ignored: rotating it does not escape the throttle', async () => {
    for (let i = 0; i < 8; i++) expect(await login(direct.base, `203.0.113.${10 + i}`, 'wrong-password-1')).toBe(401)
    expect(await login(direct.base, '203.0.113.99', PASSWORD)).toBe(429)
    expect(await login(direct.base, null, PASSWORD)).toBe(429)
  })
})

describe.skipIf(!PG_URL)('backup folders and tools in a hosted install (follow-up 2) and the locked public address (follow-up 4)', () => {
  let hosted: KernelHarness
  let onPrem: KernelHarness
  let outside = ''
  beforeAll(async () => {
    hosted = await startHarness('hbbak')
    onPrem = await startHarness('hbbap')
    // the install's folder: the harness workspace (as APPBUILDER_INSTANCE_DIR=/srv/appbuilder/<org> holds workspace/)
    configureHosting(hosted.app.services, hostingSettings({ APPBUILDER_INSTANCE_DIR: hosted.tmp, APPBUILDER_PUBLIC_URL: 'http://acme.example.test' }))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hb-outside-'))
  }, 120_000)
  afterAll(async () => {
    await hosted?.close()
    await onPrem?.close()
    if (outside) fs.rmSync(outside, { recursive: true, force: true })
  }, 60_000)

  it('a backup or off-site folder outside APPBUILDER_INSTANCE_DIR is refused before anything is created there', async () => {
    const target = path.join(outside, 'backups-here')
    const r = await hosted.admin.req('PUT', '/backups/settings', { folder: target })
    expect(r.status, JSON.stringify(r.data)).toBe(422)
    expect(r.data.error.field).toBe('folder')
    expect(fs.existsSync(target)).toBe(false)
    const off = await hosted.admin.req('PUT', '/backups/settings', { offsite: { folder: target, enabled: true } })
    expect(off.status).toBe(422)
    expect(fs.existsSync(target)).toBe(false)
    const inside = await hosted.admin.req('PUT', '/backups/settings', { folder: path.join(hosted.tmp, 'own-backups') })
    expect(inside.status, JSON.stringify(inside.data)).toBe(200)
    expect(inside.data.folder).toBe(path.join(hosted.tmp, 'own-backups'))
  })

  it('the PostgreSQL tools folder cannot be set from the Admin console of a hosted install', async () => {
    const r = await hosted.admin.req('PUT', '/backups/settings', { pgBinPath: outside })
    expect(r.status).toBe(422)
    expect(r.data.error.field).toBe('pgBinPath')
    // clearing is harmless and allowed
    expect((await hosted.admin.req('PUT', '/backups/settings', { pgBinPath: null })).status).toBe(200)
    expect((await hosted.admin.get('/backups/settings')).data.pgBinPath).toBeNull()
  })

  it('on-premises (no APPBUILDER_INSTANCE_DIR): unchanged', async () => {
    const target = path.join(outside, 'onprem-backups')
    const r = await onPrem.admin.req('PUT', '/backups/settings', { folder: target, pgBinPath: outside })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.pgBinPath).toBe(outside)
  })

  it('GET /install/public-address: locked in the hosted install, not locked on-premises', async () => {
    expect((await hosted.admin.get('/install/public-address')).data).toEqual({ publicUrl: 'http://acme.example.test', locked: true })
    expect((await onPrem.admin.get('/install/public-address')).data).toEqual({ publicUrl: null, locked: false })
  })
})
