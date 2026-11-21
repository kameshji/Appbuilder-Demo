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
 * Names are resolved and every address is checked (a name that resolves to a forbidden address is refused). Callers
 * connect to an address that was checked, never to a second DNS answer: the SMTP client and the HTTP client of connectors
 * connect to the address returned; the external database connectors (P3 review, P3-6: DNS rebinding) get a
 * `guardedLookup` that hands the driver the address checked when the connection was taken from the manager and, for
 * every later physical connection of the pool, resolves and checks again (see `pinnedSocket`).
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

/** the 8 groups of an IPv6 address (with an embedded dotted IPv4 tail), or null */
function v6groups(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null
  let s = ip.split('%')[0]!
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const a = v4(tail[1]!)
    if (!a) return null
    s = s.slice(0, -tail[1]!.length) + `${((a[0]! << 8) | a[1]!).toString(16)}:${((a[2]! << 8) | a[3]!).toString(16)}`
  }
  const [head, rest] = s.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : []
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : []
  const fill = rest !== undefined ? 8 - h.length - r.length : 0
  const all = [...h, ...Array(Math.max(0, fill)).fill('0'), ...r].map((x) => parseInt(x || '0', 16))
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null
}

/**
 * P1-E security: IPv6 forms that carry an IPv4 address the operating system may reach: IPv4-mapped (::ffff:a.b.c.d, also
 * written ::ffff:a9fe:a9fe), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:wwxx:yyzz::/48). They are
 * classified as the IPv4 address inside, so "[::ffff:169.254.169.254]" is link-local, not "public".
 */
function embeddedV4(ip: string): string | null {
  const g = v6groups(ip)
  if (!g) return null
  const four = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeros(5) && g[5] === 0xffff) return four(g[6]!, g[7]!)
  if (zeros(6) && (g[6] !== 0 || g[7]! > 1)) return four(g[6]!, g[7]!)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return four(g[6]!, g[7]!)
  if (g[0] === 0x2002) return four(g[1]!, g[2]!)
  return null
}

/** what kind of address this is (IPv4, IPv6, IPv4 inside IPv6) */
export function classifyAddress(ipIn: string): AddressClass {
  let ip = ipIn.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const inner = net.isIPv6(ip) ? embeddedV4(ip) : null
  if (inner) ip = inner
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

/**
 * H-A: APPBUILDER_OUTBOUND_DENY, comma-separated host names (`api.example.com`, `*.apps.example.com`) or IP addresses
 * nothing may connect to (a hosted install: its own public address and its siblings'; the hosted profile adds the
 * install's own public host by itself).
 */
export function deniedByList(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = env.APPBUILDER_OUTBOUND_DENY
  if (!list) return false
  const h = host.trim().replace(/\.$/, '').toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of list.split(',')) {
    const e = raw.trim().replace(/\.$/, '').toLowerCase().replace(/^\[|\]$/g, '')
    if (!e) continue
    if (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e) return true
  }
  return false
}

/** one comparable form of an address: an IPv4 address (also inside IPv6) dotted, an IPv6 address as its 8 groups */
function canonicalAddress(ipIn: string): string | null {
  const ip = ipIn.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (net.isIPv4(ip)) return ip
  if (!net.isIPv6(ip)) return null
  return embeddedV4(ip) ?? v6groups(ip)?.map((g) => g.toString(16)).join(':') ?? null
}

type Lookup = (h: string) => Promise<{ address: string }[]>
const DENY_TTL_MS = 60_000
let denyCache: { key: string; at: number; addrs: Set<string> } | null = null

/**
 * P3 security review (P3-4): the ADDRESSES of APPBUILDER_OUTBOUND_DENY. The list was compared with the name a maker
 * typed only, so the install's own public address was reachable by its IP address or by any other name that resolves
 * to it (the hairpin the list exists to refuse). IP entries are taken as written, host-name entries are resolved
 * (cached a minute); wildcard entries cannot be resolved and stay name-only (docs/admin/security-model.md).
 */
export async function deniedAddresses(env: NodeJS.ProcessEnv = process.env, lookup?: Lookup): Promise<Set<string>> {
  const list = (env.APPBUILDER_OUTBOUND_DENY ?? '').split(',').map((e) => e.trim().replace(/\.$/, '').toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean)
  if (!list.length) return new Set()
  const key = list.join(',')
  if (!lookup && denyCache && denyCache.key === key && Date.now() - denyCache.at < DENY_TTL_MS) return denyCache.addrs
  const addrs = new Set<string>()
  for (const e of list) {
    if (e.startsWith('*.')) continue
    const literal = canonicalAddress(e)
    if (literal) {
      addrs.add(literal)
      continue
    }
    try {
      for (const a of await (lookup ?? ((h: string) => dns.promises.lookup(h, { all: true, verbatim: true })))(e)) {
        const c = canonicalAddress(a.address)
        if (c) addrs.add(c)
      }
    } catch {
      /* a name that does not resolve has no address to refuse */
    }
  }
  if (!lookup) denyCache = { key, at: Date.now(), addrs }
  return addrs
}

