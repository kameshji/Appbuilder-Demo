/**
 * Install restore from the command line (disaster recovery onto a fresh machine; docs/admin/disaster-recovery.md):
 *
 *   node server/main.ts restore <archive.abbak> [options]
 *
 *   --workspace <dir>        the workspace folder to restore into (default: APPBUILDER_WORKSPACE or ./workspace)
 *   --passphrase-file <f>    passphrase of an encrypted archive (else APPBUILDER_BACKUP_PASSPHRASE, else asked)
 *   --key-file <f>           the install's .secret-key file kept apart from the backup (else the key in the archive, if any)
 *   --db-host/--db-port/--db-name/--db-user  the empty PostgreSQL database (password: APPBUILDER_DB_PASSWORD or asked);
 *                            default: APPBUILDER_DB_*, else the workspace's server.json
 *   --force                  replace Appbuilder schemas already in the database and environment folders already there
 *   --check                  only check the archive (checksums, row counts), change nothing
 *   --yes                    do not ask for confirmation
 *
 * The database must be empty of Appbuilder schemas (or --force). Everything runs in one transaction: a failure leaves
 * the database as it was. An older backup is brought to this version by the normal migration; a newer one is refused.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { DatabaseSettings } from '../contracts.ts'
import { envDatabase, loadConfig, readServerJson, writeServerJson } from '../config.ts'
import { createSecretBox, loadSecretKey } from '../secrets.ts'
import { createPgDb } from '../../connectors/postgres/db.ts'
import { SCHEMA_VERSION, createMetaStore } from '../meta-store.ts'
import { ArchiveError } from './archive.ts'
import { connect, extractEnvironmentFiles, openArchive, restoreSchema, verifyArchive, INSTALL_SCHEMA } from './engine.ts'
import { qi } from './dbdump.ts'

const HEX64 = /^[0-9a-fA-F]{64}$/

function out(line = ''): void {
  process.stdout.write(line + '\n')
}

function parse(argv: string[]): { file: string | null; o: Record<string, string | true> } {
  const o: Record<string, string | true> = {}
  let file: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (['force', 'check', 'yes', 'help'].includes(k)) o[k] = true
      else o[k] = argv[++i] ?? ''
    } else if (!file) file = a
  }
  return { file, o }
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      const w = (rl as unknown as { _writeToOutput?: (s: string) => void })
      w._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s) }
    }
    rl.question(question, (v) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(v)
    })
  })
}

const USAGE = `Usage: node server/main.ts restore <archive.abbak> [--workspace <dir>] [--passphrase-file <file>] [--key-file <file>]
         [--db-host <host> --db-port <port> --db-name <name> --db-user <user>] [--force] [--check] [--yes]
See docs/admin/disaster-recovery.md.`

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0]
  const { file, o } = parse(argv.slice(1))
  if (cmd !== 'restore' || o.help || !file) {
    out(USAGE)
    return o.help ? 0 : 2
  }
  try {
    return await restoreInstall(path.resolve(file), o)
  } catch (e) {
    out(`\nRESTORE FAILED: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

async function restoreInstall(file: string, o: Record<string, string | true>): Promise<number> {
  if (!fs.existsSync(file)) throw new Error(`There is no file ${file}.`)
  const env = process.env
  const config = loadConfig(env, typeof o.workspace === 'string' ? { workspaceDir: path.resolve(o.workspace) } : {})
  const ws = config.workspaceDir
  out(`Appbuilder install restore`)
  out(`  archive:   ${file}`)
  out(`  workspace: ${ws}`)
  // the archive
  let pass: string | null = null
  if (typeof o['passphrase-file'] === 'string') pass = fs.readFileSync(o['passphrase-file'], 'utf8').replace(/\r?\n$/, '')
  else if (env.APPBUILDER_BACKUP_PASSPHRASE) pass = env.APPBUILDER_BACKUP_PASSPHRASE
  let a
  try {
    a = await openArchive(file, pass, { workRoot: path.dirname(file) })
  } catch (e) {
    if (e instanceof ArchiveError && e.kind === 'needs-passphrase' && process.stdin.isTTY) {
      pass = await ask('Passphrase of the backup: ', true)
      a = await openArchive(file, pass, { workRoot: path.dirname(file) })
    } else throw e
  }
  try {
    const m = a.manifest
    out(`  made:      ${m.createdOn} by Appbuilder ${m.app.version} (schema version ${m.app.schemaVersion}), ${m.method}${m.pgDump ? ` ${m.pgDump.version}` : ''}, ${m.kind} backup`)
    out(`  contains:  ${m.environments.map((e) => `${e.name} (${e.tables.length} tables)`).join(', ')}${m.includesKey ? ', the encryption key' : ''}`)
    if (m.kind !== 'install') throw new Error('This is a backup of one environment. Restore it in the Admin console (Backups > Restore), as a new environment or in place.')
    const newest = Math.max(m.app.schemaVersion, ...m.environments.map((e) => e.schemaVersion))
    if (newest > SCHEMA_VERSION) throw new Error(`This backup was made by a newer Appbuilder (${m.app.version}, schema version ${newest}); this one knows schema version ${SCHEMA_VERSION}. Install that version or newer, then restore.`)
    out('\nChecking the archive (checksums of every file, rows counted again)...')
    const v = await verifyArchive(a)
    if (!v.ok) throw new Error(`The archive is damaged or was changed: ${v.errors.slice(0, 5).join(' ')}`)
    out(`  ok: ${v.files} files, ${(v.bytes / 1024 / 1024).toFixed(1)} MB${v.rows !== null ? `, ${v.rows.toLocaleString('en')} rows` : ''}${v.notes.length ? ` (${v.notes.join(' ')})` : ''}`)
    if (o.check) {
      out('\n--check: nothing was changed.')
      return 0
    }
    // the database
    let db: { settings: DatabaseSettings; password: string } | null = null
    if (typeof o['db-host'] === 'string' || typeof o['db-name'] === 'string') {
      const settings: DatabaseSettings = {
        host: String(o['db-host'] ?? '127.0.0.1'), port: Number(o['db-port']) || 5432, database: String(o['db-name'] ?? 'appbuilder'),
        user: String(o['db-user'] ?? 'appbuilder'), ssl: o['db-ssl'] === 'true',
      }
      let password = env.APPBUILDER_DB_PASSWORD ?? ''
      if (!password && process.stdin.isTTY) password = await ask(`Password of database user ${settings.user}: `, true)
      db = { settings, password }
    } else db = envDatabase(env)
    if (!db) {
      const sj = readServerJson(config).defaultConnection
      if (sj) {
        const box = createSecretBox(loadSecretKey(ws, env))
        db = { settings: { host: sj.host, port: Number(sj.port) || 5432, database: sj.database, user: sj.user, ssl: !!sj.ssl }, password: box.decrypt(sj.passwordSealed) }
      }
    }
    if (!db) throw new Error('Which database? Give --db-host, --db-name, --db-user (and APPBUILDER_DB_PASSWORD), or set APPBUILDER_DB_*.')
    out(`  database:  ${db.settings.user}@${db.settings.host}:${db.settings.port}/${db.settings.database}`)
    const c = await connect(db)
    try {
      const enc = await c.query<{ e: string }>("SELECT pg_catalog.current_setting('server_encoding') AS e")
      if (enc.rows[0].e.toUpperCase() !== 'UTF8') throw new Error(`The database uses the ${enc.rows[0].e} encoding; Appbuilder needs UTF8.`)
      const existing = (await c.query<{ n: string }>(`SELECT nspname AS n FROM pg_catalog.pg_namespace WHERE nspname = 'ab' OR nspname LIKE 'env\\_%' ORDER BY 1`)).rows.map((r) => r.n)
      if (existing.length && !o.force) throw new Error(`The database already holds Appbuilder schemas (${existing.join(', ')}). Use an empty database, or add --force to replace them.`)
      const folders = m.environments.map((e) => path.join(ws, 'env', e.id)).filter((d) => fs.existsSync(d))
      if (folders.length && !o.force) throw new Error(`The workspace already has environment folders (${folders.join(', ')}). Use an empty workspace, or add --force to replace them.`)
      // the encryption key
      const wsKeyFile = path.join(ws, '.secret-key')
      const wsKey = fs.existsSync(wsKeyFile) ? fs.readFileSync(wsKeyFile, 'utf8').trim() : null
      const fileKey = typeof o['key-file'] === 'string' ? fs.readFileSync(o['key-file'], 'utf8').trim() : null
      const archiveKey = m.includesKey ? (await a.buffer('key/secret-key')).toString('utf8').trim() : null
      for (const [k, what] of [[fileKey, '--key-file'], [archiveKey, 'the key in the archive']] as const) if (k && !HEX64.test(k)) throw new Error(`${what} is not a 64 hex character key.`)
      let keyPlan: string
      let writeKey: string | null = null
      if (env.APPBUILDER_SECRET_KEY) keyPlan = 'APPBUILDER_SECRET_KEY is set: that key is used (no key file is written).'
      else if (fileKey || archiveKey) {
        const k = (fileKey ?? archiveKey)!
        if (wsKey && wsKey !== k && !o.force) throw new Error(`The workspace already has a different .secret-key. Remove it, or add --force to replace it with ${fileKey ? 'the --key-file' : 'the key from the archive'}.`)
        writeKey = k
        keyPlan = `the encryption key ${fileKey ? 'from --key-file' : 'from the archive'} is restored to ${wsKeyFile}`
      } else if (wsKey) keyPlan = `the workspace's existing .secret-key is kept (it must be the install's original key for saved passwords to work)`
      else keyPlan = 'there is no key: a new one is created, and every saved secret (connection passwords and keys, the mail password, two-step verification secrets, the saved backup passphrase) must be entered again'
      out(`  key:       ${keyPlan}`)
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new Error('Add --yes to restore without being asked.')
        const yes = await ask(`\nRestore ${m.environments.length} environment(s) into ${db.settings.database}${existing.length ? ' (REPLACING what is there)' : ''}? Type yes: `)
        if (yes.trim().toLowerCase() !== 'yes') { out('Nothing was changed.'); return 1 }
      }
      // 1. the database: one transaction
      out('\nRestoring the database (one transaction)...')
      const started = Date.now()
      await c.query('BEGIN')
      try {
        for (const s of existing) await c.query(`DROP SCHEMA ${qi(s)} CASCADE`)
        for (const sc of m.schemas.slice().sort((x, y) => Number(y.name === INSTALL_SCHEMA) - Number(x.name === INSTALL_SCHEMA))) {
          const stored = await restoreSchema(c, a, sc.name, sc.name)
          out(`  ${sc.name}: ${stored.size} tables, ${[...stored.values()].reduce((x, y) => x + y, 0).toLocaleString('en')} rows`)
        }
        // nobody is signed in on the restored install; environments are usable again
        await c.query(`UPDATE "ab"."environments" SET state = 'ready', last_error = NULL WHERE state IN ('restoring', 'creating', 'deleting') AND schema_version > 0`).catch(() => {})
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      }
      out(`  done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      // 2. files
      out('Restoring attachments and data files...')
      for (const e of m.environments) {
        const dir = path.join(ws, 'env', e.id)
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
        const r = await extractEnvironmentFiles(a, e.id, dir)
        out(`  ${e.name}: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`)
      }
      // 3. the key and server.json
      fs.mkdirSync(ws, { recursive: true })
      if (writeKey) {
        fs.writeFileSync(wsKeyFile, writeKey + '\n', { mode: 0o600 })
        try { fs.chmodSync(wsKeyFile, 0o600) } catch { /* not POSIX */ }
        out(`The encryption key was restored to ${wsKeyFile}.`)
      } else if (!env.APPBUILDER_SECRET_KEY && !wsKey) out('Restored without the encryption key: a new key is created now.')
      const box = createSecretBox(loadSecretKey(ws, env))
      const prev = readServerJson(config)
      writeServerJson(config, { ...prev, defaultConnection: { ...db.settings, passwordSealed: box.encrypt(db.password) }, setupComplete: true })
      // 4. what the key can still open
      const lost = await unreadableSecrets(c, box.decrypt.bind(box))
      if (lost.total) {
        out(`\nSaved secrets that this key cannot decrypt: ${lost.unreadable} of ${lost.total}${lost.unreadable ? ` (${lost.where.join(', ')})` : ''}.`)
        if (lost.unreadable) out('  Data is complete; only these saved passwords and keys must be entered again (Connections, Settings > Mail, two-step verification set up again, the backup passphrase).')
      }
    } finally {
      await c.end().catch(() => {})
    }
    // 5. migrations (an older backup is upgraded like any older install)
    out('Bringing the database to this version...')
    const pool = createPgDb(db.settings, db.password)
    try {
      const sum = (await createMetaStore(pool, createSecretBox(loadSecretKey(ws, env))).migrate()) ?? { from: SCHEMA_VERSION, to: SCHEMA_VERSION, steps: [], environments: [] }
      out(`  schema version ${sum.from} -> ${sum.to}${sum.steps.length ? `: ${sum.steps.join('; ')}` : ''}`)
      const failed = (sum.environments ?? []).filter((e) => !e.ok)
      for (const f of failed) out(`  ENVIRONMENT ${f.id} NOT AVAILABLE: ${f.error}`)
    } finally {
      await pool.close().catch(() => {})
    }
    out(`\nRestore complete. Start the server (npm start or start.ps1) and sign in with an account from the backup.`)
    out('Everybody signs in again (sessions are not part of a backup).')
    return 0
  } finally {
    await a.close()
  }
}

