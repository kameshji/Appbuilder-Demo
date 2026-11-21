/**
 * MySQL / MariaDB over SSL (P3-15): with SSL on, mysql2 is told to check the certificate chain AND that the certificate
 * names the host (`verifyIdentity`), as PostgreSQL connections do. With SSL off no TLS options are passed.
 * The end-to-end check against a TLS MariaDB is tls.integration.test.ts (APPBUILDER_TEST_MYSQL_TLS).
 */
import { describe, expect, it } from 'vitest'
import { poolOptions } from './db.ts'
import { friendlyConnectionError } from './index.ts'
import type { MySqlSettings } from '../../core/contracts.ts'

const base = { host: 'db.example.com', port: 3306, user: 'u', database: 'd' } as MySqlSettings

describe('MySQL TLS options passed to the driver', () => {
  it('SSL on: chain and host name are both verified, TLS 1.2 at least', () => {
    const o = poolOptions({ ...base, ssl: true }, 'pw')
    expect(o.ssl).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true })
    expect(o.host).toBe('db.example.com')
  })

  it('SSL on with an IP address: verified too (the certificate must name the address)', () => {
    expect(poolOptions({ ...base, host: '10.0.0.5', ssl: true }, 'pw').ssl).toMatchObject({ rejectUnauthorized: true, verifyIdentity: true })
  })

  it('SSL off: no TLS', () => {
    expect(poolOptions({ ...base, ssl: false }, 'pw').ssl).toBeUndefined()
  })

  it('TLS to an IP address uses its own socket, so the address is what the certificate is checked against', () => {
    expect(typeof poolOptions({ ...base, host: '10.0.0.5', ssl: true }, 'pw').stream).toBe('function')
    expect(poolOptions({ ...base, host: '10.0.0.5', ssl: false }, 'pw').stream).toBeUndefined()
    expect(poolOptions({ ...base, ssl: true }, 'pw').stream).toBeUndefined()
  })

  it('a certificate naming another host is explained in words', () => {
    const e = Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: db.example.com. is not in the cert's altnames: DNS:localhost"), { code: 'HANDSHAKE_SSL_ERROR' })
    expect(friendlyConnectionError(e, base)).toMatch(/does not name "db\.example\.com"/)
    expect(friendlyConnectionError(Object.assign(new Error('x'), { code: 'HANDSHAKE_SSL_ERROR' }), base)).toMatch(/SSL handshake/)
  })
})
