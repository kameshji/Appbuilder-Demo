/**
 * Admin console > Departments (tree editor), Teams (members, environment), Org chart (by manager), and the CSV import
 * of users (preview, all-or-nothing, one-time temporary passwords). docs/admin/organisation.md.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, Network, Pencil, Plus, Trash2, Upload, Users as UsersIcon } from 'lucide-react'
import { platform, usePlatform, type DepartmentDef, type TeamDef, type UserDef, type UserImportResult, type UserImportRow } from '@/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, Empty, Field, Panel, useToast } from './kit'
import { useCaps } from './security'

function Title({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
    </div>
  )
}

const selectCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm'

/** department ids in tree order with their depth */
function treeOrder(departments: DepartmentDef[]): { d: DepartmentDef; depth: number }[] {
  const out: { d: DepartmentDef; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (parent: string | undefined, depth: number) => {
    for (const d of departments.filter((x) => (x.parentId ?? undefined) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(d.id) || depth > 32) continue
      seen.add(d.id)
      out.push({ d, depth })
      walk(d.id, depth + 1)
    }
  }
  walk(undefined, 0)
  for (const d of departments) if (!seen.has(d.id)) out.push({ d, depth: 0 }) // orphans (parent removed)
  return out
}

/* ------------------------------------------------------------------ departments */

function DepartmentDialog({ dept, parentId, onOpenChange }: { dept: DepartmentDef | null | undefined; parentId?: string; onOpenChange(o: boolean): void }) {
  const departments = usePlatform((s) => s.departments)
  const { fail, toast } = useToast()
  const open = dept !== undefined
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const k = open ? (dept?.id ?? `new:${parentId ?? ''}`) : null
  if (k !== key) {
    setKey(k)
    setCode(dept?.code ?? '')
    setName(dept?.name ?? '')
    setParent(dept?.parentId ?? parentId ?? '')
  }
  const run = async () => {
    setBusy(true)
    try {
      if (dept) await platform.org.updateDepartment(dept.id, { code: code.trim(), name: name.trim(), parentId: parent || undefined })
      else await platform.org.createDepartment({ code: code.trim(), name: name.trim(), ...(parent ? { parentId: parent } : {}) })
      toast(dept ? 'Department saved' : `Added ${name.trim()}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="department-dialog">
        <DialogHeader><DialogTitle>{dept ? 'Edit department' : 'Add department'}</DialogTitle><DialogDescription>The code is stable: row rules and solutions refer to departments by code.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (code.trim() && name.trim()) void run() }}>
          <div className="grid grid-cols-[140px_1fr] gap-3">
            <Field label="Code" htmlFor="dept-code"><Input id="dept-code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="dept-code" /></Field>
            <Field label="Name" htmlFor="dept-name"><Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="dept-name" /></Field>
          </div>
          <Field label="Part of" htmlFor="dept-parent">
            <select id="dept-parent" value={parent} onChange={(e) => setParent(e.target.value)} className={selectCls} data-testid="dept-parent">
              <option value="">(top level)</option>
              {treeOrder(departments).filter(({ d }) => d.id !== dept?.id).map(({ d, depth }) => <option key={d.id} value={d.id}>{'  '.repeat(depth)}{d.name} ({d.code})</option>)}
            </select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !code.trim() || !name.trim()} data-testid="dept-save">{dept ? 'Save' : 'Add department'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DepartmentsSection() {
  const departments = usePlatform((s) => s.departments)
  const users = usePlatform((s) => s.users)
  const caps = useCaps()
  const { fail, toast } = useToast()
  const [edit, setEdit] = useState<{ dept: DepartmentDef | null; parentId?: string } | null>(null)
  const [del, setDel] = useState<DepartmentDef | null>(null)
  const can = caps.isInstallAdmin
  const order = treeOrder(departments)
  return (
    <div data-testid="admin-departments">
      <Title
        title="Departments"
        subtitle="The department tree of the organisation (shared by every environment). Users belong to one department; department scopes and rules follow it."
        actions={<Button size="sm" disabled={!can} onClick={() => setEdit({ dept: null })} data-testid="new-department"><Plus /> Add department</Button>}
      />
      {order.length === 0 ? (
        <Empty icon={Network} title="No departments yet" description="Add the top of the tree (for example the company or a plant), then the departments below it." action={can ? <Button onClick={() => setEdit({ dept: null })}><Plus /> Add department</Button> : undefined} />
      ) : (
        <Panel className="overflow-hidden">
          <ul data-testid="department-tree">
            {order.map(({ d, depth }) => {
              const n = users.filter((u) => u.departmentId === d.id).length
              return (
                <li key={d.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-0" style={{ paddingLeft: 12 + depth * 22 }} data-testid={`dept-${d.code}`}>
                  {depth > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
                  <span className="font-medium">{d.name}</span>
                  <Badge variant="outline" className="font-mono text-[11px]">{d.code}</Badge>
                  <span className="text-xs text-muted-foreground">{n === 1 ? '1 person' : `${n} people`}</span>
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="xs" disabled={!can} onClick={() => setEdit({ dept: null, parentId: d.id })} data-testid={`dept-add-child-${d.code}`}><Plus /> Sub-department</Button>
                    <Button variant="ghost" size="icon-sm" disabled={!can} aria-label={`Edit ${d.name}`} onClick={() => setEdit({ dept: d })}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" disabled={!can} aria-label={`Delete ${d.name}`} onClick={() => setDel(d)}><Trash2 /></Button>
                  </span>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
      {!can && <p className="mt-3 text-xs text-muted-foreground">Only install administrators change departments.</p>}
      <DepartmentDialog dept={edit ? edit.dept : undefined} parentId={edit?.parentId} onOpenChange={(o) => !o && setEdit(null)} />
      <ConfirmDialog
        open={!!del} onOpenChange={(o) => !o && setDel(null)}
        title={`Delete department "${del?.name ?? ''}"?`}
        description="Its people keep their accounts but no longer belong to a department. A department with sub-departments cannot be deleted."
        onConfirm={async () => { if (del) { try { await platform.org.removeDepartment(del.id); toast('Department deleted', 'success') } catch (e) { fail(e) } } }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ teams */

function TeamDialog({ team, onOpenChange }: { team: TeamDef | null | undefined; onOpenChange(o: boolean): void }) {
  const users = usePlatform((s) => s.users)
  const environments = usePlatform((s) => s.environments)
  const server = usePlatform((s) => s.mode) === 'server'
  const { fail, toast } = useToast()
  const open = team !== undefined
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [env, setEnv] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const k = open ? (team?.id ?? 'new') : null
  if (k !== key) {
    setKey(k)
    setCode(team?.code ?? '')
    setName(team?.name ?? '')
    setDesc(team?.description ?? '')
    setEnv(team?.environmentId ?? '')
    setMembers(team?.memberIds ?? [])
    setFilter('')
  }
  const run = async () => {
    setBusy(true)
    try {
      const body = { code: code.trim(), name: name.trim(), description: desc.trim() || undefined, environmentId: env || undefined, memberIds: members }
      if (team) await platform.org.updateTeam(team.id, body)
      else await platform.org.createTeam(body)
      toast(team ? 'Team saved' : `Added ${name.trim()}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const shown = users.filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto" data-testid="team-dialog">
        <DialogHeader><DialogTitle>{team ? 'Edit team' : 'Add team'}</DialogTitle><DialogDescription>Teams can own rows and receive shares. The code is stable: rules and solutions refer to teams by code.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (code.trim() && name.trim()) void run() }}>
          <div className="grid grid-cols-[140px_1fr] gap-3">
            <Field label="Code" htmlFor="team-code"><Input id="team-code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="team-code" /></Field>
            <Field label="Name" htmlFor="team-name"><Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="team-name" /></Field>
          </div>
          <Field label="Description (optional)" htmlFor="team-desc"><Input id="team-desc" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          {server && (
            <Field label="Counts in" htmlFor="team-env">
              <select id="team-env" value={env} onChange={(e) => setEnv(e.target.value)} className={selectCls} data-testid="team-env">
                <option value="">Every environment</option>
                {environments.map((x) => <option key={x.id} value={x.id}>Only {x.name}</option>)}
              </select>
            </Field>
          )}
          <div className="grid gap-2">
            <div className="flex items-center gap-2"><span className="text-xs font-medium">Members ({members.length})</span><Input className="ml-auto h-7 w-48" placeholder="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter people" /></div>
            <div className="grid max-h-56 gap-1 overflow-auto rounded-md border border-border p-2">
              {shown.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={members.includes(u.id)} onCheckedChange={(v) => setMembers(v === true ? [...members, u.id] : members.filter((x) => x !== u.id))} data-testid={`team-member-${u.id}`} />
                  <span>{u.name}</span><span className="text-xs text-muted-foreground">{u.email}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !code.trim() || !name.trim()} data-testid="team-save">{team ? 'Save' : 'Add team'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TeamsSection() {
  const teams = usePlatform((s) => s.teams)
  const users = usePlatform((s) => s.users)
  const environments = usePlatform((s) => s.environments)
  const caps = useCaps()
  const { fail, toast } = useToast()
  const [edit, setEdit] = useState<{ team: TeamDef | null } | null>(null)
  const [del, setDel] = useState<TeamDef | null>(null)
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? id
  return (
    <div data-testid="admin-teams">
      <Title
        title="Teams"
        subtitle="Groups of people that work together. The team scope gives a role the rows of everyone in the user's teams; rows can be owned by a team and shared with a team."
        actions={<Button size="sm" disabled={!caps.isAdmin} onClick={() => setEdit({ team: null })} data-testid="new-team"><Plus /> Add team</Button>}
      />
      {teams.length === 0 ? (
        <Empty icon={UsersIcon} title="No teams yet" description="Add a team, then its members." action={caps.isAdmin ? <Button onClick={() => setEdit({ team: null })}><Plus /> Add team</Button> : undefined} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="teams-table">
            <thead><tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground"><th className="px-4 py-2.5">Team</th><th className="px-4 py-2.5">Members</th><th className="px-4 py-2.5">Counts in</th><th className="w-24 px-4 py-2.5"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id} className="border-b border-border align-top last:border-0" data-testid={`team-${t.code}`}>
                  <td className="px-4 py-2.5"><div className="font-medium">{t.name} <Badge variant="outline" className="ml-1 font-mono text-[11px]">{t.code}</Badge></div>{t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}</td>
                  <td className="px-4 py-2.5 text-xs">{t.memberIds.length ? t.memberIds.map(name).join(', ') : <span className="text-muted-foreground">Nobody yet</span>}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{t.environmentId ? (environments.find((e) => e.id === t.environmentId)?.name ?? t.environmentId) : 'Every environment'}</td>
                  <td className="px-4 py-1.5 text-right">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} onClick={() => setEdit({ team: t })} data-testid={`edit-team-${t.code}`}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`} onClick={() => setDel(t)}><Trash2 /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <TeamDialog team={edit ? edit.team : undefined} onOpenChange={(o) => !o && setEdit(null)} />
      <ConfirmDialog
        open={!!del} onOpenChange={(o) => !o && setDel(null)}
        title={`Delete team "${del?.name ?? ''}"?`}
        description="Shares to the team end. Rows the team owns keep it as owner until they are given to someone else."
        onConfirm={async () => { if (del) { try { await platform.org.removeTeam(del.id); toast('Team deleted', 'success') } catch (e) { fail(e) } } }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ org chart */

export function OrgChartSection() {
  const users = usePlatform((s) => s.users)
  const departments = usePlatform((s) => s.departments)
  const byManager = useMemo(() => {
    const m = new Map<string, UserDef[]>()
    for (const u of users) {
      const key = u.managerId && users.some((x) => x.id === u.managerId) ? u.managerId : ''
      m.set(key, [...(m.get(key) ?? []), u])
    }
    return m
  }, [users])
  const dept = (id?: string) => departments.find((d) => d.id === id)?.name
  const seen = new Set<string>()
  const node = (u: UserDef, depth: number): ReactNode => {
    if (seen.has(u.id) || depth > 32) return null
    seen.add(u.id)
    const kids = (byManager.get(u.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    return (
      <li key={u.id} data-testid={`org-${u.id}`}>
        <div className="my-1 inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-xs">
          <span className="font-medium">{u.name}</span>
          {u.jobTitle && <span className="text-xs text-muted-foreground">{u.jobTitle}</span>}
          {dept(u.departmentId) && <Badge variant="outline" className="text-[11px]">{dept(u.departmentId)}</Badge>}
        </div>
        {kids.length > 0 && <ul className="ml-5 border-l border-border pl-4">{kids.map((k) => node(k, depth + 1))}</ul>}
      </li>
    )
  }
  const roots = (byManager.get('') ?? []).sort((a, b) => a.name.localeCompare(b.name))
  const tree = roots.map((u) => node(u, 0))
  // people in a reporting cycle have no root: shown at the end so nobody disappears
  const rest = users.filter((u) => !seen.has(u.id))
  return (
    <div data-testid="admin-orgchart">
      <Title title="Org chart" subtitle="Who reports to whom (from each user's manager). Manager scopes follow these lines." />
      {users.length === 0 ? <Empty icon={Network} title="No people yet" description="Add users and set their managers." /> : (
        <Panel className="overflow-auto p-4">
          <ul data-testid="org-tree">{tree}{rest.map((u) => node(u, 0))}</ul>
        </Panel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ user organisation fields (the user dialog) */

export interface OrgFieldsValue { departmentId: string; managerId: string; jobTitle: string; phone: string; employeeCode: string }
export const orgFieldsOf = (u: UserDef | null): OrgFieldsValue => ({ departmentId: u?.departmentId ?? '', managerId: u?.managerId ?? '', jobTitle: u?.jobTitle ?? '', phone: u?.phone ?? '', employeeCode: u?.employeeCode ?? '' })

export function OrgFields({ value, onChange, userId, disabled }: { value: OrgFieldsValue; onChange(v: OrgFieldsValue): void; userId?: string; disabled: boolean }) {
  const departments = usePlatform((s) => s.departments)
  const users = usePlatform((s) => s.users)
  const set = (k: keyof OrgFieldsValue, v: string) => onChange({ ...value, [k]: v })
  return (
    <div className="grid grid-cols-2 gap-3" data-testid="user-org-fields">
      <Field label="Department" htmlFor="user-dept">
        <select id="user-dept" disabled={disabled} value={value.departmentId} onChange={(e) => set('departmentId', e.target.value)} className={selectCls} data-testid="user-department">
          <option value="">(none)</option>
          {treeOrder(departments).map(({ d, depth }) => <option key={d.id} value={d.id}>{'  '.repeat(depth)}{d.name}</option>)}
        </select>
      </Field>
      <Field label="Manager" htmlFor="user-manager">
        <select id="user-manager" disabled={disabled} value={value.managerId} onChange={(e) => set('managerId', e.target.value)} className={selectCls} data-testid="user-manager">
          <option value="">(none)</option>
          {users.filter((u) => u.id !== userId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </Field>
      <Field label="Job title" htmlFor="user-title"><Input id="user-title" disabled={disabled} value={value.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} data-testid="user-job-title" /></Field>
      <Field label="Phone" htmlFor="user-phone"><Input id="user-phone" disabled={disabled} value={value.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="Employee code" htmlFor="user-empcode"><Input id="user-empcode" disabled={disabled} value={value.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} /></Field>
    </div>
  )
}

/** the patch for the API: '' clears (null on the server) */
export function orgPatch(before: UserDef | null, v: OrgFieldsValue): Partial<UserDef> {
  const out: Record<string, unknown> = {}
  const b = orgFieldsOf(before)
  for (const k of Object.keys(v) as (keyof OrgFieldsValue)[]) if (v[k] !== b[k]) out[k] = v[k] === '' ? null : v[k]
  return out as Partial<UserDef>
}

/* ------------------------------------------------------------------ CSV import */

const SAMPLE = 'name,email,department,manager,jobTitle,phone,employeeCode,roles\nAsha Rao,asha@example.com,PLANT1,,Plant manager,,E001,\nRavi Kumar,ravi@example.com,LINE1,asha@example.com,Supervisor,,E002,\n'

export function UserImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const server = usePlatform((s) => s.mode) === 'server'
  const { fail, toast } = useToast()
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<{ rows: UserImportRow[]; ok: boolean; unknown: string[] } | null>(null)
  const [done, setDone] = useState<Extract<UserImportResult, { created: unknown }> | null>(null)
  const [busy, setBusy] = useState(false)
  const reset = () => { setCsv(''); setPreview(null); setDone(null) }
  const check = async () => {
    setBusy(true)
    try {
      const r = await platform.org.importUsers(csv, false)
      if ('preview' in r) setPreview({ rows: r.preview, ok: r.ok, unknown: r.unknownColumns })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const commit = async () => {
    setBusy(true)
    try {
      const r = await platform.org.importUsers(csv, true)
      if ('created' in r) {
        setDone(r)
        toast(`Imported: ${r.created.length} new, ${r.updated} updated`, 'success')
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl" data-testid="user-import-dialog">
        <DialogHeader>
          <DialogTitle>Import users from CSV</DialogTitle>
          <DialogDescription>
            Columns: name, email, department (code), manager (email), jobTitle, phone, employeeCode, roles (names separated by ;). Existing emails are updated. Everything is checked first; nothing is imported when one row has an error. Passwords are never imported{server ? ': new users get a one-time temporary password, shown once below, and must change it at the first sign-in.' : '.'}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="grid gap-3" data-testid="user-import-done">
            <p className="text-sm">{done.created.length} user(s) created, {done.updated} updated.</p>
            {server && done.created.length > 0 && (
              <>
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">Copy these temporary passwords now and give them to each person securely. They are not shown again.</p>
                <table className="w-full text-sm" data-testid="user-import-passwords">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="py-1.5">Email</th><th className="py-1.5">Temporary password</th></tr></thead>
                  <tbody>{done.created.map((c) => <tr key={c.email} className="border-b border-border last:border-0"><td className="py-1.5">{c.email}</td><td className="py-1.5 font-mono">{c.temporaryPassword}</td></tr>)}</tbody>
                </table>
                <Button size="sm" variant="outline" className="justify-self-start" onClick={() => { void navigator.clipboard?.writeText(done.created.map((c) => `${c.email}\t${c.temporaryPassword}`).join('\n')) }}><Copy /> Copy all</Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null) }} rows={7} className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs" placeholder={SAMPLE} aria-label="CSV text" data-testid="user-import-csv" />
            <div className="flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-primary">
                <Upload className="size-3.5" /> Choose a file
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setCsv(t); setPreview(null) }) }} />
              </label>
              <Button size="xs" variant="ghost" onClick={() => { setCsv(SAMPLE); setPreview(null) }}>Use the example</Button>
              <Button size="sm" variant="outline" className="ml-auto" disabled={busy || !csv.trim()} onClick={() => void check()} data-testid="user-import-check">{busy && !preview && <Spinner />} Check</Button>
            </div>
            {preview && (
              <div className="grid gap-2" data-testid="user-import-preview">
                {preview.unknown.length > 0 && <p className="text-xs text-muted-foreground">Ignored columns: {preview.unknown.join(', ')}</p>}
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th className="py-1.5">Line</th><th>Action</th><th>Name</th><th>Email</th><th>Department</th><th>Manager</th><th>Problems</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} className="border-b border-border align-top last:border-0">
                        <td className="py-1.5 text-xs text-muted-foreground">{r.line}</td>
                        <td><Badge variant={r.action === 'error' ? 'destructive' : 'outline'}>{r.action === 'create' ? 'New' : r.action === 'update' ? 'Update' : 'Error'}</Badge></td>
                        <td>{r.name}</td><td className="text-xs">{r.email}</td><td className="text-xs">{r.department ?? ''}</td><td className="text-xs">{r.manager ?? ''}</td>
                        <td className="text-xs text-destructive">{r.errors.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!preview.ok && <p className="text-sm text-destructive" role="alert">Fix the problems above; nothing is imported while a row has an error.</p>}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>{done ? 'Done' : 'Cancel'}</Button>
          {!done && <Button disabled={busy || !preview?.ok} onClick={() => void commit()} data-testid="user-import-commit">{busy && preview && <Spinner />} Import {preview?.rows.length ?? 0} user(s)</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
