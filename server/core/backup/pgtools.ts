/**
 * Finding pg_dump and pg_restore (docs/admin/backup-and-restore.md "PostgreSQL tools"). Searched in order: the folder
 * set in the backup settings, APPBUILDER_PG_BIN, every folder on PATH, then the usual install folders of each platform
 * (newest version first). A tool is usable when its major version is at least the server's: an older pg_dump refuses
 * a newer server, and pg_restore cannot read archives of a newer pg_dump. When none is usable the backup falls back to
 * the built-in exporter (dbdump.ts), which needs no external program.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { DatabaseSettings } from '../contracts.ts'

export interface PgTool { path: string; version: string; major: number }
export interface PgTools { dump: PgTool | null; restore: PgTool | null; searched: string[] }

const EXE = process.platform === 'win32' ? '.exe' : ''

function versionDirs(globParent: string, pattern: RegExp, sub: string): string[] {
  try {
    return fs.readdirSync(globParent)
      .filter((n) => pattern.test(n))
      .sort((a, b) => (parseFloat(b.replace(/[^\d.]/g, '')) || 0) - (parseFloat(a.replace(/[^\d.]/g, '')) || 0))
      .map((n) => path.join(globParent, n, sub))
  } catch {
    return []
  }
}

/** candidate folders, most specific first */
export function candidateDirs(configured: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  if (configured) dirs.push(configured)
  if (env.APPBUILDER_PG_BIN) dirs.push(env.APPBUILDER_PG_BIN)
  for (const p of (env.PATH ?? env.Path ?? '').split(path.delimiter)) if (p) dirs.push(p)
  if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']) {
      dirs.push(...versionDirs(path.join(root, 'PostgreSQL'), /^\d+(\.\d+)?$/, 'bin'))
    }
  } else {
    dirs.push(...versionDirs('/usr/lib/postgresql', /^\d+$/, 'bin'))
    dirs.push(...versionDirs('/usr', /^pgsql-\d+$/, 'bin'))
    dirs.push(...versionDirs('/opt/homebrew/opt', /^postgresql@\d+$/, 'bin'))
    dirs.push(...versionDirs('/usr/local/opt', /^postgresql@\d+$/, 'bin'))
    dirs.push(...versionDirs('/Applications/Postgres.app/Contents/Versions', /^\d+$/, 'bin'))
    dirs.push('/usr/local/pgsql/bin', '/opt/homebrew/bin', '/usr/local/bin')
  }
  return [...new Set(dirs.map((d) => path.resolve(d)))]
}

function toolVersion(file: string): Promise<PgTool | null> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(String(stdout))
      if (!m) return resolve(null)
      resolve({ path: file, version: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1], major: Number(m[1]) })
    })
  })
}

let cache: { key: string; at: number; tools: PgTools } | null = null

/** the newest pg_dump and pg_restore found (cached for a minute; force: search again) */
export async function findPgTools(configured?: string | null, o: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): Promise<PgTools> {
  const env = o.env ?? process.env
  const key = `${configured ?? ''}|${env.APPBUILDER_PG_BIN ?? ''}|${env.PATH ?? ''}`
  if (!o.force && cache && cache.key === key && Date.now() - cache.at < 60_000) return cache.tools
  const searched = candidateDirs(configured, env)
  const pick = async (name: string): Promise<PgTool | null> => {
    let best: PgTool | null = null
    const seen = new Set<string>()
    for (const d of searched) {
      const f = path.join(d, name + EXE)
      let real: string
      try {
        if (!fs.statSync(f).isFile()) continue
        real = fs.realpathSync(f)
      } catch {
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      const t = await toolVersion(f)
      // the configured folder wins when it has the tool at all; otherwise the newest version
      if (t && configured && path.resolve(configured) === d) return t
      if (t && (!best || t.major > best.major)) best = t
    }
    return best
  }
  const tools = { dump: await pick('pg_dump'), restore: await pick('pg_restore'), searched }
  cache = { key, at: Date.now(), tools }
  return tools
}

/** why a tool cannot be used against a server of this major version (null: it can) */
export function toolProblem(tool: PgTool | null, name: 'pg_dump' | 'pg_restore', serverMajor: number): string | null {
  if (!tool) return `${name} was not found (set the PostgreSQL tools folder in the backup settings, or APPBUILDER_PG_BIN)`
  if (tool.major < serverMajor) return `${name} ${tool.version} at ${tool.path} is older than the database server (PostgreSQL ${serverMajor})`
  return null
}

/** environment for a child process: the password travels in PGPASSWORD, never on the command line */
export function pgEnv(s: DatabaseSettings, password: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'appbuilder-backup' }
  if (s.ssl) env.PGSSLMODE = 'require'
  delete env.PGSERVICE
  return env
}

export function connArgs(s: DatabaseSettings): string[] {
  return ['--host', s.host, '--port', String(s.port), '--username', s.user, '--dbname', s.database, '--no-password']
}

/** runs a tool; resolves when it exits 0, rejects with its stderr otherwise */
export function runTool(file: string, args: string[], env: NodeJS.ProcessEnv, o: { stdin?: NodeJS.ReadableStream; signal?: AbortSignal } = {}): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(file, args, { env, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, signal: o.signal })
  let err = ''
  child.stderr!.on('data', (d: Buffer) => { if (err.length < 8000) err += d.toString() })
  if (o.stdin && child.stdin) {
    o.stdin.pipe(child.stdin)
    child.stdin.on('error', () => {})
  }
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, sig) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(file)} failed (${sig ?? `exit ${code}`}): ${err.trim().split('\n').slice(-3).join(' ') || 'no message'}`))
    })
  })
  return { child, done }
}
