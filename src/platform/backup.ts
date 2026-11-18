/**
 * Backup and restore API shapes (P0 package J), shared by the server (server/core/backup/) and the Admin console
 * (src/portal/AdminBackups.tsx). Routes: docs/dev/data-api.md "Backups". Install administrators only.
 *
 *   GET    /api/v1/backups                         -> BackupsResponse
 *   POST   /api/v1/backups                         { scope, includeKey?, passphrase?, note? } -> BackupInfo (queued)
 *   GET    /api/v1/backups/health                  -> BackupHealth
 *   GET    /api/v1/backups/settings                -> BackupSettings
 *   PUT    /api/v1/backups/settings                BackupSettingsInput -> BackupSettings
 *   GET    /api/v1/backups/:id                     -> BackupDetails
 *   PATCH  /api/v1/backups/:id                     { pinned?, note? } -> BackupInfo
 *   DELETE /api/v1/backups/:id                     -> { ok }
 *   POST   /api/v1/backups/:id/verify              { passphrase? } -> BackupOp
 *   GET    /api/v1/backups/:id/download            (re-authentication) -> the archive
 *   POST   /api/v1/backups/upload?name=            raw body (streamed) -> BackupInfo
 *   POST   /api/v1/backups/:id/contents            { passphrase? } -> BackupContents (needs the passphrase when encrypted)
 *   POST   /api/v1/backups/:id/browse              { environment, table, offset?, limit?, passphrase? } -> BackupRowsPage
 *   POST   /api/v1/backups/:id/restore             RestoreRequest -> BackupOp
 *   POST   /api/v1/backups/:id/restore-tables/plan TableRestoreRequest -> TableRestorePlan
 *   POST   /api/v1/backups/:id/restore-tables      TableRestoreRequest & { confirm } -> BackupOp
 *   GET    /api/v1/backups/ops/:id                 -> BackupOp
 *   POST   /api/v1/backups/restore-test            -> BackupOp (runs the restore test now)
 */

export type BackupKind = 'install' | 'environment'
export type BackupTrigger = 'manual' | 'schedule' | 'pre-upgrade' | 'pre-delete' | 'pre-restore' | 'pre-migration' | 'upload'
/** queued/running/verifying: in progress; ok: verified; failed; missing: the file is gone; uploaded: waits for its passphrase */
export type BackupState = 'queued' | 'running' | 'verifying' | 'ok' | 'failed' | 'missing' | 'uploaded'

export interface BackupProgress { phase: string; done: number; total: number; message?: string; at?: string }

export interface BackupSummary {
  environments: { id: string; name: string; type: string; tables: number; rows: number; attachments: number; attachmentBytes: number; dataFiles: number; schemaVersion: number }[]
  /** rows of every table (all schemas) */
  rows: number
  warnings: string[]
  pgDump?: string
  server?: string
}

export interface BackupInfo {
  id: string
  fileName: string
  kind: BackupKind
  environmentId?: string
  environmentName?: string
  trigger: BackupTrigger
  state: BackupState
  method?: 'pg_dump' | 'builtin'
  encrypted: boolean
  includesKey: boolean
  sizeBytes?: number
  sha256?: string
  createdOn: string
  finishedOn?: string
  createdBy?: { id: string; name: string } | null
  appVersion?: string
  schemaVersion?: number
  summary?: BackupSummary
  error?: string
  verifiedOn?: string
  verifyError?: string
  restoreTestedOn?: string
  restoreTestError?: string
  offsite?: { state: 'ok' | 'failed' | 'pending'; path?: string; copiedOn?: string; error?: string }
  pinned: boolean
  note?: string
  progress?: BackupProgress
  /** why it is kept (retention), or that it will be pruned at the next run */
  retention?: string
}

export interface BackupHealth {
  enabled: boolean
  lastOk: { id: string; at: string; kind: BackupKind; ageHours: number } | null
  lastFailure: { id: string; at: string; error: string } | null
  /** no successful install backup for longer than staleHours (or never) */
  stale: boolean
  staleHours: number
  running: { id: string; kind: BackupKind; environmentId?: string; progress?: BackupProgress }[]
  nextRun: string | null
  message: string
}

export interface ScheduleSetting { enabled: boolean; cron: string; timeZone: string }

