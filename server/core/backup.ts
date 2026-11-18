/**
 * Backups of an environment (P0 package J: pg_dump per environment schema plus its workspace folder, restore in place).
 * This is the hook point the in-place solution upgrade calls before it changes anything. Until package J lands the
 * service takes no backup and says so in words, which the upgrade plan and its result show to the administrator.
 */
import type { BackupService } from './contracts.ts'

export const NO_BACKUP_MESSAGE = 'No backup was taken: automatic backups arrive with a later update. Export the solution (and its data) from the target first if you need a way back.'

export function createNoBackupService(): BackupService {
  return {
    available: () => false,
    async snapshot() {
      return { taken: false, message: NO_BACKUP_MESSAGE }
    },
  }
}
