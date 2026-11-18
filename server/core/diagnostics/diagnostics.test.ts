/**
 * Package L, pure parts of diagnostics: redaction, the rotating file log, the diagnostics bundle without a database.
 *   npx vitest run server/core/diagnostics
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REDACTED, redactObject, redactText } from './redact.ts'
import { createFileLog, effectiveLevel, rotatedName, writeOpsSettings } from './logger.ts'
import { buildDiagnosticsBundle, configSnapshot } from './bundle.ts'
import { readZip } from '../update/zip.ts'
import { loadConfig } from '../config.ts'
import { runWithRequest } from '../work-context.ts'

const tmps: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-diag-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** every secret shape the server or an administrator could put into a log line or a config */
const SECRETS = {
  url: 'postgres://appbuilder:S3cret-DB-pass@127.0.0.1:5432/appbuilder',
  setupBanner: '  FIRST-RUN SETUP CODE:  K7QD-M2XP',
  setupLine: 'Setup code: K7QDM2XP (shown above; needed by the setup screen)',
  json: '{"password":"hunter2-long","passphrase":"my backup phrase","host":"db"}',
  kv: 'APPBUILDER_DB_PASSWORD=plain-text-pw PGPASSWORD=other-pw',
  cookie: 'Cookie: ab_session=3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c; theme=dark',
  bearer: 'Authorization: Bearer abk_AbCdEf12_ThisIsTheSecretPartOfTheKey0123456789xyz',
  apiKey: 'key abk_AbCdEf12_ThisIsTheSecretPartOfTheKey0123456789xyz used',
  scram: "ALTER ROLE x PASSWORD 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy'",
  hexKey: 'key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef end',
  sealed: '"passwordSealed": "v1:aXY=:dGFn:Y2lwaGVy"',
  pem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIK\n-----END PRIVATE KEY-----',
  email: 'invitation sent to grace.hopper@example.com',
}

describe('redaction', () => {
  it('removes every secret shape from text', () => {
    const all = Object.values(SECRETS).join('\n')
    const r = redactText(all)
    for (const leak of ['S3cret-DB-pass', 'K7QD-M2XP', 'K7QDM2XP', 'hunter2-long', 'my backup phrase', 'plain-text-pw', 'other-pw',
      '3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c', 'ThisIsTheSecretPartOfTheKey', 'c3RvcmVk', '0123456789abcdef0123456789abcdef', 'Y2lwaGVy', 'MC4CAQAwBQYDK2VwBCIEIK', 'grace.hopper']) {
      expect(r, leak).not.toContain(leak)
    }
    // what support needs stays readable
    expect(r).toContain('postgres://appbuilder:')
    expect(r).toContain('@127.0.0.1:5432/appbuilder')
    expect(r).toContain('abk_AbCdEf12_')
    expect(r).toContain('g***@example.com')
    expect(r).toContain('"host":"db"')
    expect(r).toContain('theme=dark')
  })

  it('replaces secret-named keys in objects, keeps the rest', () => {
    const r = redactObject({ host: 'db', port: 5432, password: 'x1', nested: { passwordSealed: 'v1:a:b:c', apiKey: 'k', hasPassword: true, note: 'mail to ada@example.org' }, list: [{ token: 't' }], APPBUILDER_SECRET_KEY: 'f'.repeat(64), APPBUILDER_DB_PASSWORD: 'pw', empty: '' })
    expect(r).toEqual({ host: 'db', port: 5432, password: REDACTED, nested: { passwordSealed: REDACTED, apiKey: REDACTED, hasPassword: true, note: 'mail to a***@example.org' }, list: [{ token: REDACTED }], APPBUILDER_SECRET_KEY: REDACTED, APPBUILDER_DB_PASSWORD: REDACTED, empty: '' })
  })
})

