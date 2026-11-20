/**
 * Chat (P3 package A): tables and columns of schema version 14 (independent step). The orchestrator wired this file into
 * meta-store.ts (environmentDdl and ENVIRONMENT_STEPS); the package owner fills it in. Rules: docs/dev/schema.md.
 */
import type { SqlDb } from '../contracts.ts'

/** the tables this package adds to every environment schema (checked by the upgrade step) */
export const CHAT_TABLES: string[] = []

/** CREATE TABLE / ALTER TABLE ... IF NOT EXISTS statements for an environment schema (schema-qualified, idempotent) */
export function chatEnvironmentDdl(_schema: string): string[] {
  return []
}

/** upgrade step to 14: the statements above ran before the steps; this checks the result (and migrates data if needed) */
export async function upgradeEnvironmentTo14Chat(_db: SqlDb, _schema: string): Promise<void> {
  // filled in by the package (see upgradeEnvironmentTo12Dashboards in ../dashboards/ddl.ts for the pattern)
}