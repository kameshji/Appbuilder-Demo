/**
 * The fleet's data: paths on the server (spec section 1), the registry /etc/appbuilder/fleet.json (configuration,
 * organisations, operator access grants, update runs, the off-machine backup catalogue) and the operator audit.
 * The registry holds NO secret: passwords and keys live in their own files (secrets folder, install folders).
 */
import path from 'node:path'

export type Mode = 'server' | 'local'

export interface FleetPaths {
  mode: Mode
  /** where everything lives ('' on a server; .sandbox/fleet/<run> in local test mode) */
  root: string
  releases: string
  current: string
  /** the Node.js the installs and abfleet run */
  node: string
  /** the folder of abfleet.ts and agent.ts */
  tool: string
  instances: string
  run: string
  etc: string
  registry: string
  lock: string
  secrets: string
  state: string
  exports: string
  staging: string
  auditDir: string
  audit: string
  caddyfile: string
  caddySites: string
  systemd: string
  tmpfiles: string
  licenceDir: string
  /** world-readable files every install may read (the licence service's public key) */
  shared: string
  bin: string
}

export function serverPaths(tool: string, node = '/opt/appbuilder/node/bin/node'): FleetPaths {
  return {
    mode: 'server', root: '', releases: '/opt/appbuilder/releases', current: '/opt/appbuilder/current', node, tool,
    instances: '/srv/appbuilder', run: '/run/appbuilder', etc: '/etc/appbuilder', registry: '/etc/appbuilder/fleet.json',
    lock: '/run/appbuilder-fleet.lock', secrets: '/etc/appbuilder/secrets', state: '/var/lib/appbuilder-fleet',
    exports: '/var/lib/appbuilder-fleet/exports', staging: '/var/lib/appbuilder-fleet/staging',
    auditDir: '/var/log/appbuilder-fleet', audit: '/var/log/appbuilder-fleet/audit.jsonl',
    caddyfile: '/etc/caddy/Caddyfile', caddySites: '/etc/caddy/fleet.d', systemd: '/etc/systemd/system',
    tmpfiles: '/etc/tmpfiles.d', licenceDir: '/etc/appbuilder/licence', shared: '/usr/local/share/appbuilder', bin: '/usr/local/sbin',
  }
}

/** the same layout below one folder (local test mode: everything stays under .sandbox/fleet) */
export function localPaths(root: string, tool: string, node = process.execPath): FleetPaths {
  const r = (...p: string[]) => path.join(root, ...p)
  return {
    mode: 'local', root, releases: r('opt', 'releases'), current: r('opt', 'current'), node, tool,
    instances: r('srv'), run: r('run'), etc: r('etc'), registry: r('etc', 'fleet.json'), lock: r('run', 'fleet.lock'),
    secrets: r('etc', 'secrets'), state: r('var', 'lib'), exports: r('var', 'lib', 'exports'), staging: r('var', 'lib', 'staging'),
    auditDir: r('var', 'log'), audit: r('var', 'log', 'audit.jsonl'), caddyfile: r('etc', 'caddy', 'Caddyfile'),
    caddySites: r('etc', 'caddy', 'fleet.d'), systemd: r('etc', 'systemd'), tmpfiles: r('etc', 'tmpfiles.d'),
    licenceDir: r('etc', 'licence'), shared: r('share'), bin: r('bin'),
  }
}

/** paths of one install (spec section 1) */
export function orgPaths(p: FleetPaths, id: string) {
  const dir = path.join(p.instances, id)
  return {
    dir,
    app: path.join(dir, 'app'),
    previous: path.join(dir, 'app.previous'),
    env: path.join(dir, 'instance.env'),
    workspace: path.join(dir, 'workspace'),
    backups: path.join(dir, 'backups'),
    fleetBackups: path.join(dir, 'fleet-backups'),
    tmp: path.join(dir, 'tmp'),
    licenceKey: path.join(dir, 'licence.key'),
    serverJson: path.join(dir, 'workspace', 'server.json'),
    secretKey: path.join(dir, 'workspace', '.secret-key'),
    runDir: path.join(p.run, id),
    socket: p.mode === 'server' ? `${p.run}/${id}/http.sock` : path.join(p.run, id, 'http.sock'),
    caddySite: path.join(p.caddySites, `${id}.caddy`),
    dropIn: path.join(p.systemd, `appbuilder@${id}.service.d`),
    limitsConf: path.join(p.systemd, `appbuilder@${id}.service.d`, '50-limits.conf'),
    tmpfilesConf: path.join(p.tmpfiles, `appbuilder-${id}.conf`),
    log: path.join(dir, 'service.log'),
  }
}

export interface Limits {
  memoryHigh: string
  memoryMax: string
  cpuQuota: string
  cpuWeight: number
  tasksMax: number
  nofile: number
  heapMb: number
  dbConnections: number
  statementTimeout: string
  idleInTransactionTimeout: string
  diskQuota: string
}

/** spec section 4 (defaults chosen there; the owner may change them) */
export const DEFAULT_LIMITS: Limits = {
  memoryHigh: '1G', memoryMax: '1536M', cpuQuota: '200%', cpuWeight: 100, tasksMax: 256, nofile: 8192, heapMb: 1024,
  dbConnections: 12, statementTimeout: '60s', idleInTransactionTimeout: '5min', diskQuota: '25G',
}

export type BackupTarget = { kind: 'path'; path: string } | { kind: 'rclone'; remote: string } | null