describe('file log', () => {
  it('writes JSON lines with request ids, filters by level, time and text', () => {
    const dir = tmp()
    const fl = createFileLog({ dir })
    fl.write('info', 'server started')
    runWithRequest({ headers: { 'x-request-id': 'req-123' } } as never, () => fl.write('warn', 'slow query on t_orders'))
    fl.write('error', 'audit write failed')
    const lines = fs.readFileSync(path.join(dir, 'appbuilder.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.l)).toEqual(['info', 'warn', 'error'])
    expect(lines[1]).toMatchObject({ m: 'slow query on t_orders', rid: 'req-123' })
    expect(fl.read().items.map((e) => e.m)).toEqual(['audit write failed', 'slow query on t_orders', 'server started'])
    expect(fl.read({ level: 'warn' }).items).toHaveLength(2)
    expect(fl.read({ q: 'REQ-123' }).items.map((e) => e.l)).toEqual(['warn'])
    expect(fl.read({ q: 'orders' }).items).toHaveLength(1)
    expect(fl.read({ from: new Date(Date.now() + 60_000).toISOString() }).items).toHaveLength(0)
    expect(fl.read({ to: new Date(Date.now() - 60_000).toISOString() }).items).toHaveLength(0)
    expect(fl.read({ limit: 2 })).toMatchObject({ truncated: true })
    fl.write('info', 'Setup code: K7QDM2XP (shown above; needed by the setup screen)')
    expect(fl.read({ q: 'setup code' }).items[0].m).toBe('Setup code: (not logged) (shown above; needed by the setup screen)')
    fl.setLevel('error')
    fl.write('warn', 'dropped')
    expect(fl.read({ q: 'dropped' }).items).toHaveLength(0)
    fl.close()
  })

  it('rotates by size and keeps a fixed number of files', () => {
    const dir = tmp()
    const fl = createFileLog({ dir, maxBytes: 64 * 1024, keep: 3 })
    const msg = 'x'.repeat(1000)
    for (let i = 0; i < 400; i++) fl.write('info', `${i} ${msg}`)
    const names = fl.files().map((f) => f.name)
    expect(names).toEqual([rotatedName(0), rotatedName(1), rotatedName(2)])
    for (const f of fl.files()) expect(f.bytes).toBeLessThanOrEqual(64 * 1024)
    // newest first across files
    const items = fl.read({ limit: 5000 }).items
    expect(items[0].m.startsWith('399 ')).toBe(true)
    expect(Number(items[items.length - 1].m.split(' ')[0])).toBeGreaterThan(200)
    // download text is oldest first
    const all = fl.readAllText().trim().split('\n')
    expect(JSON.parse(all[all.length - 1]).m.startsWith('399 ')).toBe(true)
    fl.close()
  })

  it('level: the environment variable wins over the stored setting', () => {
    const ws = tmp()
    expect(effectiveLevel(ws, {})).toEqual({ level: 'info', fromEnv: false })
    writeOpsSettings(ws, { logLevel: 'warn' })
    expect(effectiveLevel(ws, {})).toEqual({ level: 'warn', fromEnv: false })
    expect(effectiveLevel(ws, { APPBUILDER_LOG_LEVEL: 'error' })).toEqual({ level: 'error', fromEnv: true })
    expect(effectiveLevel(ws, { APPBUILDER_LOG_LEVEL: 'loud' })).toEqual({ level: 'warn', fromEnv: false })
  })
})

describe('diagnostics bundle', () => {
  it('holds config, versions and logs with every secret removed', async () => {
    const ws = tmp()
    const env = { APPBUILDER_WORKSPACE: ws, APPBUILDER_DB_PASSWORD: 'env-db-password', APPBUILDER_SECRET_KEY: 'a'.repeat(64), APPBUILDER_ALLOWED_HOSTS: 'apps.example.com', PORT: '5174', HOME: '/root' }
    const config = loadConfig(env)
    fs.writeFileSync(path.join(ws, 'server.json'), JSON.stringify({ defaultConnection: { host: '127.0.0.1', port: 5432, database: 'appbuilder', user: 'appbuilder', ssl: false, passwordSealed: 'v1:SEALEDIV:SEALEDTAG:SEALEDDATA' }, setupComplete: true }))
    fs.writeFileSync(path.join(ws, '.secret-key'), 'b'.repeat(64) + '\n')
    fs.mkdirSync(path.join(ws, 'logs'))
    const log = Object.values(SECRETS).map((m, i) => JSON.stringify({ t: new Date(Date.now() + i).toISOString(), l: 'info', m })).join('\n') + '\n'
    fs.writeFileSync(path.join(ws, 'logs', 'appbuilder.log'), log)
    fs.writeFileSync(path.join(ws, 'logs', 'appbuilder.1.log'), JSON.stringify({ t: new Date().toISOString(), l: 'error', m: 'older: password=older-secret' }) + '\n')

    const b = await buildDiagnosticsBundle({ config, env, services: null, notes: ['database connection to postgres://u:note-pw@h/db failed'] })
    expect(b.name).toMatch(/^appbuilder-diagnostics-\d{8}T\d{6}Z\.zip$/)
    const entries = readZip(b.data)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'config.json', 'versions.json', 'system.json', 'logs/appbuilder.log', 'logs/appbuilder.1.log']))
    expect(names).not.toContain('.secret-key')
    const everything = entries.map((e) => e.data.toString('utf8')).join('\n')
    for (const leak of ['env-db-password', 'a'.repeat(64), 'b'.repeat(64), 'SEALEDDATA', 'S3cret-DB-pass', 'K7QD-M2XP', 'hunter2-long', 'plain-text-pw', 'ThisIsTheSecretPartOfTheKey', 'older-secret', 'note-pw', 'grace.hopper', 'MC4CAQAwBQYDK2VwBCIEIK']) {
      expect(everything, leak).not.toContain(leak)
    }
    const cfg = JSON.parse(entries.find((e) => e.name === 'config.json')!.data.toString())
    expect(cfg.serverJson.defaultConnection).toEqual({ host: '127.0.0.1', port: 5432, database: 'appbuilder', user: 'appbuilder', ssl: false, hasPassword: true })
    expect(cfg.environment.APPBUILDER_ALLOWED_HOSTS).toBe('apps.example.com')
    expect(cfg.environment.APPBUILDER_DB_PASSWORD).toBe(REDACTED)
    expect(cfg.environment.HOME).toBeUndefined()
    expect(cfg.workspaceFiles.installKeyFile).toBe('present')
    expect(entries.find((e) => e.name === 'README.txt')!.data.toString()).toContain('The server was not running in this process')
  })

  it('configSnapshot never carries the sealed password', () => {
    const ws = tmp()
    const config = loadConfig({ APPBUILDER_WORKSPACE: ws })
    fs.writeFileSync(path.join(ws, 'server.json'), JSON.stringify({ defaultConnection: { host: 'h', port: 1, database: 'd', user: 'u', passwordSealed: 'v1:x:y:z' } }))
    expect(JSON.stringify(configSnapshot(config, {}))).not.toContain('v1:x:y:z')
  })
})
