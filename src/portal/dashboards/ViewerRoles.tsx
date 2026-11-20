/**
 * Who may open a dashboard (P2-C): a dialog for the owner and administrators, opened from the dashboard's top bar. In edit mode
 * the roles can be ticked; the sentence at the top says in plain words who can see the dashboard. The list is saved with the
 * dashboard (PATCH /dashboards/:id `roles`); the server decides who may open it, this screen only edits the list. Roles of makers
 * and administrators are shown ticked and fixed: they open every dashboard anyway.
 */
import { Users } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { RoleDef } from '@/platform'
import { VIEWER_NOTE, alwaysSees, missingRoles, toggleRole, viewerSummary } from '@/dashboards/access'

export function ViewerRolesDialog({ roles, selected, editing, onChange, onClose }: {
  roles: RoleDef[]; selected: string[]; editing: boolean; onChange(ids: string[]): void; onClose(): void
}) {
  const gone = missingRoles(selected, roles)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="viewer-roles-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users className="size-4" /> Who can see this dashboard</DialogTitle>
          <DialogDescription>{editing ? 'Tick the roles that may open it. The change is kept when you save the dashboard.' : 'Choose Edit on the dashboard to change this list.'}</DialogDescription>
        </DialogHeader>
        <p className="rounded-md bg-muted/60 p-2.5 text-sm" data-testid="viewer-roles-summary">{viewerSummary(selected, roles)}</p>
        <p className="text-xs text-muted-foreground">{VIEWER_NOTE}</p>
        <div className="max-h-64 overflow-auto rounded-md border" role="group" aria-label="Roles that may view" data-testid="viewer-roles-list">
          {roles.length === 0 && <p className="p-3 text-sm text-muted-foreground">There are no security roles yet.</p>}
          {roles.map((r) => {
            const always = alwaysSees(r)
            return (
              <label key={r.id} className="flex items-start gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={always || selected.includes(r.id)} disabled={!editing || always}
                  onChange={(e) => onChange(toggleRole(selected, r.id, e.target.checked))} data-testid={`viewer-role-${r.id}`} />
                <span className="min-w-0">
                  <span className="font-medium">{r.name}</span>
                  {always && <span className="block text-xs text-muted-foreground">{r.isAdmin ? 'Administrators' : 'Makers'} open every dashboard.</span>}
                  {!always && r.description && <span className="block truncate text-xs text-muted-foreground">{r.description}</span>}
                </span>
              </label>
            )
          })}
        </div>
        {gone > 0 && <p className="text-xs text-muted-foreground" data-testid="viewer-roles-gone">{gone} listed {gone === 1 ? 'role no longer exists' : 'roles no longer exist'} and will be dropped when you save.</p>}
        <DialogFooter><Button size="sm" onClick={onClose} data-testid="viewer-roles-close">Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
