/** Metadata API: apps, tables, columns, connections, roles, users, security preview, solutions, packages, files, own profile, environments, audit log. */
import type { RouteModule } from '../../core/contracts.ts'
import { registerAdminRoutes } from './admin.ts'
import { registerAppRoutes } from './apps.ts'
import { registerConnectionRoutes } from './connections.ts'
import { registerEnvironmentRoutes } from './environments.ts'
import { registerFileRoutes } from './files.ts'
import { registerOrgRoutes } from './org.ts'
import { registerSecurityRoutes } from './security.ts'
import { registerSolutionRoutes } from './solutions.ts'
import { registerTableRoutes } from './tables.ts'

export const metaRoutes: RouteModule = (router, services) => {
  registerAppRoutes(router, services)
  registerTableRoutes(router, services)
  registerConnectionRoutes(router, services)
  registerSecurityRoutes(router, services)
  registerSolutionRoutes(router, services)
  registerFileRoutes(router, services)
  registerAdminRoutes(router, services)
  registerEnvironmentRoutes(router, services)
  registerOrgRoutes(router, services)
}

export { migrateLegacyWorkspace } from './migrate.ts'
export { seedSample } from './seed.ts'
