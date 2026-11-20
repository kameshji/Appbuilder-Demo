/**
 * Test-only DNS for the isolation suite (scripts/fleet/testing/fleet.mjs), preloaded into each install's process with
 * `node --import <this file> server/main.ts`. It answers for the test names in HB_DNS_MAP and leaves every other name
 * to the real resolver, the way the fleet's DNS will: every <org>.<domain> points at the fleet server, plus names that
 * point at loopback, private, IPv6 and metadata addresses (the "DNS name resolving to loopback" attacks).
 *
 *   HB_DNS_MAP='{"a.hb.test.invalid":"127.0.0.1","*.hb-dns.test.invalid":"10.0.0.7", ...}'   exact names or *.suffix
 *
 * Nothing in the product changes: dns.lookup and dns.promises.lookup are wrapped for these names only.
 */
import dns from 'node:dns'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'

const map = (() => {
  try { return JSON.parse(process.env.HB_DNS_MAP || '{}') } catch { return {} }
})()

function answer(name) {
  const h = String(name ?? '').toLowerCase().replace(/\.$/, '')
  if (map[h]) return map[h]
  for (const [k, v] of Object.entries(map)) if (k.startsWith('*.') && h.endsWith(k.slice(1))) return v
  return null
}

const realLookup = dns.lookup
const realPromise = dns.promises.lookup

dns.lookup = function lookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const o = typeof options === 'object' && options ? options : typeof options === 'number' ? { family: options } : {}
  const a = answer(hostname)
  if (!a) return realLookup.call(dns, hostname, options, callback)
  const family = net.isIP(a) || 4
  process.nextTick(() => (o.all ? cb(null, [{ address: a, family }]) : cb(null, a, family)))
  return {}
}
dns.promises.lookup = async function lookup(hostname, options) {
  const a = answer(hostname)
  if (!a) return realPromise.call(dns.promises, hostname, options)
  const family = net.isIP(a) || 4
  return options && typeof options === 'object' && options.all ? [{ address: a, family }] : { address: a, family }
}
syncBuiltinESMExports()
