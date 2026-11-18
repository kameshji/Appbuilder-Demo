/**
 * Environments. Today every install has exactly one, the built-in "Default" environment (type production) on the
 * system database; separate Dev/Test/Prod environments (one schema plus workspace folder each) arrive with P0
 * (docs/plan/master-plan.md). This is the one place that answers the list, so the API stays the same when it grows.
 */
import type { EnvironmentDef } from '../../src/platform/contracts.ts'
import type { Services, UserContext } from './contracts.ts'
import { SCHEMA_VERSION } from './meta-store.ts'

export const DEFAULT_ENVIRONMENT_ID = 'default'

/** what the user may see: administrators also get the database description and the schema version */
export async function listEnvironments(services: Services, user: UserContext): Promise<EnvironmentDef[]> {
  let createdOn: string | null = null
  try {
    createdOn = (await services.meta.info()).createdOn
  } catch {
    createdOn = null
  }
  const env: EnvironmentDef = { id: DEFAULT_ENVIRONMENT_ID, name: 'Default', type: 'production', builtIn: true }
  if (createdOn) env.createdOn = createdOn
  if (user.privileges.isAdmin) {
    // CoreServices keeps "<version> at host:port/database"; the test harness has no such state
    const location = (services as Services & { state?: { location?: string | null } }).state?.location
    env.details = { database: location || 'System database', schemaVersion: SCHEMA_VERSION }
  }
  return [env]
}
