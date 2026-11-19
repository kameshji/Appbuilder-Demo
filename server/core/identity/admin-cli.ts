/**
 * Offline recovery of administrator access (docs/admin/sign-in-and-identity.md "Locked out", docs/admin/disaster-recovery.md).
 * For the sole administrator who lost their password or second factor: run on the server machine, with access to the
 * workspace (the secret key and server.json), the same trust level as the first-run setup code.
 *
 *   appbuilder admin list                         install administrators and environment administrators
 *   appbuilder admin reset-password <email>       prints a one-time reset code (15 minutes; never a password)
 *   appbuilder admin reset-mfa <email>            removes the person's two-step verification; their sessions end
 *   appbuilder admin make-install-admin <email>   makes an active account an install administrator (and enables it)
 *
 * Works whether the server runs or not (it talks to the database directly; sessions live there). Refuses without the
 * workspace's secret key (it never creates one) and without a database login. Every change goes to the install audit
 * with source "cli" and the operating-system user name. WARNING: anyone with administrator rights on this computer can
 * do this, as they can already read the database; protect the machine and the workspace folder accordingly.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SqlDb } from '../contracts.ts'
import { envDatabase, loadConfig, readServerJson } from '../config.ts'
import { createSecretBox, loadSecretKey } from '../secrets.ts'
import { createPgDb } from '../../connectors/postgres/db.ts'
import { normaliseCode, randomCode, sha256 } from './util.ts'
import { uid } from '../util.ts'

export const ADMIN_CLI_RESET_TTL_MS = 15 * 60 * 1000

type Row = Record<string, unknown>
export interface AdminCliIo { out(line: string): void; err(line: string): void }
const stdio: AdminCliIo = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }

const USAGE = [
  'Usage: appbuilder admin <command>',
  '  list                         install and environment administrators',
  '  reset-password <email>       a one-time reset code (15 minutes) to type on the sign-in screen ("I have a reset code")',
  '  reset-mfa <email>            remove two-step verification of the person (their sessions end)',
  '  make-install-admin <email>   make an account an install administrator',
  'Run it on the server machine, as a user who can read the workspace folder (its secret key and server.json).',
]

/** the workspace's secret key, without creating one (refuse instead) */
function requireKey(workspaceDir: string, env: NodeJS.ProcessEnv): Buffer {
  if (env.APPBUILDER_SECRET_KEY) return loadSecretKey(workspaceDir, env)
  const file = path.join(workspaceDir, '.secret-key')
  try {
    fs.accessSync(file, fs.constants.R_OK)
  } catch {
    throw new Error(`Cannot read the workspace's secret key (${file}). Run this on the server machine as a user who can read the workspace folder (for an installed server: as administrator / root), or set APPBUILDER_WORKSPACE.`)
  }
  return loadSecretKey(workspaceDir, env)
}

function login(workspaceDir: string, env: NodeJS.ProcessEnv): { db: SqlDb; where: string } {
  const key = requireKey(workspaceDir, env)
  const fromEnv = envDatabase(env)
  if (fromEnv) return { db: createPgDb(fromEnv.settings, fromEnv.password, { max: 1, onError: () => {} }), where: `${fromEnv.settings.host}:${fromEnv.settings.port}/${fromEnv.settings.database}` }
  const sj = readServerJson(loadConfig(env)).defaultConnection
  if (!sj) throw new Error(`There is no database login in ${path.join(workspaceDir, 'server.json')} (has the setup run?).`)
  let password = ''
  try {
    password = sj.passwordSealed ? createSecretBox(key).decrypt(sj.passwordSealed) : ''
  } catch {
    throw new Error('The saved database password cannot be decrypted with this workspace\'s secret key.')
  }
  return { db: createPgDb({ host: sj.host, port: Number(sj.port) || 5432, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password, { max: 1, onError: () => {} }), where: `${sj.host}:${sj.port}/${sj.database}` }
}

function osUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown'
  }
}

async function audit(db: SqlDb, userId: string | null, action: string, details: Record<string, unknown>): Promise<void> {
  await db.exec(`INSERT INTO "ab"."audit" (at, user_id, action, environment_id, details) VALUES ($1, $2, $3, NULL, $4::jsonb)`, [new Date(), userId, action, JSON.stringify({ ...details, source: 'cli', osUser: osUser(), host: os.hostname() })])
}

