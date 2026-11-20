/**
 * H-B findings in the outbound policy (no database): a database connection whose host is a path is a local socket
 * (the PostgreSQL and MySQL drivers connect to a Unix socket or named pipe for it), and "localhost" names are this
 * machine. Both are loopback: refused with APPBUILDER_OUTBOUND_PRIVATE=deny (every hosted install) before a driver sees
 * them; on-premises (private networks allowed) unchanged.
 */
import { describe, expect, it } from 'vitest'
import { assertOutboundHost, hostProblem } from '../net-policy.ts'

const HOSTED = { APPBUILDER_OUTBOUND_PRIVATE: 'deny' }
const SOCKETS = ['/var/run/postgresql', '/run/postgresql', '/tmp', '/tmp/.s.PGSQL.5432', '/var/run/mysqld/mysqld.sock', '\\\\.\\pipe\\MySQL', 'C:\\pg\\sock']
const LOCAL_NAMES = ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost']

describe('outbound policy: local sockets and localhost names (H-B)', () => {
  it('hosted (deny): socket paths and localhost names are refused without asking DNS', async () => {
    for (const h of [...SOCKETS, ...LOCAL_NAMES]) {
      expect(hostProblem(h, HOSTED), h).toMatch(/local socket path|this machine/)
      await expect(assertOutboundHost(h, 'Connection', { env: HOSTED, lookup: async () => [{ address: '203.0.113.9' }] }), h).rejects.toThrow(/local socket path|this machine/)
    }
  })

  it('on-premises: unchanged (loopback and local sockets allowed)', () => {
    for (const h of [...SOCKETS, ...LOCAL_NAMES]) expect(hostProblem(h, {}), h).toBeNull()
  })

  it('ordinary names and public addresses are not affected', () => {
    for (const h of ['db.example.com', 'localhost-db.example.com', 'mylocalhost', '203.0.113.9']) expect(hostProblem(h, HOSTED), h).toBeNull()
  })
})
