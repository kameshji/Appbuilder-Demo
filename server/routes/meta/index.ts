// STUB. Replaced by the metadata API agent (S2): exports the route module and the legacy migration.
import type { RouteModule, Services } from '../../core/contracts.ts'
export const metaRoutes: RouteModule = () => {}
/** called by the core after the first admin is created; returns a human summary */
export async function migrateLegacyWorkspace(_services: Services, _adminUserId: string): Promise<{ migrated: boolean; summary: string }> {
  return { migrated: false, summary: 'not implemented' }
}
/** seed sample tables, rows and the Contacts app into the default store (when there is nothing to migrate) */
export async function seedSample(_services: Services, _adminUserId: string): Promise<void> {}
