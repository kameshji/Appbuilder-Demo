/**
 * Operations API shapes (package L), shared by the server (server/core/diagnostics, server/core/update) and the Admin
 * console pages Server logs, Usage and Updates. No runtime imports: the server imports this file too.
 *
 *   GET  /api/v1/health                      anyone: { status } only (200 when ok, 503 otherwise)
 *   GET  /api/v1/admin/health                install administrators: DetailedHealth
 *   GET  /api/v1/admin/logs                  install administrators: LogPage (?level=&from=&to=&q=&limit=)
 *   GET  /api/v1/admin/logs/download         install administrators: the log files as text (redacted)
 *   PUT  /api/v1/admin/logs/settings         install administrators: { level }
 *   GET  /api/v1/admin/usage                 install administrators: UsageReport
 *   POST /api/v1/admin/diagnostics           install administrators: a diagnostics bundle (ZIP, secrets redacted)
 *   GET  /api/v1/admin/updates               install administrators: UpdatesInfo
 *   POST /api/v1/admin/updates/upload        install administrators: a release ZIP (raw body) -> StagedUpdate
 *   DELETE /api/v1/admin/updates/staged      install administrators: discards the staged package
 */

export type HealthStatus = 'ok' | 'starting' | 'degraded'
export interface PublicHealth { status: HealthStatus }

export type CheckStatus = 'ok' | 'warn' | 'error'
export interface HealthCheck { key: string; label: string; status: CheckStatus; message: string }

export interface VersionInfo {
  app: string
  /** git commit of the release, "dev" when run from a source folder */
  commit: string
  built: string | null
  node: string
  platform: string
  arch: string
  postgres?: string
  schema: { server: number; database?: number }
  /** the install folder layout when installed by the installers (null when run from source) */
  installRoot: string | null
}

export interface DetailedHealth {
  status: HealthStatus
  checkedAt: string
  checks: HealthCheck[]
  versions: VersionInfo
  database: { configured: boolean; reachable: boolean; latencyMs?: number; location?: string | null; error?: string }
  environments: { id: string; name: string; state: string; schemaVersion: number | null }[]
  disk: { label: string; path: string; freeBytes: number; totalBytes: number }[]
  backups: { enabled: boolean; lastOkAt: string | null; ageHours: number | null; stale: boolean; message: string } | null
  jobs: { queued: number; running: number; failed: number; dead: number; failures24h: number; oldestQueuedSeconds: number; outboxPending: number } | null
  live: { connections: number; users: number }
  mail: { configured: boolean }
  clock: { serverTime: string; databaseTime?: string; skewMs?: number }
  process: { pid: number; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number }
  logs: { dir: string | null; level: LogLevelName; levelFromEnv: boolean; bytes: number }
}

export type LogLevelName = 'info' | 'warn' | 'error'
export interface LogLine { t: string; l: LogLevelName; m: string; rid?: string; cid?: string; job?: string }
export interface LogPage {
  items: LogLine[]
  /** more lines match than were returned */
  truncated: boolean
  level: LogLevelName
  levelFromEnv: boolean
  files: { name: string; bytes: number; modified: string }[]
  /** false when file logging is off (APPBUILDER_LOG_FILE=off, or the dev server) */
  enabled: boolean
}

export interface UsageReport {
  generatedAt: string
  users: { total: number; active: number; disabled: number; serviceAccounts: number; signedIn: { day: number; week: number; month: number }; onlineNow: number }
  storage: { databaseBytes: number | null; workspaceBytes: number; attachmentsBytes: number; filesBytes: number; backupsBytes: number; logsBytes: number }
  environments: {
    id: string
    name: string
    schemaBytes: number
    tables: { name: string; system: boolean; rows: number; approximate: boolean; bytes: number }[]
    jobs: { succeeded24h: number; failed24h: number; dead: number; queued: number; byType: { type: string; succeeded24h: number; failed24h: number }[] } | null
  }[]
}

export type SignatureState = 'valid' | 'unsigned' | 'untrusted' | 'invalid'
export interface StagedUpdate {
  version: string
  commit: string
  built: string
  schemaVersion: number
  node: string
  files: number
  checksums: 'ok' | 'failed'
  signature: { state: SignatureState; keyId?: string; reason?: string }
  /** may be applied with the update command (checksums ok, and signed by a trusted key or the install trusts no keys) */
  applicable: boolean
  problems: string[]
  releaseNotes: string
  stagedAt: string
  /** where the package was unpacked (the update command takes it with --staged) */
  folder: string
}

export interface UpdateHistoryEntry {
  at: string
  from: string
  to: string
  result: 'updated' | 'rolled-back' | 'failed'
  message: string
  backup?: string | null
}

export interface UpdatesInfo {
  current: { version: string; commit: string; built: string | null; schemaVersion: number; trustedKeys: { id: string; comment?: string }[] }
  installed: boolean
  staged: StagedUpdate | null
  history: UpdateHistoryEntry[]
  /** the command an administrator runs on the server to apply the staged package */
  applyCommand: string | null
}