/** sealed values (v1:...) in schema ab and in every environment's connections, and how many this key opens */
async function unreadableSecrets(c: import('pg').Client, decrypt: (s: string) => string): Promise<{ total: number; unreadable: number; where: string[] }> {
  const cols = await c.query<{ s: string; t: string; col: string }>(
    `SELECT table_schema AS s, table_name AS t, column_name AS col FROM information_schema.columns
      WHERE (table_schema = 'ab' OR (table_schema LIKE 'env\\_%' AND table_name = 'ab_connections')) AND data_type IN ('text', 'character varying')`)
  let total = 0
  let unreadable = 0
  const where = new Set<string>()
  for (const x of cols.rows) {
    const r = await c.query<{ v: string; id: string | null }>(`SELECT ${qi(x.col)} AS v FROM ${qi(x.s)}.${qi(x.t)} WHERE ${qi(x.col)} LIKE 'v1:%:%:%'`).catch(() => ({ rows: [] as { v: string }[] }))
    for (const row of r.rows) {
      // the default connection's password is written again from server.json at every start
      if (x.t === 'ab_connections' && x.col === 'secret_sealed') {
        const isDefault = await c.query(`SELECT 1 FROM ${qi(x.s)}."ab_connections" WHERE secret_sealed = $1 AND id = 'conn_default'`, [row.v])
        if (isDefault.rowCount) continue
      }
      total++
      try {
        decrypt(row.v)
      } catch {
        unreadable++
        where.add(`${x.s}.${x.t}.${x.col}`)
      }
    }
    // sealed values inside JSON settings (backup passphrase, mail settings)
    if (x.s === 'ab' && x.t === 'settings' && x.col === 'v') {
      const j = await c.query<{ v: string }>(`SELECT v FROM "ab"."settings" WHERE v LIKE '%"v1:%'`)
      for (const row of j.rows) {
        for (const mm of row.v.matchAll(/"(v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*)"/g)) {
          total++
          try { decrypt(mm[1]) } catch { unreadable++; where.add('ab.settings') }
        }
      }
    }
  }
  return { total, unreadable, where: [...where] }
}
