// STUB. Replaced by the mysql connector agent.
import type { ConnectorFactory } from '../../core/contracts.ts'
export const createMySqlConnector: ConnectorFactory = () => { throw new Error('mysql connector not implemented yet') }
import type { MySqlSettings, SqlDb } from '../../core/contracts.ts'
/** Also used by the server core for the system store on the default connection. */
export function createSqlDb(_settings: MySqlSettings, _password: string): SqlDb { throw new Error('mysql connector not implemented yet') }
