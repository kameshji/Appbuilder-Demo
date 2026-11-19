/**
 * Every API answer carries its request id (X-Request-Id), errors also in the body (error.requestId), so the client can
 * show "Reference: <id>" and support can find the request in the server log (docs/help/something-wrong.md).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type AppServer } from './app.ts'
import { setQuiet } from './util.ts'
import { errorReference, rememberErrorReference, referenceOf } from '../../src/platform/errorMessages.ts'
import { PlatformError } from '../../src/platform/contracts.ts'

setQuiet(true)

describe('request ids in answers and error messages', () => {
  let app: AppServer
  let server: http.Server
  let base = ''
  let tmp = ''
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rid-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, jobs: false, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await app.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('errors carry the id in the header and the body; a well-formed id from the client is kept', async () => {
    const r = await fetch(`${base}/no-such-route`)
    expect(r.status).toBe(404)
    const id = r.headers.get('x-request-id')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect((await r.json()).error).toMatchObject({ code: 'not-found', requestId: id })
    const mine = await fetch(`${base}/no-such-route`, { headers: { 'X-Request-Id': 'support-check-1' } })
    expect(mine.headers.get('x-request-id')).toBe('support-check-1')
    const bad = await fetch(`${base}/no-such-route`, { headers: { 'X-Request-Id': 'bad id with spaces' } })
    expect(bad.headers.get('x-request-id')).not.toBe('bad id with spaces')
    const ok = await fetch(`${base}/status`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-request-id')).toBeTruthy()
  })

  it('the client remembers the reference of an error message (for toasts and dialogs)', () => {
    const e = new PlatformError('storage', 'Internal server error.')
    e.requestId = 'abc123'
    expect(referenceOf(e)).toBe('abc123')
    rememberErrorReference(e.message, referenceOf(e))
    expect(errorReference('Internal server error.')).toBe('abc123')
    expect(errorReference('Something else')).toBeUndefined()
  })
})
