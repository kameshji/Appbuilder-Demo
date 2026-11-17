/** Read-only summary of who can do what on one table: RBAC, column-level and row-level security in plain language. */
import { Info, Lock, ShieldCheck } from 'lucide-react'
import { usePlatform, type AccessScope, type RoleDef, type TableDef, type TablePrivilege } from '@/platform'
import { go } from '@/router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, Panel } from './kit'
import { SCOPE_WORD, describeFilter, describeRows, emptyPrivilege, isMakerRole, securedColumns, useCaps } from './security'

function privOf(role: RoleDef, table: TableDef): TablePrivilege {
  if (role.isAdmin) return { table: table.id, create: true, read: 'all', update: 'all', delete: 'all' }
  return role.privileges.find((p) => p.table === table.id) ?? emptyPrivilege(table.id)
}

const Yes = () => <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Yes</Badge>
const No = () => <span className="text-xs text-muted-foreground">No</span>
function Scope({ s, filtered }: { s: AccessScope; filtered: boolean }) {
  if (s === 'none') return <span className="text-xs text-muted-foreground">No</span>
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={s === 'all' ? 'default' : 'secondary'} className={s === 'all' ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : ''}>{SCOPE_WORD[s]}</Badge>
      {filtered && <Badge variant="outline" title="A row filter narrows this further">Filtered</Badge>}
    </span>
  )
}

export function TableSecurity({ table }: { table: TableDef }) {
  const roles = usePlatform((s) => s.roles)
  const session = usePlatform((s) => s.session)
  const mode = usePlatform((s) => s.mode)
  const caps = useCaps()
  const cols = securedColumns(table)
  const rows = roles.map((r) => ({ role: r, p: privOf(r, table) }))
  const withCls = rows.filter(({ role, p }) => !role.isAdmin && p.columns && Object.values(p.columns).some((a) => a !== 'update'))
  const withRls = rows.filter(({ role, p }) => !role.isAdmin && ((p.rowFilter?.length ?? 0) > 0 || p.read === 'own' || p.update === 'own' || p.delete === 'own'))
  const mine = session?.privileges.tables[table.id]
  const nameOf = (n: string) => table.columns.find((c) => c.name === n)?.displayName ?? n

  return (
    <div className="grid max-w-4xl gap-4" data-testid="security-tab">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0 text-primary" />
        <span>
          {mode === 'server' ? 'The server enforces these rules on every request.' : 'Demo mode applies these rules in this browser only.'} This is a summary; change roles under Security roles.
          {!caps.isAdmin && ' You see only the roles that apply to you.'}
        </span>
        {caps.isAdmin && <Button size="xs" variant="outline" className="ml-auto shrink-0" onClick={() => go({ page: 'roles' })} data-testid="goto-roles"><ShieldCheck /> Edit roles</Button>}
      </div>

      {rows.length === 0 ? (
        <Empty icon={ShieldCheck} title="No roles to show" description="Create security roles to control who can use this table." />
      ) : (
        <Panel className="overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">Who can do what</div>
          <table className="w-full text-sm" data-testid="security-summary">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2">Role</th><th className="px-3 py-2">Create</th><th className="px-3 py-2">Read</th><th className="px-3 py-2">Update</th><th className="px-3 py-2">Delete</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ role, p }) => {
                const filtered = !role.isAdmin && (p.rowFilter?.length ?? 0) > 0
                return (
                  <tr key={role.id} className="border-b border-border last:border-0" data-testid={`security-role-${role.id}`}>
                    <td className="px-4 py-2"><span className="font-medium">{role.name}</span> {role.isAdmin && <Badge variant="secondary">Admin</Badge>} {isMakerRole(role) && <Badge variant="outline">Maker</Badge>}</td>
                    <td className="px-3 py-2">{p.create ? <Yes /> : <No />}</td>
                    <td className="px-3 py-2"><Scope s={p.read} filtered={filtered && p.read !== 'none'} /></td>
                    <td className="px-3 py-2"><Scope s={p.update} filtered={filtered && p.update !== 'none'} /></td>
                    <td className="px-3 py-2"><Scope s={p.delete} filtered={filtered && p.delete !== 'none'} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Lock className="size-4 text-primary" /> Column access</div>
        {withCls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No column restrictions: every role that can read this table sees all {cols.length} columns.</p>
        ) : (
          <ul className="grid gap-2 text-sm" data-testid="security-cls">
            {withCls.map(({ role, p }) => {
              const hidden = cols.filter((c) => p.columns?.[c.name] === 'none')
              const ro = cols.filter((c) => p.columns?.[c.name] === 'read')
              return (
                <li key={role.id}>
                  <span className="font-medium">{role.name}</span>
                  {hidden.length > 0 && <span>: cannot see <strong>{hidden.map((c) => c.displayName).join(', ')}</strong></span>}
                  {hidden.length > 0 && ro.length > 0 && <span>;</span>}
                  {ro.length > 0 && <span>{hidden.length === 0 ? ':' : ''} can read but not change <strong>{ro.map((c) => c.displayName).join(', ')}</strong></span>}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4 text-primary" /> Row access</div>
        {withRls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No row filters: where a role has access, it covers every row.</p>
        ) : (
          <ul className="grid gap-2.5 text-sm" data-testid="security-rls">
            {withRls.map(({ role, p }) => (
              <li key={role.id}>
                <div className="font-medium">{role.name}</div>
                <div className="text-muted-foreground">
                  {p.read !== 'none' && <div>Reads {describeRows(p.read, p.rowFilter, table.columns)}.</div>}
                  {p.update !== 'none' && <div>Updates {describeRows(p.update, p.rowFilter, table.columns)}.</div>}
                  {p.delete !== 'none' && <div>Deletes {describeRows(p.delete, p.rowFilter, table.columns)}.</div>}
                  {p.read === 'none' && p.update === 'none' && p.delete === 'none' && !!p.rowFilter?.length && <div>Has a filter ({describeFilter(p.rowFilter, table.columns)}) but no read access.</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {mine && session && (
        <Panel className="p-4" data-testid="security-mine">
          <div className="mb-1 text-sm font-semibold">Your access</div>
          <p className="text-sm text-muted-foreground">
            {session.privileges.isAdmin ? 'You are an administrator: full access.' : <>Create: {mine.create ? 'yes' : 'no'} · Read: {SCOPE_WORD[mine.read].toLowerCase()} · Update: {SCOPE_WORD[mine.update].toLowerCase()} · Delete: {SCOPE_WORD[mine.delete].toLowerCase()}{mine.filtered ? ' · a row filter applies' : ''}{Object.entries(mine.columns).some(([, a]) => a === 'read') ? ` · read-only: ${Object.entries(mine.columns).filter(([, a]) => a === 'read').map(([n]) => nameOf(n)).join(', ')}` : ''}</>}
          </p>
        </Panel>
      )}
    </div>
  )
}
