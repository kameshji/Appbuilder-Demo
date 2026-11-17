import { Cable, Database, FileSpreadsheet, FileText, Flame, Globe, HardDrive, Server, Sheet, Zap, type LucideIcon } from 'lucide-react'
import type { ConnectionRef, ConnectorKind } from '@/platform'
import { Badge } from '@/components/ui/badge'

export const CONNECTOR_INFO: Record<ConnectorKind, { label: string; icon: LucideIcon }> = {
  mysql: { label: 'MySQL / MariaDB', icon: Database },
  gsheets: { label: 'Google Sheets', icon: Sheet },
  files: { label: 'Data files', icon: HardDrive },
  'php-gateway': { label: 'PHP gateway', icon: Server },
  'local-csv': { label: 'Local CSV', icon: FileText },
  rest: { label: 'REST API', icon: Globe },
  postgres: { label: 'PostgreSQL', icon: Database },
  sqlserver: { label: 'SQL Server', icon: Server },
  supabase: { label: 'Supabase', icon: Zap },
  firebase: { label: 'Firebase', icon: Flame },
  excel: { label: 'Excel file', icon: FileSpreadsheet },
}
export const connectorInfo = (k: ConnectorKind) => CONNECTOR_INFO[k] ?? { label: String(k), icon: Cable }

/** Default / device-only badges for a connection reference. */
export function ConnectionFlags({ conn }: { conn: ConnectionRef | undefined }) {
  if (!conn) return null
  return (
    <>
      {conn.isDefault && <Badge variant="secondary" data-testid="badge-default">Default</Badge>}
      {conn.scope === 'device' && <Badge variant="outline" title="Stays on this machine: never synced or exposed beyond it" data-testid="badge-device-only"><HardDrive /> Device only</Badge>}
    </>
  )
}

/** Connections a new table may live in. */
export const TABLE_HOSTS: ConnectorKind[] = ['mysql', 'gsheets', 'files']
