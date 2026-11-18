import { useState } from 'react'
import { Boxes, Copy, EllipsisVertical, ExternalLink, PanelTop, Pencil, SquarePen, Trash2, Upload } from 'lucide-react'
import { platform, type AppMeta } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ConfirmDialog, TextDialog, useToast } from './kit'
import { AddToSolutionDialog, ExportDialog } from './dialogs'
import { openAppTab } from './workspace'
import { useOpenInWindow } from './UserMode'

/** Row/card action menu for an app. Owns its dialogs. */
export function AppMenu({ app, className }: { app: AppMeta; className?: string }) {
  const { fail, toast } = useToast()
  const inWindow = useOpenInWindow()
  const [dlg, setDlg] = useState<'rename' | 'export' | 'solution' | 'delete' | null>(null)
  const close = (o: boolean) => { if (!o) setDlg(null) }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className={className} aria-label={`Actions for ${app.name}`} data-testid={`app-menu-${app.id}`} onClick={(e) => e.stopPropagation()}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => go({ page: 'studio', id: app.id })}><SquarePen /> Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openAppTab(app.id)}><PanelTop /> Run in a tab</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => inWindow(app.id)}><ExternalLink /> Run in new window</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDlg('rename')}><Pencil /> Rename</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              platform.apps.duplicate(app.id).then((m) => toast(`Created "${m.name}"`, 'success')).catch(fail)
            }}
          >
            <Copy /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDlg('export')}><Upload /> Export package</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDlg('solution')}><Boxes /> Add to solution</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDlg('delete')}><Trash2 /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TextDialog open={dlg === 'rename'} onOpenChange={close} title="Rename app" label="App name" initial={app.name} onSubmit={(v) => platform.apps.rename(app.id, v)} />
      <ExportDialog open={dlg === 'export'} onOpenChange={close} kind="app" id={app.id} title={app.name} />
      <AddToSolutionDialog open={dlg === 'solution'} onOpenChange={close} kind="app" componentId={app.id} label={app.name} />
      <ConfirmDialog
        open={dlg === 'delete'}
        onOpenChange={close}
        title={`Delete "${app.name}"?`}
        description="The app is removed from this workspace and from any solutions. Tables and their data are not affected."
        onConfirm={async () => {
          await platform.apps.remove(app.id)
          toast(`Deleted "${app.name}"`, 'success')
        }}
      />
    </>
  )
}
