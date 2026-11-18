import { useEffect, useRef, useState } from 'react'
import { FileUp, Table2 } from 'lucide-react'
import { platform, usePlatform, type AppMeta, type SolutionComponentKind, type SolutionDef, type TableDef } from '@/platform'
import { go } from '@/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CodeDialog, Empty, Field, Segmented, slugName, useToast } from './kit'
import { createAppWithData } from './actions'
import { SizePicker } from './SizePicker'
import { sizeError } from '@/runtime/sizes'

/* ------------------------------------------------------------------ new app */

export function NewAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [name, setName] = useState('')
  const [size, setSize] = useState({ w: 1920, h: 1080 })
  const [scale, setScale] = useState<'responsive' | 'fit'>('responsive')
  const [busy, setBusy] = useState(false)
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    if (open) { setName(''); setScale('responsive'); setSize({ w: 1920, h: 1080 }); setEpoch((e) => e + 1) }
  }, [open])

  const { w, h } = size
  const customError = sizeError(w, h) ?? ''

  const create = async () => {
    if (!name.trim() || customError) return
    setBusy(true)
    try {
      const meta = await platform.apps.create({ name: name.trim(), width: w, height: h, template: 'blank' })
      if (scale === 'fit') {
        const def = await platform.apps.load(meta.id)
        if (def) await platform.apps.save(meta.id, { ...def, scaleMode: 'fit' })
      }
      toast(`Created "${meta.name}"`, 'success')
      onOpenChange(false)
      go({ page: 'studio', id: meta.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-app-dialog">
        <DialogHeader>
          <DialogTitle>New blank app</DialogTitle>
          <DialogDescription>Pick the device you design for. Desktop apps adapt to any window size; phone and tablet apps can be portrait.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <Field label="App name" htmlFor="new-app-name">
            <Input id="new-app-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Field inspections" data-testid="new-app-name" />
          </Field>
          <Field label="Design size">
            <SizePicker key={epoch} value={size} onChange={setSize} testId="new-app-size" />
            {customError && <p className="text-xs text-destructive">{customError}</p>}
          </Field>
          <Field label="Scaling" hint={scale === 'responsive' ? 'Controls follow their anchors as the window changes size.' : 'The design is scaled uniformly and letterboxed.'}>
            <Segmented label="Scaling" value={scale} onChange={setScale} options={[{ value: 'responsive', label: 'Responsive' }, { value: 'fit', label: 'Fit (letterbox)' }]} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim() || !!customError} data-testid="new-app-create">Create and open</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ start with data */

export function StartWithDataDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const tables = usePlatform((s) => s.tables)
  const { fail, toast } = useToast()
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [tableId, setTableId] = useState('')
  const [newName, setNewName] = useState('')
  const [size, setSize] = useState({ w: 1920, h: 1080 })
  const [epoch, setEpoch] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setNewName('')
    setSize({ w: 1920, h: 1080 })
    setEpoch((e) => e + 1)
    setMode(tables.length ? 'existing' : 'new')
    setTableId(tables[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const run = async () => {
    setBusy(true)
    try {
      let table: TableDef | undefined
      if (mode === 'existing') table = tables.find((t) => t.id === tableId)
      else {
        table = await platform.tables.create({ displayName: newName.trim(), columns: [{ displayName: 'Name', type: 'text', name: 'Name' }] })
      }
      if (!table) return
      const meta = await createAppWithData(table, size)
      toast(`Created "${meta.name}" from ${table.displayName}`, 'success')
      onOpenChange(false)
      go({ page: 'studio', id: meta.id })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const badSize = sizeError(size.w, size.h)
  const ok = (mode === 'existing' ? !!tableId : !!newName.trim()) && !badSize

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="start-with-data-dialog">
        <DialogHeader>
          <DialogTitle>Start with data</DialogTitle>
          <DialogDescription>Creates an app with a list and an edit form already connected to your table. Phone apps get the list and the form on separate screens.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (ok) void run() }}>
          <Segmented label="Table source" value={mode} onChange={setMode} options={[{ value: 'existing', label: 'Use an existing table' }, { value: 'new', label: 'Create a new table' }]} />
          {mode === 'existing' ? (
            tables.length === 0 ? (
              <Empty icon={Table2} title="No tables yet" description="Create a new table to start with." />
            ) : (
              <Field label="Table">
                <Select value={tableId} onValueChange={setTableId}>
                  <SelectTrigger className="w-full" data-testid="start-table-select"><SelectValue placeholder="Choose a table" /></SelectTrigger>
                  <SelectContent>
                    {tables.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.displayName} ({platform.tables.rows(t.name, { secure: false }).length} rows)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )
          ) : (
            <Field label="Table name" hint="You can add columns afterwards in the table designer.">
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Inspections" data-testid="start-new-table-name" />
            </Field>
          )}
          <Field label="Design size">
            <SizePicker key={epoch} value={size} onChange={setSize} testId="start-size" />
            {badSize && <p className="text-xs text-destructive">{badSize}</p>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !ok} data-testid="start-with-data-create">Create app</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ import package */

export function ImportDialog({ open, onOpenChange, kind, onDone }: { open: boolean; onOpenChange(o: boolean): void; kind: 'app' | 'solution'; onDone?(result: AppMeta | SolutionDef): void }) {
  const { fail, toast } = useToast()
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [filesAs, setFilesAs] = useState<'database' | 'file'>('database')
  const server = usePlatform((s) => s.mode) === 'server'
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setText(''); setFileName(''); setFilesAs('database') } }, [open])

  const pick = async (f: File | undefined) => {
    if (!f) return
    try {
      setText(await f.text())
      setFileName(f.name)
    } catch (e) {
      fail(e)
    }
  }
  const run = async () => {
    setBusy(true)
    try {
      const res = kind === 'app' ? await platform.apps.importPackage(text) : await platform.solutions.importPackage(text, server ? { filesAs } : undefined)
      toast(`Imported ${kind} "${'displayName' in res ? res.displayName : res.name}"`, 'success')
      onOpenChange(false)
      onDone?.(res)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="import-dialog">
        <DialogHeader>
          <DialogTitle>Import {kind} package</DialogTitle>
          <DialogDescription>Paste the package YAML or choose a file. Importing always creates new copies and never overwrites existing work.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setFileName('') }}
            spellCheck={false}
            placeholder={`kind: appbuilder/${kind}\npackageVersion: 1\n...`}
            aria-label="Package YAML"
            data-testid="import-text"
            className="h-56 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".yaml,.yml,.txt,text/yaml,text/plain" className="sr-only" data-testid="import-file" aria-label="Choose package file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><FileUp /> Choose file</Button>
            {fileName && <span className="truncate text-xs text-muted-foreground">{fileName}</span>}
          </div>
          {kind === 'solution' && server && (
            <Field label="Data files in the package" hint="Only applies to solutions that contain data files. Database tables are the default.">
              <select value={filesAs} onChange={(e) => setFilesAs(e.target.value as 'database' | 'file')} data-testid="import-files-as" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="database">Import as database tables</option>
                <option value="file">Keep as data files</option>
              </select>
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !text.trim()} onClick={() => void run()} data-testid="import-run">Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ export package */

export function ExportDialog({ open, onOpenChange, kind, id, title }: { open: boolean; onOpenChange(o: boolean): void; kind: 'app' | 'solution'; id: string; title: string }) {
  const { fail } = useToast()
  const [includeData, setIncludeData] = useState(false)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (open) setIncludeData(false) }, [open])
  useEffect(() => {
    if (!open) return
    let dead = false
    setLoading(true)
    const p = kind === 'app' ? platform.apps.exportPackage(id, { includeData }) : platform.solutions.exportPackage(id, { includeData })
    p.then((t) => { if (!dead) setText(t) }).catch((e) => { if (!dead) { setText(''); fail(e) } }).finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, id, includeData])
  return (
    <CodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Export ${kind}: ${title}`}
      description="A portable package you can store, share, or import into another workspace."
      text={text}
      loading={loading}
      filename={`${slugName(title) || kind}.${kind}.yaml`}
      extra={
        <div className="flex items-center gap-2">
          <Switch id="export-include-data" checked={includeData} onCheckedChange={setIncludeData} data-testid="export-include-data" />
          <Label htmlFor="export-include-data" className="text-sm font-normal">Include table data (rows)</Label>
        </div>
      }
    />
  )
}

/* ------------------------------------------------------------------ add component to solution */

export function AddToSolutionDialog({ open, onOpenChange, kind, componentId, label }: { open: boolean; onOpenChange(o: boolean): void; kind: SolutionComponentKind; componentId: string; label: string }) {
  const solutions = usePlatform((s) => s.solutions)
  const { fail, toast } = useToast()
  const [sel, setSel] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setSel(solutions[0]?.id ?? '') }, [open, solutions])
  const add = async () => {
    setBusy(true)
    try {
      await platform.solutions.addComponent(sel, kind, componentId)
      toast(`Added "${label}" to ${solutions.find((s) => s.id === sel)?.displayName ?? 'solution'}`, 'success')
      onOpenChange(false)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-to-solution-dialog">
        <DialogHeader>
          <DialogTitle>Add to solution</DialogTitle>
          <DialogDescription>Add "{label}" to a solution so it can be exported with the rest.</DialogDescription>
        </DialogHeader>
        {solutions.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no solutions yet. Create one on the Solutions page first.</p>
        ) : (
          <Field label="Solution">
            <Select value={sel} onValueChange={setSel}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose a solution" /></SelectTrigger>
              <SelectContent>{solutions.map((s) => <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !sel} onClick={() => void add()}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
