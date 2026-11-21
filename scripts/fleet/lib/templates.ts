/**
 * Every file the fleet tool writes on a server, as pure functions (tested in scripts/fleet/test/templates.test.ts):
 * the systemd template unit appbuilder@.service (spec section 2), the per-install limits drop-in (section 4), the Caddy
 * base config and site template (section 3), the per-install tmpfiles line for the socket folder, the instance env file
 * (section 5 and docs/admin/hosting.md), the licence service unit, the fleet timers.
 */
import path from 'node:path'
import { envFileText } from './util.ts'
import { orgPaths, type FleetConfig, type FleetPaths, type Limits, type OrgRecord } from './model.ts'

export const UNIT_TEMPLATE = 'appbuilder@.service'
export const LICENCE_UNIT = 'appbuilder-licence.service'
export const LICENCE_USER = 'appbuilder-licence'
export const unitName = (id: string) => `appbuilder@${id}.service`

/** the template unit: one OS user, env file, folder and socket per install; the hardening of the single-install unit */
export function unitTemplate(p: FleetPaths, l: Limits): string {
  const inst = `${p.instances}/%i`
  return `# Appbuilder fleet: one install per organisation (written by abfleet init; do not edit, re-run abfleet init)
# instance name = the organisation's opaque id; per-install limits: ${p.systemd}/appbuilder@<id>.service.d/50-limits.conf
[Unit]
Description=Appbuilder install %i (fleet)
After=network-online.target postgresql.service
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5
OnFailure=appbuilder-fleet-alert@%n.service

[Service]
Type=simple
User=ab-%i
Group=ab-%i
EnvironmentFile=${inst}/instance.env
Environment=APPBUILDER_ENV_FILE=${inst}/instance.env
WorkingDirectory=${inst}
ExecStart=${p.node} ${inst}/app/server/main.ts
Restart=on-failure
RestartSec=5
TimeoutStartSec=300
TimeoutStopSec=30
UMask=0027
# resource limits (defaults of the hosting spec, section 4)
MemoryAccounting=yes
MemoryHigh=${l.memoryHigh}
MemoryMax=${l.memoryMax}
CPUAccounting=yes
CPUQuota=${l.cpuQuota}
CPUWeight=${l.cpuWeight}
TasksMax=${l.tasksMax}
LimitNOFILE=${l.nofile}
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=appbuilder-%i
# hardening: only its own folder and socket folder are writable; other installs' folders are not even visible
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${inst} ${p.run}/%i
TemporaryFileSystem=${p.instances}:ro ${p.run}:ro
BindPaths=${inst} ${p.run}/%i
InaccessiblePaths=-${p.etc} -${p.state} -${p.auditDir} -/etc/caddy -/var/lib/caddy
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
# V8 compiles JavaScript to machine code at run time: MemoryDenyWriteExecute would stop Node.js
MemoryDenyWriteExecute=no

[Install]
WantedBy=multi-user.target
`
}

/** per-install limits (abfleet limits apply); the template's values are the defaults */
export function limitsDropIn(l: Limits): string {
  return `# written by abfleet limits apply; do not edit
[Service]
MemoryHigh=${l.memoryHigh}
MemoryMax=${l.memoryMax}
CPUQuota=${l.cpuQuota}
CPUWeight=${l.cpuWeight}
TasksMax=${l.tasksMax}
LimitNOFILE=${l.nofile}
`
}

/** the properties `systemctl set-property --runtime` applies to a running install at once */
export function runtimeProperties(l: Limits): string[] {
  return [`MemoryHigh=${l.memoryHigh}`, `MemoryMax=${l.memoryMax}`, `CPUQuota=${l.cpuQuota}`, `CPUWeight=${l.cpuWeight}`, `TasksMax=${l.tasksMax}`]
}

/**
 * /run/appbuilder/<id>: created at every boot by systemd-tmpfiles, owned by the install, group caddy, setgid: the
 * socket the server creates in it belongs to group caddy, so Caddy (and no other install) can connect.
 */
export function tmpfilesLine(p: FleetPaths, id: string): string {
  return `# Appbuilder fleet install ${id} (written by abfleet)\nd ${p.run} 0755 root root -\nd ${p.run}/${id} 2750 ab-${id} caddy -\n`
}

