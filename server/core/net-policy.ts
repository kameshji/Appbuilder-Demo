/**
 * Outbound network policy (P0 package M; docs/admin/security-model.md "Outbound connections"). Appbuilder connects out
 * to hosts that administrators type in: database connections (and their introspection) and the SMTP relay. Policy:
 *
 *  - always refused: link-local addresses (169.254.0.0/16, fe80::/10; cloud metadata services such as
 *    169.254.169.254 live there), the unspecified address (0.0.0.0, ::), multicast and broadcast, and the well-known
 *    metadata host names. Nothing an administrator needs lives there; an attacker who got an administrator account
 *    would use them to read cloud credentials.
 *  - allowed by default: loopback and private networks (10/8, 172.16/12, 192.168/16, fc00::/7, 100.64/10). An
 *    on-premises install's databases and mail relay are there. `APPBUILDER_OUTBOUND_PRIVATE=deny` refuses them too
 *    (installs that only talk to the internet).
 *
 * Names are resolved and every address is checked (a name that resolves to a forbidden address is refused). The
 * database drivers resolve the name again when they connect, so a DNS answer that changes in between (rebinding) is a
 * residual risk for database connections; the SMTP client connects to the address that was checked.
 */
import dns from 'node:dns'
import net from 'node:net'
import { HttpError } from './contracts.ts'

export type AddressClass = 'loopback' | 'private' | 'link-local' | 'unspecified' | 'multicast' | 'broadcast' | 'public'

const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal'])

function v4(ip: string): number[] | null {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null
}

/** what kind of address this is (IPv4, IPv6, IPv4-mapped IPv6) */
export function classifyAddress(ipIn: string): AddressClass {
  let ip = ipIn.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) ip = mapped[1]!
  const a = v4(ip)
  if (a) {
    const [x, y] = a as [number, number, number, number]
    if (x === 0) return 'unspecified'
    if (x === 127) return 'loopback'
    if (x === 169 && y === 254) return 'link-local'
    if (x >= 224 && x <= 239) return 'multicast'
    if (a.every((n) => n === 255)) return 'broadcast'
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127)) return 'private'
    return 'public'
  }
  if (net.isIPv6(ip)) {
    if (ip === '::') return 'unspecified'
    if (ip === '::1') return 'loopback'
    if (/^fe[89ab]/.test(ip)) return 'link-local'
    if (/^ff/.test(ip)) return 'multicast'
    if (/^f[cd]/.test(ip)) return 'private'
    return 'public'
  }
  return 'public'
}

const ALWAYS_DENIED: AddressClass[] = ['link-local', 'unspecified', 'multicast', 'broadcast']

function deniedClasses(env: NodeJS.ProcessEnv = process.env): AddressClass[] {
  return env.APPBUILDER_OUTBOUND_PRIVATE === 'deny' ? [...ALWAYS_DENIED, 'loopback', 'private'] : ALWAYS_DENIED
}

/** a literal check without DNS (sync callers): null when allowed, else the reason */
export function hostProblem(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const h = host.trim().replace(/\.$/, '').toLowerCase()
  if (!h) return 'The host is empty.'
  if (METADATA_NAMES.has(h)) return `"${host}" is a cloud metadata service; Appbuilder does not connect to it.`
  const bare = h.replace(/^\[|\]$/g, '')
  if (net.isIP(bare) || /^::ffff:/.test(bare)) {
    const c = classifyAddress(bare)
    if (deniedClasses(env).includes(c)) return `${host} is a ${c} address; Appbuilder does not connect to it.`
  }
  return null
}

/**
 * Throws 422 when `host` is not an allowed outbound target (after resolving it). Returns the addresses it resolved to
 * (the first one is what a caller that connects itself should use).
 */
export async function assertOutboundHost(host: string, what: string, o: { env?: NodeJS.ProcessEnv; lookup?: (h: string) => Promise<{ address: string }[]> } = {}): Promise<string[]> {
  const env = o.env ?? process.env
  const literal = hostProblem(host, env)
  if (literal) throw new HttpError(422, 'invalid', `${what}: ${literal}`, 'host')
  const bare = host.trim().replace(/^\[|\]$/g, '')
  if (net.isIP(bare)) return [bare]
  let addrs: { address: string }[]
  try {
    addrs = await (o.lookup ?? ((h) => dns.promises.lookup(h, { all: true, verbatim: true })))(bare)
  } catch {
    // an unknown name is the connection's own error to report (it will not connect anywhere)
    return []
  }
  for (const a of addrs) {
    const c = classifyAddress(a.address)
    if (deniedClasses(env).includes(c)) throw new HttpError(422, 'invalid', `${what}: ${host} resolves to a ${c} address (${a.address}); Appbuilder does not connect to it.`, 'host')
  }
  return addrs.map((a) => a.address)
}
