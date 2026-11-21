/**
 * MySQL / MariaDB over SSL end to end (P3-15) against a TLS MariaDB whose certificate names only "localhost" and is
 * issued by a test CA:
 *   APPBUILDER_TEST_MYSQL_TLS=mysql://user:password@localhost:port/db  APPBUILDER_TEST_MYSQL_TLS_CA=<ca.pem>
 * Each try is a child process (testdata/tls-probe.ts) with NODE_EXTRA_CA_CERTS set to the test CA, using the product's
 * pool options. The host name typed must be in the certificate: "localhost" connects; another name that reaches the
 * same server (resolved by the lookup hook) and the bare IP address are refused; without the test CA the chain fails.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const URL_ = process.env.APPBUILDER_TEST_MYSQL_TLS ?? ''
const CA = process.env.APPBUILDER_TEST_MYSQL_TLS_CA ?? ''
const probe = fileURLToPath(new URL('./testdata/tls-probe.ts', import.meta.url))

function tryConnect(host: string, o: { resolveTo?: string; ca?: boolean } = {}): { ok: boolean; code?: string; message?: string; version?: string } {
  const u = new URL(URL_)
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (o.ca !== false) env.NODE_EXTRA_CA_CERTS = CA
  else delete env.NODE_EXTRA_CA_CERTS
  const args = [probe, host, u.port || '3306', decodeURIComponent(u.username), decodeURIComponent(u.password), u.pathname.slice(1), ...(o.resolveTo ? [o.resolveTo] : [])]
  return JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20_000 }))
}

describe.skipIf(!URL_ || !CA)(URL_ && CA ? 'MySQL TLS verification (TLS MariaDB)' : 'MySQL TLS verification: set APPBUILDER_TEST_MYSQL_TLS and APPBUILDER_TEST_MYSQL_TLS_CA', { timeout: 60_000 }, () => {
  it('connects when the certificate names the host typed', () => {
    const r = tryConnect('localhost')
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.version).toMatch(/MariaDB|\d+\.\d+/)
  })

  it('refuses a name the certificate does not carry, though the chain is trusted', () => {
    const r = tryConnect('db.wrong-name.test', { resolveTo: '127.0.0.1' })
    expect(r.ok, JSON.stringify(r)).toBe(false)
    expect(`${r.code} ${r.message}`).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match|altnames/i)
  })

  it('refuses the IP address when the certificate names only the host name', () => {
    const r = tryConnect('127.0.0.1')
    expect(r.ok, JSON.stringify(r)).toBe(false)
    expect(`${r.code} ${r.message}`).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match|altnames|IP/i)
  })

  it('refuses a certificate from a CA that is not trusted', () => {
    const r = tryConnect('localhost', { ca: false })
    expect(r.ok, JSON.stringify(r)).toBe(false)
    expect(`${r.code} ${r.message}`).toMatch(/self[- ]signed|unable to (get|verify)|UNABLE_TO|SELF_SIGNED/i)
  })
})
