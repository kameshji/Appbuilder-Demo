/**
 * TEST HELPER (tls.integration.test.ts): connects once with the product's pool options and prints JSON
 * {ok, version} or {ok: false, code, message}. Run as a child process so NODE_EXTRA_CA_CERTS (the test CA) applies.
 *   node tls-probe.ts <host> <port> <user> <password> <database> [<resolve-to-ip>]
 * With <resolve-to-ip> the host name is resolved to that address (the product's `lookup` hook), so a name the
 * certificate does not carry can be tried without DNS.
 */
import mysql from 'mysql2/promise'
import { poolOptions } from '../db.ts'
import type { MySqlSettings } from '../../../core/contracts.ts'
import type { NodeLookup } from '../../../core/net-policy.ts'

const [host, port, user, password, database, resolveTo] = process.argv.slice(2)
const lookup: NodeLookup | undefined = resolveTo
  ? (((_h: string, o: unknown, cb?: unknown) => {
      const done = (typeof o === 'function' ? o : cb) as (e: Error | null, a: unknown, f?: number) => void
      const all = typeof o === 'object' && o !== null && (o as { all?: boolean }).all
      if (all) done(null, [{ address: resolveTo, family: 4 }])
      else done(null, resolveTo, 4)
    }) as unknown as NodeLookup)
  : undefined
const settings = { host, port: Number(port), user, database, ssl: true } as MySqlSettings
const pool = mysql.createPool({ ...poolOptions(settings, password, { lookup }), connectionLimit: 1, connectTimeout: 5000 })
try {
  const [rows] = await pool.query('SELECT VERSION() AS v')
  process.stdout.write(JSON.stringify({ ok: true, version: (rows as { v: string }[])[0].v }))
} catch (e) {
  const err = e as { code?: string; message?: string }
  process.stdout.write(JSON.stringify({ ok: false, code: err.code ?? null, message: String(err.message ?? e) }))
} finally {
  await pool.end().catch(() => {})
}