export interface BackupSettings {
  enabled: boolean
  folder: string
  /** the folder comes from APPBUILDER_BACKUP_DIR: it cannot be changed here */
  folderFromEnv: boolean
  defaultFolder: string
  method: 'auto' | 'pg_dump' | 'builtin'
  pgBinPath: string | null
  tools: { pgDump: { path: string; version: string } | null; pgRestore: { path: string; version: string } | null; serverMajor: number | null; usable: boolean; problem: string | null }
  install: ScheduleSetting & { includeKey: boolean }
  environments: Record<string, ScheduleSetting>
  retention: { daily: number; weekly: number; monthly: number; snapshotDays: number }
  /** a passphrase is saved (sealed with the install's secret key) and scheduled backups are encrypted with it */
  passphraseSaved: boolean
  snapshots: { beforeUpgrade: boolean; beforeDelete: boolean; beforeRestore: boolean; beforeMigration: boolean }
  offsite: { enabled: boolean; folder: string | null }
  restoreTest: ScheduleSetting
  staleHours: number
  timeZone: string
}

export interface BackupSettingsInput {
  enabled?: boolean
  folder?: string | null
  method?: 'auto' | 'pg_dump' | 'builtin'
  pgBinPath?: string | null
  install?: Partial<ScheduleSetting & { includeKey: boolean }>
  environments?: Record<string, Partial<ScheduleSetting> | null>
  retention?: Partial<BackupSettings['retention']>
  /** a new passphrase to save (string), or null to forget the saved one */
  passphrase?: string | null
  snapshots?: Partial<BackupSettings['snapshots']>
  offsite?: Partial<BackupSettings['offsite']>
  restoreTest?: Partial<ScheduleSetting>
  staleHours?: number
}

export interface BackupsResponse {
  items: BackupInfo[]
  health: BackupHealth
  ops: BackupOp[]
}

export interface BackupContentsTable { id: string; name: string; source: string | null; rows: number | null; columns: { name: string; type: string }[]; restorable: boolean; note?: string }
export interface BackupContents {
  id: string
  kind: BackupKind
  createdOn: string
  method: 'pg_dump' | 'builtin'
  app: { version: string; schemaVersion: number }
  includesKey: boolean
  environments: { id: string; name: string; type: string; schemaVersion: number; attachments: { count: number; bytes: number; missing: number }; dataFiles: { count: number; bytes: number }; tables: BackupContentsTable[] }[]
  warnings: string[]
  /** can this server restore it (schema version, tools)? */
  restorable: boolean
  problem?: string
}

export interface BackupRowsPage {
  columns: { name: string; displayName: string; type: string }[]
  rows: Record<string, string | null>[]
  offset: number
  total: number | null
  more: boolean
}

export interface RestoreRequest {
  /** the environment inside the backup */
  environment: string
  mode: 'new' | 'in-place'
  /** new: the new environment's name and type */
  name?: string
  type?: 'production' | 'sandbox' | 'developer'
  /** in-place: the target environment (default: the one in the backup) and its name typed by the administrator */
  target?: string
  confirmName?: string
  passphrase?: string
  /** in-place: go on when the safety backup before the restore fails */
  proceedWithoutBackup?: boolean
  /** new: keep the passwords and keys of connections to other systems (default false, like a copy) */
  keepConnectionSecrets?: boolean
  /** new: keep people's roles from the backup (default false: only you, as administrator) */
  keepAccess?: boolean
}

export interface TableRestoreRequest {
  environment: string
  tables: string[]
  mode: 'new' | 'replace'
  passphrase?: string
}

export interface TableRestorePlanItem {
  tableId: string
  name: string
  mode: 'new' | 'replace'
  /** new: the name of the table that will be created */
  newName?: string
  rowsInBackup: number
  rowsNow?: number
  attachments: number
  columns: { name: string; change: 'only-in-backup' | 'only-now' | 'type' ; from?: string; to?: string }[]
  destructive: boolean
  problems: string[]
  notes: string[]
}
export interface TableRestorePlan { backupId: string; environment: string; target: string; items: TableRestorePlanItem[]; destructive: boolean; problems: string[]; token: string }

export interface BackupOp {
  id: string
  kind: 'restore' | 'restore-tables' | 'restore-test' | 'verify'
  backupId?: string
  mode?: string
  sourceEnvironment?: string
  targetEnvironment?: string
  state: 'running' | 'succeeded' | 'failed'
  phase?: string
  progress?: BackupProgress
  startedOn: string
  finishedOn?: string
  createdBy?: string
  error?: string
  /** the safety backup before an in-place restore failed: the restore can be started again with proceedWithoutBackup */
  backupFailed?: boolean
  result?: Record<string, unknown>
}

/** pushed over the live hub to install administrators (user topic): progress of backups and restores */
export interface BackupLiveEvent { backup?: BackupInfo; op?: BackupOp }