export interface MailRelay {
  host: string
  port: number
  security: 'starttls' | 'tls' | 'none'
  username: string
  fromAddress: string
  fromName: string
}

export interface FleetConfig {
  /** organisations are reachable at <slug>.<domain> */
  domain: string
  /** database and role names: <prefix><org id> */
  prefix: string
  listen: 'socket' | 'tcp'
  /** Caddy: automatic certificates (acme) or its local CA (internal: tests, a closed network) */
  tls: 'acme' | 'internal'
  acmeEmail: string | null
  operatorEmail: string | null
  /** operator access accounts get <local>+<grant>@<domain> of this address */
  accessEmail: string | null
  pgBin: string
  pg: { host: string; port: number }
  /** the server's own public addresses, refused to every install (APPBUILDER_OUTBOUND_DENY) */
  outboundDenyExtra: string[]
  licence: { enabled: boolean; url: string; host: string; port: number; publicKeyFile: string | null; db: string }
  /** the relay the installs send through (saved in each install at create); its password: secrets/mail-password */
  mail: MailRelay | null
  /** the relay abfleet's own alerts and daily summary go through (default: mail); password: secrets/alert-mail-password */
  alertRelay: MailRelay | null
  backup: { target: BackupTarget; keepDays: number }
  update: { batch: number; healthTimeoutS: number }
  limits: Limits
  /** local test mode: TCP ports for installs */
  portRange: [number, number]
}

export type OrgState = 'creating' | 'active' | 'suspended' | 'stopped' | 'failed'

export interface OrgRecord {
  id: string
  slug: string
  host: string
  name: string
  adminEmail: string
  plan: string
  seats: number
  state: OrgState
  suspendReason?: string
  release: string
  previousRelease?: string
  port?: number
  osUser: string
  db: string
  createdOn: string
  licenceId?: string
  limits?: Partial<Limits>
  /** the filesystem project id of the install's disk quota (xfs / ext4 project quotas) */
  quotaProject?: number
  /** how the disk limit is enforced: a project quota, or only watched by abfleet status */
  quotaMode?: 'xfs' | 'ext4' | 'watch'
  lastBackup?: { at: string; ok: boolean; file?: string; sha256?: string; error?: string; offsite?: boolean }
  lastUpdate?: { at: string; from: string; to: string; result: string; message: string }
  lastRestoreTest?: { at: string; ok: boolean; error?: string }
}

export interface Grant {
  id: string
  org: string
  reason: string
  by: string
  createdOn: string
  until: string
  userId: string
  email: string
  state: 'active' | 'ended'
  endedOn?: string
  endedBy?: string
  endReason?: string
}

export interface UpdateStep { org: string; host: string; result: 'updated' | 'rolled-back' | 'failed' | 'skipped' | 'not-run'; from: string; to: string; message: string; dataRestored?: boolean; ms?: number }

export interface UpdateRun {
  id: string
  at: string
  by: string
  release: string
  from: string[]
  canary: string | null
  result: 'completed' | 'stopped' | 'running'
  steps: UpdateStep[]
}

export interface BackupEntry {
  org: string
  host: string
  at: string
  file: string
  bytes: number
  sha256: string
  kind: 'nightly' | 'manual' | 'pre-update' | 'export' | 'pre-restore' | 'globals'
  /** where the off-machine copy is (path or rclone remote path), null when there is no target */
  offsite: string | null
  verified: boolean
}

export interface Registry {
  version: 1
  createdOn: string
  config: FleetConfig
  orgs: Record<string, OrgRecord>
  grants: Grant[]
  updates: UpdateRun[]
  backups: BackupEntry[]
  alerts: { at: string; kind: string; org?: string; message: string }[]
}

export function defaultConfig(mode: Mode, domain: string): FleetConfig {
  return {
    domain,
    prefix: mode === 'server' ? 'ab_' : 'ab_fleet_',
    listen: mode === 'server' ? 'socket' : 'tcp',
    tls: 'acme',
    acmeEmail: null,
    operatorEmail: null,
    accessEmail: null,
    pgBin: mode === 'server' ? '/usr/lib/postgresql/17/bin' : '',
    pg: { host: '127.0.0.1', port: 5432 },
    outboundDenyExtra: [],
    licence: { enabled: false, url: `https://licence.${domain}`, host: '127.0.0.1', port: 7090, publicKeyFile: null, db: mode === 'server' ? 'ab_licence' : 'ab_fleet_licence' },
    mail: null,
    alertRelay: null,
    backup: { target: null, keepDays: 14 },
    update: { batch: 5, healthTimeoutS: 180 },
    limits: { ...DEFAULT_LIMITS },
    portRange: mode === 'server' ? [7101, 7199] : [5360, 5397],
  }
}

export function emptyRegistry(config: FleetConfig, now: number): Registry {
  return { version: 1, createdOn: new Date(now).toISOString(), config, orgs: {}, grants: [], updates: [], backups: [], alerts: [] }
}

export function limitsOf(reg: Registry, org: OrgRecord): Limits {
  return { ...DEFAULT_LIMITS, ...reg.config.limits, ...(org.limits ?? {}) }
}

/** the organisation given by id, slug or full host name */
export function findOrg(reg: Registry, key: string): OrgRecord | null {
  const k = key.trim().toLowerCase()
  return reg.orgs[k] ?? Object.values(reg.orgs).find((o) => o.slug === k || o.host === k) ?? null
}

export const sortedOrgs = (reg: Registry): OrgRecord[] => Object.values(reg.orgs).sort((a, b) => a.slug.localeCompare(b.slug))
