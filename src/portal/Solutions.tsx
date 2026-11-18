import { useEffect, useState } from 'react'
import { ArrowLeft, Boxes, Cable, LayoutGrid, Plus, Rocket, Save, ShieldCheck, Table2, Trash2, Upload, X, type LucideIcon } from 'lucide-react'
import { platform, usePlatform, type SolutionComponentKind, type SolutionDef } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, Empty, Field, Panel, PageHeader, fmtDate, useToast } from './kit'
import { ExportDialog, ImportDialog } from './dialogs'
import { matches, useSearch } from './Shell'
import { DeployDialog } from './SolutionPlan'
import { useCaps } from './security'

const KINDS: { kind: SolutionComponentKind; label: string; icon: LucideIcon; route?: 'apps' | 'tables' | 'roles' | 'connections' }[] = [
  { kind: 'app', label: 'Apps', icon: LayoutGrid },
  { kind: 'table', label: 'Tables', icon: Table2 },
  { kind: 'role', label: 'Security roles', icon: ShieldCheck },
  { kind: 'connection', label: 'Connection references', icon: Cable },
]

function useComponentCatalog() {
  const apps = usePlatform((s) => s.apps)
  const tables = usePlatform((s) => s.tables)
  const roles = usePlatform((s) => s.roles)
  const connections = usePlatform((s) => s.connections)
  const items = (kind: SolutionComponentKind): { id: string; name: string }[] =>
    kind === 'app' ? apps.map((a) => ({ id: a.id, name: a.name }))
      : kind === 'table' ? tables.map((t) => ({ id: t.id, name: t.displayName }))
        : kind === 'role' ? roles.map((r) => ({ id: r.id, name: r.name }))
          : connections.map((c) => ({ id: c.id, name: c.name }))
  return items
}

function NewSolutionDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [f, setF] = useState({ displayName: '', publisher: '', version: '1.0.0', description: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setF({ displayName: '', publisher: '', version: '1.0.0', description: '' }) }, [open])
  const run = async () => {
    setBusy(true)
    try {
      const s = await platform.solutions.create({ displayName: f.displayName.trim(), publisher: f.publisher.trim() || undefined, version: f.version.trim() || undefined, description: f.description.trim() || undefined })
      toast(`Created solution "${s.displayName}"`, 'success')
      onOpenChange(false)
      go({ page: 'solution', id: s.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-solution-dialog">
        <DialogHeader><DialogTitle>New solution</DialogTitle><DialogDescription>A solution groups apps, tables, roles and connections so they can be exported together.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (f.displayName.trim()) void run() }}>
          <Field label="Display name" htmlFor="sol-name"><Input id="sol-name" autoFocus value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} data-testid="new-solution-name" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Publisher"><Input value={f.publisher} onChange={(e) => setF({ ...f, publisher: e.target.value })} /></Field>
            <Field label="Version"><Input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
          </div>
          <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !f.displayName.trim()} data-testid="new-solution-create">Create solution</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Solutions() {
  const solutions = usePlatform((s) => s.solutions)
  const q = useSearch()
  const [dlg, setDlg] = useState<'new' | 'import' | null>(null)
  const close = (o: boolean) => { if (!o) setDlg(null) }
  const list = solutions.filter((s) => matches(q, s.displayName, s.name, s.publisher, s.description))
  return (
    <div data-testid="page-solutions">
      <PageHeader
        icon={Boxes}
        title="Solutions"
        subtitle="Package apps, tables, roles and connections to move them between environments: deploy a solution from a sandbox to production, where it is upgraded in place."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setDlg('import')} data-testid="import-solution-button"><Upload /> Import solution</Button>
            <Button size="sm" onClick={() => setDlg('new')} data-testid="new-solution-button"><Plus /> New solution</Button>
          </>
        }
      />
      {solutions.length === 0 ? (
        <Empty icon={Boxes} title="No solutions yet" description="Create a solution to group your work, or import a solution package." action={<Button onClick={() => setDlg('new')}><Plus /> New solution</Button>} />
      ) : list.length === 0 ? (
        <Empty icon={Boxes} title="No matching solutions" description={`Nothing matches "${q}".`} />
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm" data-testid="solutions-list">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Publisher</th><th className="px-4 py-2.5">Version</th><th className="px-4 py-2.5 text-right">Components</th><th className="px-4 py-2.5">Modified</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} data-testid={`solution-row-${s.id}`} tabIndex={0} onClick={() => go({ page: 'solution', id: s.id })} onKeyDown={(e) => { if (e.key === 'Enter') go({ page: 'solution', id: s.id }) }} className="cursor-pointer border-b border-border outline-none last:border-0 hover:bg-accent/40 focus-visible:bg-accent/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-foreground"><Boxes className="size-3.5" /></span>
                      <div className="min-w-0"><div className="font-medium">{s.displayName}</div>{s.description && <div className="truncate text-xs text-muted-foreground">{s.description}</div>}</div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{s.publisher || '-'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{s.version}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.components.length}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(s.modifiedOn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <NewSolutionDialog open={dlg === 'new'} onOpenChange={close} />
      <ImportDialog open={dlg === 'import'} onOpenChange={close} kind="solution" onDone={(r) => go({ page: 'solution', id: r.id })} />
    </div>
  )
}

/* ------------------------------------------------------------------ detail */

function AddComponentDialog({ open, onOpenChange, solution, kind, label }: { open: boolean; onOpenChange(o: boolean): void; solution: SolutionDef; kind: SolutionComponentKind; label: string }) {
  const catalog = useComponentCatalog()
  const { fail, toast } = useToast()
  const [sel, setSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setSel([]) }, [open])
  const available = catalog(kind).filter((i) => !solution.components.some((c) => c.kind === kind && c.id === i.id))
  const run = async () => {
    setBusy(true)
    try {
      for (const id of sel) await platform.solutions.addComponent(solution.id, kind, id)
      toast(`Added ${sel.length} ${sel.length === 1 ? 'component' : 'components'}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-component-dialog">
        <DialogHeader><DialogTitle>Add existing: {label}</DialogTitle><DialogDescription>Choose what to include in {solution.displayName}.</DialogDescription></DialogHeader>
        {available.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Everything of this kind is already in the solution, or none exists yet.</p>
        ) : (
          <div className="grid max-h-72 gap-1 overflow-auto">
            {available.map((i) => (
              <label key={i.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50" data-testid={`pick-${i.id}`}>
                <Checkbox checked={sel.includes(i.id)} onCheckedChange={(v) => setSel(v === true ? [...sel, i.id] : sel.filter((x) => x !== i.id))} />
                {i.name}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || sel.length === 0} onClick={() => void run()} data-testid="add-component-confirm">Add {sel.length > 0 ? `(${sel.length})` : ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SolutionDetail({ solutionId }: { solutionId: string }) {
  const solution = usePlatform((s) => s.solutions.find((x) => x.id === solutionId))
  const catalog = useComponentCatalog()
  const { fail, toast } = useToast()
  const [f, setF] = useState({ displayName: '', publisher: '', version: '', description: '' })
  const [add, setAdd] = useState<SolutionComponentKind | null>(null)
  const [exp, setExp] = useState(false)
  const [dep, setDep] = useState(false)
  const [del, setDel] = useState(false)
  const caps = useCaps()
  const envCount = usePlatform((s) => s.environments.length)
  useEffect(() => {
    if (solution) setF({ displayName: solution.displayName, publisher: solution.publisher, version: solution.version, description: solution.description ?? '' })
  }, [solution])

  const back = (
    <button type="button" onClick={() => go({ page: 'solutions' })} className="mb-2 inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"><ArrowLeft className="size-3.5" /> Solutions</button>
  )
  if (!solution) {
    return <div data-testid="page-solution">{back}<Empty icon={Boxes} title="Solution not found" description="It may have been deleted." action={<Button onClick={() => go({ page: 'solutions' })}>Back to solutions</Button>} /></div>
  }
  const dirty = f.displayName !== solution.displayName || f.publisher !== solution.publisher || f.version !== solution.version || f.description !== (solution.description ?? '')
  const save = () => { platform.solutions.update(solution.id, { displayName: f.displayName.trim(), publisher: f.publisher.trim(), version: f.version.trim(), description: f.description.trim() }).then(() => toast('Solution saved', 'success')).catch(fail) }
  const nameOf = (kind: SolutionComponentKind, id: string) => catalog(kind).find((i) => i.id === id)?.name

  return (
    <div data-testid="page-solution">
      <PageHeader
        back={back}
        icon={Boxes}
        title={solution.displayName}
        subtitle={<span className="font-mono text-xs">{solution.name} · v{solution.version}</span>}
        actions={
          <>
            {caps.server && <Button size="sm" variant="outline" onClick={() => setDep(true)} disabled={envCount < 2} title={envCount < 2 ? 'There is no other environment to deploy to' : undefined} data-testid="deploy-solution-button"><Rocket /> Deploy to…</Button>}
            <Button size="sm" onClick={() => setExp(true)} data-testid="export-solution-button"><Upload /> Export solution</Button>
          </>
        }
      />
      <div className="grid grid-cols-[360px_minmax(0,1fr)] items-start gap-5">
        <Panel className="grid gap-3.5 p-5" data-testid="solution-meta">
          <h2 className="text-sm font-semibold">Details</h2>
          <Field label="Display name" htmlFor="sol-d-name"><Input id="sol-d-name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Publisher"><Input value={f.publisher} onChange={(e) => setF({ ...f, publisher: e.target.value })} /></Field>
            <Field label="Version"><Input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} /></Field>
          </div>
          <Field label="Description"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" /></Field>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!dirty || !f.displayName.trim()} onClick={save} data-testid="solution-save"><Save /> Save</Button>
            <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setDel(true)} data-testid="delete-solution-button"><Trash2 /> Delete</Button>
          </div>
          <p className="text-xs text-muted-foreground">Modified {fmtDate(solution.modifiedOn)}</p>
        </Panel>

        <div className="grid gap-4" data-testid="solution-components">
          {KINDS.map((k) => {
            const comps = solution.components.filter((c) => c.kind === k.kind)
            return (
              <Panel key={k.kind} data-testid={`solution-kind-${k.kind}`}>
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <k.icon className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold">{k.label}</h3>
                  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{comps.length}</span>
                  <Button size="xs" variant="outline" className="ml-auto" onClick={() => setAdd(k.kind)} data-testid={`add-${k.kind}`}><Plus /> Add existing</Button>
                </div>
                {comps.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">Nothing here yet.</p>
                ) : (
                  <ul role="list">
                    {comps.map((c) => {
                      const name = nameOf(k.kind, c.id)
                      return (
                        <li key={c.id} className="group flex items-center gap-2 border-b border-border px-4 py-2 last:border-0 hover:bg-accent/30" data-testid={`component-${c.id}`}>
                          <span className={name ? 'text-sm' : 'text-sm italic text-muted-foreground'}>{name ?? `Missing (${c.id})`}</span>
                          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={`Remove ${name ?? c.id} from solution`} onClick={() => { platform.solutions.removeComponent(solution.id, k.kind, c.id).catch(fail) }}><X /></Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Panel>
            )
          })}
        </div>
      </div>
      {add && <AddComponentDialog open onOpenChange={(o) => !o && setAdd(null)} solution={solution} kind={add} label={KINDS.find((k) => k.kind === add)!.label} />}
      <ExportDialog open={exp} onOpenChange={setExp} kind="solution" id={solution.id} title={solution.displayName} />
      {caps.server && <DeployDialog open={dep} onOpenChange={setDep} solution={solution} />}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Delete solution "${solution.displayName}"?`}
        description="Only the grouping is deleted. The apps, tables, roles and connections inside it are kept."
        onConfirm={async () => { await platform.solutions.remove(solution.id); toast('Solution deleted', 'success'); go({ page: 'solutions' }) }}
      />
    </div>
  )
}