async function userByEmail(db: SqlDb, email: string): Promise<Row | null> {
  const r = await db.query<Row>(`SELECT id, name, email, status, is_install_admin, COALESCE(kind, 'person') AS kind FROM "ab"."users" WHERE lower(email) = lower($1)`, [email.trim()])
  return r[0] ?? null
}

export async function runAdminCli(argv: string[], o: { env?: NodeJS.ProcessEnv; io?: AdminCliIo } = {}): Promise<number> {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const [cmd, arg] = argv
  if (!cmd || cmd === 'help' || cmd === '--help') {
    for (const l of USAGE) io.out(l)
    return cmd ? 0 : 64
  }
  if (!['list', 'reset-password', 'reset-mfa', 'make-install-admin'].includes(cmd)) {
    io.err(`Unknown command "admin ${cmd}".`)
    for (const l of USAGE) io.err(l)
    return 64
  }
  if (cmd !== 'list' && !arg) {
    io.err(`appbuilder admin ${cmd} needs the person's email address.`)
    return 64
  }
  const config = loadConfig(env)
  let conn: { db: SqlDb; where: string }
  try {
    conn = login(config.workspaceDir, env)
  } catch (e) {
    io.err(`REFUSED: ${e instanceof Error ? e.message : String(e)}`)
    return 77
  }
  const { db } = conn
  try {
    await db.query('SELECT 1')
    if (cmd === 'list') {
      const rows = await db.query<Row>(
        `SELECT u.email, u.name, u.status, u.is_install_admin, (m.user_id IS NOT NULL) AS mfa,
                COALESCE((SELECT string_agg(a.environment_id, ', ' ORDER BY a.environment_id) FROM "ab"."environment_access" a WHERE a.user_id = u.id AND a.is_env_admin), '') AS env_admin
           FROM "ab"."users" u LEFT JOIN "ab"."user_mfa" m ON m.user_id = u.id
          WHERE u.is_install_admin OR EXISTS (SELECT 1 FROM "ab"."environment_access" a WHERE a.user_id = u.id AND a.is_env_admin)
          ORDER BY u.is_install_admin DESC, lower(u.email)`,
      ).catch(async () => db.query<Row>(`SELECT email, name, status, is_install_admin, false AS mfa, '' AS env_admin FROM "ab"."users" WHERE is_install_admin ORDER BY lower(email)`))
      // environment administrator roles (roles with is_admin in each environment schema)
      const envs = await db.query<Row>(`SELECT id, schema_name FROM "ab"."environments" WHERE state = 'ready' ORDER BY built_in DESC, id`)
      const roleAdmins = new Map<string, string[]>()
      for (const e of envs) {
        const r = await db.query<Row>(`SELECT DISTINCT u.email FROM "${String(e.schema_name).replace(/"/g, '')}"."ab_user_roles" ur JOIN "${String(e.schema_name).replace(/"/g, '')}"."ab_roles" ro ON ro.id = ur.role_id AND ro.is_admin JOIN "ab"."users" u ON u.id = ur.user_id`).catch(() => [])
        for (const x of r) roleAdmins.set(String(x.email), [...(roleAdmins.get(String(x.email)) ?? []), String(e.id)])
      }
      io.out(`Administrators (database ${conn.where}):`)
      const seen = new Set<string>()
      for (const r of rows) {
        seen.add(String(r.email))
        const envAdmin = [...new Set([...String(r.env_admin || '').split(', ').filter(Boolean), ...(roleAdmins.get(String(r.email)) ?? [])])]
        io.out(`  ${String(r.email)}  ${String(r.name)}  ${r.is_install_admin ? 'install administrator' : ''}${envAdmin.length ? `${r.is_install_admin ? '; ' : ''}administrator in ${envAdmin.join(', ')}` : ''}  [${String(r.status)}${r.mfa ? ', two-step verification on' : ''}]`)
      }
      for (const [email, list] of roleAdmins) {
        if (seen.has(email)) continue
        io.out(`  ${email}  administrator in ${list.join(', ')}`)
      }
      if (!rows.length && !roleAdmins.size) io.out('  (none)')
      return 0
    }
    const u = await userByEmail(db, arg)
    if (!u) {
      io.err(`There is no account with the email ${arg}.`)
      return 1
    }
    if (u.kind === 'service') {
      io.err(`${String(u.email)} is a service account: it has no password or two-step verification to recover.`)
      return 1
    }
    if (cmd === 'reset-password') {
      // the same one-time code an install administrator can create in the Admin console, but valid 15 minutes
      // stored exactly like identity/index.ts createToken (kind 'reset', hash of the normalised code): one live code
      const code = randomCode(12)
      const t = { expiresOn: new Date(Date.now() + ADMIN_CLI_RESET_TTL_MS) }
      await db.tx(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`auth_token:reset:${String(u.id)}`])
        await tx.exec(`UPDATE "ab"."auth_tokens" SET used_on = now() WHERE user_id = $1 AND kind = 'reset' AND used_on IS NULL`, [u.id])
        await tx.exec(
          `INSERT INTO "ab"."auth_tokens" (id, kind, user_id, token_hash, created_on, expires_on, created_by, data) VALUES ($1, 'reset', $2, $3, $4, $5, NULL, $6::jsonb)`,
          [uid('tok'), u.id, sha256(`reset:${normaliseCode(code)}`), new Date(), t.expiresOn, JSON.stringify({ via: 'cli' })],
        )
        await audit(tx, String(u.id), 'install.cli_reset_code', { email: u.email, expiresOn: t.expiresOn.toISOString() })
      })
      io.out(`One-time reset code for ${String(u.email)}: ${code}`)
      io.out(`Valid until ${t.expiresOn.toISOString().slice(0, 16).replace('T', ' ')} UTC (15 minutes), once. On the sign-in screen choose "Forgot password?", then "I have a reset code", and type the email and this code.`)
      if (u.status === 'disabled') io.out('NOTE: this account is disabled; an administrator must enable it (or use make-install-admin) before it can sign in.')
      return 0
    }
    if (cmd === 'reset-mfa') {
      await db.tx(async (tx) => {
        await tx.exec(`DELETE FROM "ab"."user_mfa" WHERE user_id = $1`, [u.id])
        await tx.exec(`DELETE FROM "ab"."trusted_devices" WHERE user_id = $1`, [u.id]).catch(() => {})
        await tx.exec(`DELETE FROM "ab"."sessions" WHERE user_id = $1`, [u.id])
        await audit(tx, String(u.id), 'install.cli_mfa_reset', { email: u.email })
      })
      io.out(`Two-step verification of ${String(u.email)} was removed and their sessions ended. They sign in with their password and set it up again (if the policy requires it).`)
      return 0
    }
    // make-install-admin
    await db.tx(async (tx) => {
      await tx.exec(`UPDATE "ab"."users" SET is_install_admin = true, status = 'active' WHERE id = $1`, [u.id])
      await audit(tx, String(u.id), 'install.cli_make_admin', { email: u.email, wasInstallAdmin: !!u.is_install_admin, wasDisabled: u.status === 'disabled' })
    })
    io.out(`${String(u.email)} is now an install administrator${u.status === 'disabled' ? ' (the account was disabled and is enabled now)' : ''}.`)
    return 0
  } catch (e) {
    io.err(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    await db.close().catch(() => {})
  }
}

/**
 * `appbuilder setup-code`: prints the first-run setup code of an installed server (a service writes it to the file named
 * by APPBUILDER_SETUP_CODE_FILE in its environment file; reading it needs the same rights as that file).
 */
export function runSetupCodeCli(o: { env?: NodeJS.ProcessEnv; io?: AdminCliIo } = {}): number {
  const env = o.env ?? process.env
  const io = o.io ?? stdio
  const file = env.APPBUILDER_SETUP_CODE_FILE
  if (!file) {
    io.err('This server is not installed as a service: it prints the setup code in the window where it runs.')
    return 1
  }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    io.err(code === 'ENOENT'
      ? 'There is no setup code: the first administrator exists already (sign in, or use "appbuilder admin" if you are locked out), or the service is not running.'
      : `Cannot read ${file}: run this as administrator (Windows) or with sudo (Linux).`)
    return 1
  }
  const code = text.split(/\r?\n/)[0].trim()
  io.out(`Setup code: ${code}`)
  io.out('Type it in the setup screen on this computer (http://localhost:<port>/). It changes every time the service starts.')
  return 0
}