/** Caddy's base config: the fleet's sites, the licence service, and nothing for any other host name */
export function caddyBase(p: FleetPaths, c: FleetConfig): string {
  const globals = [
    '\tadmin localhost:2019',
    ...(c.acmeEmail ? [`\temail ${c.acmeEmail}`] : []),
    ...(c.tls === 'internal' ? ['\tlocal_certs', '\tskip_install_trust'] : []),
  ]
  const licence = c.licence.enabled ? `
licence.${c.domain} {
${c.tls === 'internal' ? '\ttls internal\n' : ''}\theader Strict-Transport-Security "max-age=31536000"
\trequest_body {
\t\tmax_size 64KB
\t}
\treverse_proxy ${c.licence.host}:${c.licence.port} {
\t\theader_up Host {host}
\t\theader_up -X-Forwarded-Host
\t}
}
` : ''
  return `# Appbuilder fleet reverse proxy (written by abfleet init; re-running it rewrites this file)
{
${globals.join('\n')}
}

import ${p.caddySites}/*.caddy
${licence}
# every other host name: no route to any install
http:// {
\trespond "Not found" 404
}
`
}

/** one organisation's site (spec section 3): exact host, canonical Host only, X-Forwarded-Host dropped */
export function caddySite(p: FleetPaths, c: FleetConfig, org: OrgRecord): string {
  const up = c.listen === 'socket' ? `unix/${orgPaths(p, org.id).socket}` : `127.0.0.1:${org.port}`
  return `# ${org.id} (written by abfleet; do not edit)
${org.host} {
${c.tls === 'internal' ? '\ttls internal\n' : ''}\theader Strict-Transport-Security "max-age=31536000"
\trequest_body {
\t\tmax_size 60MB
\t}
\treverse_proxy ${up} {
\t\theader_up Host {host}
\t\theader_up -X-Forwarded-Host
\t}
}
`
}

/** a stopped organisation: Caddy answers with a notice, nothing is proxied */
export function caddyNotice(c: FleetConfig, org: OrgRecord): string {
  return `# ${org.id} stopped by the operator (written by abfleet suspend --stop)
${org.host} {
${c.tls === 'internal' ? '\ttls internal\n' : ''}\theader Retry-After "3600"
\trespond "This Appbuilder is paused by its operator. Please contact your administrator." 503
}
`
}

export interface EnvInput {
  paths: FleetPaths
  config: FleetConfig
  org: OrgRecord
  limits: Limits
  /** true when a licence key file exists for the install */
  licensed: boolean
}

/** the install's environment (root:ab-<id> 0640): every hosted setting, the locked public address */
export function instanceEnv(i: EnvInput): string {
  const { paths: p, config: c, org, limits: l } = i
  const op = orgPaths(p, org.id)
  const deny = [`*.${c.domain}`, ...c.outboundDenyExtra].join(',')
  const vars: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    APPBUILDER_HOSTED: '1',
    APPBUILDER_PUBLIC_URL: `https://${org.host}`,
    APPBUILDER_ALLOWED_HOSTS: org.host,
    APPBUILDER_INSTANCE_DIR: op.dir,
    APPBUILDER_WORKSPACE: op.workspace,
    APPBUILDER_BACKUP_DIR: op.backups,
    APPBUILDER_SETUP: 'closed',
    APPBUILDER_DB_POOL: '6',
    APPBUILDER_JOBS_POLL_MS: '5000',
    APPBUILDER_OUTBOUND_PRIVATE: 'deny',
    APPBUILDER_OUTBOUND_DENY: deny,
    APPBUILDER_TRUST_PROXY: '1',
    APPBUILDER_SECURE_COOKIE: '1',
    APPBUILDER_SHUTDOWN_MS: '15000',
    ...(c.listen === 'socket' ? { APPBUILDER_SOCKET: op.socket, APPBUILDER_SOCKET_MODE: '660' } : { PORT: String(org.port), APPBUILDER_HOST: '127.0.0.1' }),
    APPBUILDER_PG_BIN: c.pgBin || undefined,
    APPBUILDER_OPERATOR_EMAIL: c.operatorEmail ?? undefined,
    ...(i.licensed && c.licence.enabled && org.licenceId ? {
      APPBUILDER_LICENCE_URL: c.licence.url,
      APPBUILDER_LICENCE_ID: org.licenceId,
      APPBUILDER_LICENCE_KEY_FILE: op.licenceKey,
      APPBUILDER_LICENCE_PUBLIC_KEY_FILE: c.licence.publicKeyFile ?? undefined,
    } : {}),
    NODE_OPTIONS: `--max-old-space-size=${l.heapMb}`,
    TMPDIR: p.mode === 'local' ? op.tmp : undefined,
  }
  return envFileText([`Appbuilder fleet install ${org.id} (${org.host}), written by abfleet: do not edit by hand.`, 'abfleet limits apply and abfleet secrets rotate rewrite it; changes take effect at the next restart.'], vars)
}