/** null when none of these addresses is one of APPBUILDER_OUTBOUND_DENY's, else the reason */
export async function deniedAddressProblem(host: string, addresses: string[], env: NodeJS.ProcessEnv = process.env, lookup?: Lookup): Promise<string | null> {
  if (!env.APPBUILDER_OUTBOUND_DENY || !addresses.length) return null
  const denied = await deniedAddresses(env, lookup)
  for (const a of addresses) {
    const c = canonicalAddress(a)
    if (c && denied.has(c)) return `${host} ${canonicalAddress(host) ? 'is' : `resolves to`} an address on this server's list of refused addresses (APPBUILDER_OUTBOUND_DENY); Appbuilder does not connect to it.`
  }
  return null
}

/** a literal check without DNS (sync callers): null when allowed, else the reason */
export function hostProblem(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const h = host.trim().replace(/\.$/, '').toLowerCase()
  if (!h) return 'The host is empty.'
  if (METADATA_NAMES.has(h)) return `"${host}" is a cloud metadata service; Appbuilder does not connect to it.`
  if (deniedByList(h, env)) return `${host} is on this server's list of refused addresses (APPBUILDER_OUTBOUND_DENY); Appbuilder does not connect to it.`
  const bare = h.replace(/^\[|\]$/g, '')
  // H-B: a path is a local socket (the PostgreSQL and MySQL drivers connect to a Unix socket or named pipe for a host
  // such as /var/run/postgresql or \\.\pipe\...), and "localhost" names are this machine without asking DNS: both are
  // loopback, refused with APPBUILDER_OUTBOUND_PRIVATE=deny before any driver sees them
  if (/[/\\]/.test(bare) || bare === 'localhost' || bare.endsWith('.localhost')) {
    if (deniedClasses(env).includes('loopback')) return `${host} is ${/[/\\]/.test(bare) ? 'a local socket path' : 'this machine (loopback)'}; this server does not connect to its own machine.`
    return null
  }
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
  if (net.isIP(bare)) {
    const listed = await deniedAddressProblem(host, [bare], env, o.lookup)
    if (listed) throw new HttpError(422, 'invalid', `${what}: ${listed}`, 'host')
    return [bare]
  }
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
  const listed = await deniedAddressProblem(host, addrs.map((a) => a.address), env, o.lookup)
  if (listed) throw new HttpError(422, 'invalid', `${what}: ${listed}`, 'host')
  return addrs.map((a) => a.address)
}

/** the callback form of dns.lookup (what net.Socket#connect accepts as `lookup`) */
export type NodeLookup = (hostname: string, options: dns.LookupOptions | number | undefined, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => void

/**
 * P3 security review, P3-6 (DNS rebinding of database connection hosts): a `lookup` for the database drivers that never
 * asks DNS behind the policy's back. The first physical connection uses `first` (the addresses the connection manager
 * checked a moment ago for `host`); every later one (a pool opening another connection, a reconnect) resolves the name
 * again and checks every address with `assertOutboundHost`, then connects to the checked address. A name that does not
 * resolve (or is refused) fails the connection: the driver never falls back to its own lookup.
 */
export function guardedLookup(host: string, what: string, o: { first?: string[]; env?: NodeJS.ProcessEnv; lookup?: Lookup } = {}): NodeLookup {
  const want = host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  let first = o.first?.length ? [...o.first] : null
  return (hostname, options, cb) => {
    const opts = typeof options === 'object' && options ? options : { family: typeof options === 'number' ? options : 0 }
    const reply = (addrs: string[]) => {
      const fam = opts.family === 4 || opts.family === 6 ? opts.family : 0
      const list = addrs.filter((a) => net.isIP(a) && (!fam || net.isIP(a) === fam))
      if (!list.length) {
        const e = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }) as NodeJS.ErrnoException
        cb(e, opts.all ? [] : '', 0)
        return
      }
      if (opts.all) cb(null, list.map((a) => ({ address: a, family: net.isIP(a) })))
      else cb(null, list[0]!, net.isIP(list[0]!))
    }
    const name = String(hostname).trim().replace(/^\[|\]$/g, '').toLowerCase()
    if (first && name === want) {
      const f = first
      first = null
      reply(f)
      return
    }
    assertOutboundHost(String(hostname), what, { env: o.env, lookup: o.lookup }).then(reply, (e: unknown) => cb(e as NodeJS.ErrnoException, opts.all ? [] : '', 0))
  }
}

/**
 * A TCP socket for the database drivers (`pg` takes it as `stream`, `mysql2` as `stream` too) whose connect(port, host)
 * resolves the host through `lookup` (guardedLookup) instead of the system resolver. The host NAME stays what the driver
 * knows: TLS server-name verification and the drivers' error messages use it. A local socket path is left as it is.
 */
export function pinnedSocket(lookup: NodeLookup): net.Socket {
  const s = new net.Socket()
  const connect = s.connect.bind(s) as (...a: unknown[]) => net.Socket
  ;(s as unknown as { connect: (...a: unknown[]) => net.Socket }).connect = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? [args[args.length - 1]] : []
    if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
      return connect({ port: Number(args[0]), host: typeof args[1] === 'string' ? args[1] : 'localhost', lookup }, ...cb)
    }
    if (args[0] && typeof args[0] === 'object' && !('path' in (args[0] as object))) return connect({ ...(args[0] as object), lookup }, ...cb)
    return connect(...args)
  }
  return s
}
