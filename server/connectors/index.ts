/** Connector registry (architect-owned). Each connector folder exports its factory from index.ts. */
import type { ConnectionManager } from '../core/contracts.ts'
import { createMySqlConnector } from './mysql/index.ts'
import { createFilesConnector } from './files/index.ts'
import { createGSheetsConnector } from './gsheets/index.ts'

export function registerConnectors(manager: ConnectionManager): void {
  manager.register('mysql', createMySqlConnector)
  manager.register('files', createFilesConnector)
  manager.register('gsheets', createGSheetsConnector)
}
