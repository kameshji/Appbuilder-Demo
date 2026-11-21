/** The files the fleet writes on a server, and the pure helpers (ids, SCRAM, redaction, arguments). */
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { caddyBase, caddyNotice, caddySite, instanceEnv, limitsDropIn, tmpfilesLine, unitTemplate } from '../lib/templates.ts'
import { DEFAULT_LIMITS, defaultConfig, serverPaths, type OrgRecord } from '../lib/model.ts'
import { newOrgId, ORG_ID, parseArgs, parseSize, redactArgv, scramVerifier, scrub, sealBlob, openBlob, slugProblem } from '../lib/util.ts'
import { quotaModeFor, validateLimits } from '../lib/limits.ts'

const p = serverPaths('/opt/appbuilder/fleet')
const c = defaultConfig('server', 'apps.example.com')
const org: OrgRecord = { id: 'oabcdefgh', slug: 'acme', host: 'acme.apps.example.com', name: 'Acme', adminEmail: 'it@acme.example', plan: 'pilot', seats: 25, state: 'active', release: '0.8.0', osUser: 'ab-oabcdefgh', db: 'ab_oabcdefgh', createdOn: '2026-11-21T00:00:00Z', licenceId: 'lic_x' }

describe('templates', () => {
  it('template unit: own user, env file, folder, socket folder, limits and the hardening', () => {
    const u = unitTemplate(p, DEFAULT_LIMITS)
    for (const line of ['User=ab-%i', 'EnvironmentFile=/srv/appbuilder/%i/instance.env', 'ExecStart=/opt/appbuilder/node/bin/node /srv/appbuilder/%i/app/server/main.ts',
      'ReadWritePaths=/srv/appbuilder/%i /run/appbuilder/%i', 'TemporaryFileSystem=/srv/appbuilder:ro /run/appbuilder:ro', 'MemoryMax=1536M', 'MemoryHigh=1G',
      'CPUQuota=200%', 'TasksMax=256', 'LimitNOFILE=8192', 'ProtectSystem=strict', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'Restart=on-failure', 'StartLimitBurst=5', 'OnFailure=appbuilder-fleet-alert@%n.service']) {
      expect(u).toContain(line)
    }
    expect(u).toMatch(/InaccessiblePaths=.*\/etc\/appbuilder/)
  })

  it('Caddy: exact host, canonical Host, X-Forwarded-Host removed, socket upstream, catch-all 404', () => {
    const s = caddySite(p, c, org)
    expect(s).toContain('acme.apps.example.com {')
    expect(s).toContain('reverse_proxy unix//run/appbuilder/oabcdefgh/http.sock {')
    expect(s).toContain('header_up Host {host}')
    expect(s).toContain('header_up -X-Forwarded-Host')
    expect(s).toContain('max_size 60MB')
    expect(s).not.toContain('tls internal')
    expect(caddySite(p, { ...c, tls: 'internal' }, org)).toContain('tls internal')
    expect(caddySite(p, { ...c, listen: 'tcp' }, { ...org, port: 7101 })).toContain('reverse_proxy 127.0.0.1:7101')
    const b = caddyBase(p, { ...c, licence: { ...c.licence, enabled: true } })
    expect(b).toContain('import /etc/caddy/fleet.d/*.caddy')
    expect(b).toMatch(/http:\/\/ \{\n\trespond "Not found" 404/)
    expect(b).toContain('licence.apps.example.com {')
    expect(caddyNotice(c, org)).toMatch(/respond ".*" 503/)
  })

  it('instance env: every hosted setting, the locked address, the refusals; never a password', () => {
    // server paths are POSIX on the server; on a Windows test machine path.join writes backslashes
    const e = instanceEnv({ paths: p, config: { ...c, licence: { ...c.licence, enabled: true }, outboundDenyExtra: ['203.0.113.10'] }, org, limits: DEFAULT_LIMITS, licensed: true }).split(String.fromCharCode(92)).join('/')
    for (const line of ['APPBUILDER_HOSTED=1', 'APPBUILDER_PUBLIC_URL=https://acme.apps.example.com', 'APPBUILDER_ALLOWED_HOSTS=acme.apps.example.com', 'APPBUILDER_SETUP=closed',
      'APPBUILDER_DB_POOL=6', 'APPBUILDER_JOBS_POLL_MS=5000', 'APPBUILDER_OUTBOUND_PRIVATE=deny', 'APPBUILDER_OUTBOUND_DENY=*.apps.example.com,203.0.113.10',
      'APPBUILDER_SOCKET=/run/appbuilder/oabcdefgh/http.sock', 'APPBUILDER_SOCKET_MODE=660', 'APPBUILDER_INSTANCE_DIR=/srv/appbuilder/oabcdefgh',
      'APPBUILDER_TRUST_PROXY=1', 'APPBUILDER_SECURE_COOKIE=1', 'APPBUILDER_LICENCE_ID=lic_x', 'NODE_OPTIONS=--max-old-space-size=1024']) {
      expect(e).toContain(line)
    }
    expect(e).not.toMatch(/PASSWORD|SECRET_KEY=/)
  })

  it('socket folder: owner the install, group caddy, setgid; limits drop-in', () => {
    expect(tmpfilesLine(p, 'oabcdefgh')).toContain('d /run/appbuilder/oabcdefgh 2750 ab-oabcdefgh caddy -')
    expect(limitsDropIn({ ...DEFAULT_LIMITS, memoryMax: '2G' })).toContain('MemoryMax=2G')
  })
})

describe('helpers', () => {
  it('ids are opaque', () => {
    for (let i = 0; i < 50; i++) expect(newOrgId()).toMatch(ORG_ID)
    expect(slugProblem('acme-2')).toBeNull()
    expect(slugProblem('Acme')).not.toBeNull()
    expect(slugProblem('a')).not.toBeNull()
    expect(slugProblem('licence')).not.toBeNull()
    expect(slugProblem('-x')).not.toBeNull()
  })

  it('the SCRAM verifier is the one PostgreSQL computes (RFC 7677 with a known salt)', () => {
    const salt = Buffer.from('0123456789abcdef')
    const v = scramVerifier('pencil', salt, 4096)
    const sp = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256')
    const stored = createHash('sha256').update(createHmac('sha256', sp).update('Client Key').digest()).digest('base64')
    expect(v).toBe(`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${createHmac('sha256', sp).update('Server Key').digest('base64')}`)
  })

  it('secrets never reach the audit or the screen', () => {
    expect(redactArgv(['init', '--pg-url', 'postgres://postgres:hunter22@127.0.0.1/x', '--mail-password', 'pw123456', '--mail-password-file', '/root/pw'])).toEqual(['init', '--pg-url', 'postgres://postgres:***@127.0.0.1/x', '--mail-password', '***', '--mail-password-file', '/root/pw'])
    expect(scrub('link https://a/#invite=abc.DEF_1 key abl_0123456789abcdef pw s3cretvalue', ['s3cretvalue'])).toBe('link https://a/#invite=*** key abl_*** pw ***')
  })

  it('arguments, sizes, limits, quota modes, sealed files', () => {
    expect(parseArgs(['org', 'create', 'x', '--name', 'A B', '--print-link', '--seats=5'], ['print-link'])).toEqual({ args: ['org', 'create', 'x'], o: { name: 'A B', 'print-link': true, seats: '5' } })
    expect(parseSize('1.5G')).toBe(1610612736)
    expect(parseSize('1536M')).toBe(1610612736)
    expect(validateLimits({ memoryMax: '1G', memoryHigh: '2G' })).toHaveLength(1)
    expect(validateLimits(DEFAULT_LIMITS)).toEqual([])
    expect(quotaModeFor({ fstype: 'xfs', options: 'rw,relatime,prjquota' })).toBe('xfs')
    expect(quotaModeFor({ fstype: 'ext4', options: 'rw,relatime' })).toBe('watch')
    const k = 'b'.repeat(64)
    expect(openBlob(k, 'globals', sealBlob(k, 'globals', Buffer.from('CREATE ROLE x'))).toString()).toBe('CREATE ROLE x')
    expect(() => openBlob('c'.repeat(64), 'globals', sealBlob(k, 'globals', Buffer.from('x')))).toThrow()
  })
})