/** the licence service's environment (root:appbuilder-licence 0640; holds its database password) */
export function licenceEnv(c: FleetConfig, dbUrl: string, keyFile: string, passFile: string): string {
  return envFileText(['Appbuilder licence service (written by abfleet init)'], {
    APPBUILDER_LICENCE_DB_URL: dbUrl,
    APPBUILDER_LICENCE_SIGNING_KEY: keyFile,
    APPBUILDER_LICENCE_KEY_PASSPHRASE_FILE: passFile,
    APPBUILDER_LICENCE_HOST: c.licence.host,
    APPBUILDER_LICENCE_PORT: String(c.licence.port),
    APPBUILDER_LICENCE_TRUST_PROXY: '1',
  })
}

export function licenceUnit(p: FleetPaths): string {
  return `# Appbuilder licence service (written by abfleet init)
[Unit]
Description=Appbuilder licence service
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${LICENCE_USER}
Group=${LICENCE_USER}
EnvironmentFile=${p.licenceDir}/licence.env
ExecStart=${p.node} ${p.current}/server/licence-service/main.ts serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
InaccessiblePaths=-${p.instances} -${p.state} -${p.auditDir}
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallFilter=@system-service
MemoryDenyWriteExecute=no
MemoryMax=512M

[Install]
WantedBy=multi-user.target
`
}

export interface TimerSpec { name: string; description: string; calendar: string; args: string[]; randomDelay?: string }

/** the scheduled fleet jobs (systemd timers; abfleet runs them as root) */
export const TIMERS: TimerSpec[] = [
  { name: 'appbuilder-fleet-backup', description: 'nightly backup of every install, copied off the machine', calendar: '*-*-* 02:30:00', args: ['backup', 'run', '--all', '--scheduled'], randomDelay: '10min' },
  { name: 'appbuilder-fleet-restore-test', description: 'monthly restore test of one install into a scratch database', calendar: '*-*-01 04:00:00', args: ['backup', 'restore-test', '--random'] },
  { name: 'appbuilder-fleet-sweep', description: 'ends expired operator access (every 5 minutes)', calendar: '*:0/5', args: ['access', 'sweep'] },
  { name: 'appbuilder-fleet-summary', description: 'the daily summary for the operator (exceptions only)', calendar: '*-*-* 07:00:00', args: ['summary', '--send'] },
]

export function timerService(p: FleetPaths, t: TimerSpec): string {
  return `# written by abfleet init
[Unit]
Description=Appbuilder fleet: ${t.description}

[Service]
Type=oneshot
Environment=ABFLEET_ACTOR=timer:${t.name}
ExecStart=${p.node} ${path.posix.join(p.tool, 'abfleet.ts')} ${t.args.join(' ')}
`
}

export function timerUnit(t: TimerSpec): string {
  return `# written by abfleet init
[Unit]
Description=Appbuilder fleet timer: ${t.description}

[Timer]
OnCalendar=${t.calendar}
Persistent=true
${t.randomDelay ? `RandomizedDelaySec=${t.randomDelay}\n` : ''}
[Install]
WantedBy=timers.target
`
}

/** OnFailure= of the template unit: an install that keeps failing alerts the operator */
export function alertUnit(p: FleetPaths): string {
  return `# written by abfleet init
[Unit]
Description=Appbuilder fleet alert for %i

[Service]
Type=oneshot
Environment=ABFLEET_ACTOR=systemd:OnFailure
ExecStart=${p.node} ${path.posix.join(p.tool, 'abfleet.ts')} alert --unit %i
`
}

/** /usr/local/sbin/abfleet */
export function wrapperScript(p: FleetPaths): string {
  return `#!/bin/sh
# abfleet: the Appbuilder fleet tool (written by abfleet init). Run as root.
exec ${p.node} ${path.posix.join(p.tool, 'abfleet.ts')} "$@"
`
}
