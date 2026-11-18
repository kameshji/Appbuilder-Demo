/**
 * The server's file log (package L): every log() line also goes, as one JSON object per line, to
 * <workspace>/logs/appbuilder.log (or APPBUILDER_LOG_DIR), with the request and correlation id of the work it belongs to.
 * The file rotates by size (default 10 MB, 10 files kept: appbuilder.log, appbuilder.1.log ... appbuilder.9.log).
 * The console keeps its human-readable lines. Level: APPBUILDER_LOG_LEVEL, else the Admin console setting (ops.json in
 * the workspace), else info. Writes are synchronous: the server logs little (no access log) and a crash must not lose
 * the line that explains it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { setLogSink, type LogLevel } from '../util.ts'
import { currentWork } from '../work-context.ts'

export const LOG_LEVELS: LogLevel[] = ['info', 'warn', 'error']
const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }
export const LOG_FILE = 'appbuilder.log'

export interface LogEntry {
  /** ISO time */
  t: string
  l: LogLevel
  m: string
  /** request id / correlation id when the line belongs to a request or job */
  rid?: string
  cid?: string
  job?: string
}

export interface LogQuery {
  /** minimum level */
  level?: LogLevel
  from?: string
  to?: string
  /** case-insensitive text in the message or the request id */
  q?: string
  /** newest first; default 200, at most 5000 */
  limit?: number
}

export interface FileLog {
  dir: string
  level(): LogLevel
  setLevel(l: LogLevel): void
  write(level: LogLevel, msg: string): void
  /** log files, newest first, with sizes */
  files(): { name: string; bytes: number; modified: string }[]
  read(q?: LogQuery): { items: LogEntry[]; truncated: boolean; scannedFiles: number }
  /** the raw text of every log file, oldest first (for download) */
  readAllText(): string
  close(): void
}

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && (LOG_LEVELS as string[]).includes(v)

export function rotatedName(i: number): string {
  return i === 0 ? LOG_FILE : `appbuilder.${i}.log`
}

export function createFileLog(o: { dir: string; level?: LogLevel; maxBytes?: number; keep?: number }): FileLog {
  const dir = path.resolve(o.dir)
  const maxBytes = Math.max(64 * 1024, o.maxBytes ?? 10 * 1024 * 1024)
  const keep = Math.min(100, Math.max(2, o.keep ?? 10))
  let level: LogLevel = o.level ?? 'info'
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  const file = path.join(dir, LOG_FILE)
  let fd: number | null = null
  let size = 0
  const open = () => {
    fd = fs.openSync(file, 'a', 0o640)
    size = fs.fstatSync(fd).size
  }
  const rotate = () => {
    if (fd !== null) fs.closeSync(fd)
    fd = null
    fs.rmSync(path.join(dir, rotatedName(keep - 1)), { force: true })
    for (let i = keep - 2; i >= 0; i--) {
      const src = path.join(dir, rotatedName(i))
      if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, rotatedName(i + 1)))
    }
    open()
  }
  open()

  function write(l: LogLevel, msg: string): void {
    if (RANK[l] < RANK[level]) return
    const w = currentWork()
    // the first-run setup code stays on the console and in setup-code.txt; the log file is read by more people later
    const e: LogEntry = { t: new Date().toISOString(), l, m: msg.replace(/(setup code:?\s*)[A-Z0-9]{4}-?[A-Z0-9]{4}\b/gi, '$1(not logged)') }
    if (w.requestId) e.rid = w.requestId
    if (w.correlationId && w.correlationId !== w.requestId) e.cid = w.correlationId
    if (w.jobId) e.job = w.jobId
    const line = Buffer.from(JSON.stringify(e) + '\n', 'utf8')
    if (size > 0 && size + line.length > maxBytes) rotate()
    if (fd === null) open()
    fs.writeSync(fd!, line)
    size += line.length
  }

  function existing(): string[] {
    const out: string[] = []
    for (let i = 0; i < keep; i++) if (fs.existsSync(path.join(dir, rotatedName(i)))) out.push(rotatedName(i))
    return out
  }

  function read(q: LogQuery = {}): { items: LogEntry[]; truncated: boolean; scannedFiles: number } {
    const limit = Math.min(5000, Math.max(1, q.limit ?? 200))
    const min = q.level ? RANK[q.level] : 0
    const from = q.from ? Date.parse(q.from) : NaN
    const to = q.to ? Date.parse(q.to) : NaN
    const needle = (q.q ?? '').trim().toLowerCase()
    const items: LogEntry[] = []
    let scanned = 0
    for (const name of existing()) {
      scanned++
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line) continue
        let e: LogEntry
        try {
          e = JSON.parse(line) as LogEntry
        } catch {
          continue
        }
        if (!isLogLevel(e.l) || RANK[e.l] < min) continue
        const t = Date.parse(e.t)
        if (!Number.isNaN(to) && t > to) continue
        if (!Number.isNaN(from) && t < from) return { items, truncated: false, scannedFiles: scanned }
        if (needle && !String(e.m).toLowerCase().includes(needle) && !(e.rid ?? '').toLowerCase().includes(needle) && !(e.cid ?? '').toLowerCase().includes(needle)) continue
        items.push(e)
        if (items.length >= limit) return { items, truncated: true, scannedFiles: scanned }
      }
    }
    return { items, truncated: false, scannedFiles: scanned }
  }

  return {
    dir,
    level: () => level,
    setLevel(l) {
      if (isLogLevel(l)) level = l
    },
    write,
    files() {
      return existing().map((name) => {
        const st = fs.statSync(path.join(dir, name))
        return { name, bytes: st.size, modified: st.mtime.toISOString() }
      })
    },
    read,
    readAllText() {
      return existing().reverse().map((n) => {
        try {
          return fs.readFileSync(path.join(dir, n), 'utf8')
        } catch {
          return ''
        }
      }).join('')
    },
    close() {
      if (fd !== null) fs.closeSync(fd)
      fd = null
    },
  }
}

/* ------------------------------------------------------------------ the process-wide file log */

let active: FileLog | null = null

export function activeFileLog(): FileLog | null {
  return active
}

/** settings the Admin console stores (workspace/ops.json) */
export interface OpsSettings { logLevel?: LogLevel }

export function readOpsSettings(workspaceDir: string): OpsSettings {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'ops.json'), 'utf8')) as OpsSettings
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function writeOpsSettings(workspaceDir: string, s: OpsSettings): void {
  const file = path.join(workspaceDir, 'ops.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const logDirOf = (workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string => path.resolve(env.APPBUILDER_LOG_DIR || path.join(workspaceDir, 'logs'))

/** the level that applies: the environment variable wins over the stored setting */
export function effectiveLevel(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): { level: LogLevel; fromEnv: boolean } {
  if (isLogLevel(env.APPBUILDER_LOG_LEVEL)) return { level: env.APPBUILDER_LOG_LEVEL, fromEnv: true }
  const s = readOpsSettings(workspaceDir).logLevel
  return { level: isLogLevel(s) ? s : 'info', fromEnv: false }
}

/** server/main.ts: start writing log() lines to the rotating file (APPBUILDER_LOG_FILE=off disables it) */
export function startFileLogging(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): FileLog | null {
  if (env.APPBUILDER_LOG_FILE === 'off') return null
  try {
    const maxMb = Number(env.APPBUILDER_LOG_MAX_MB)
    const keep = Number(env.APPBUILDER_LOG_FILES)
    active = createFileLog({
      dir: logDirOf(workspaceDir, env),
      level: effectiveLevel(workspaceDir, env).level,
      ...(maxMb > 0 ? { maxBytes: maxMb * 1024 * 1024 } : {}),
      ...(keep > 0 ? { keep } : {}),
    })
    setLogSink((l, m) => active?.write(l, m))
    return active
  } catch (e) {
    process.stderr.write(`WARN file logging is off: ${e instanceof Error ? e.message : String(e)}\n`)
    return null
  }
}

export function stopFileLogging(): void {
  setLogSink(null)
  active?.close()
  active = null
}
