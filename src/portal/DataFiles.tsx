import { useRef, useState, type DragEvent } from 'react'
import { ArrowRightLeft, Download, FileJson, FileSpreadsheet, FileText, FileUp, HardDrive, Info, RefreshCw, Table2, Trash2, Upload } from 'lucide-react'
import { platform, usePlatform, type DataFileDef, type TableDef } from '@/platform'
import { go } from '@/router'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, Empty, Panel, PageHeader, fmtDate, useToast } from './kit'
import { matches, useSearch } from './Shell'

const KIND_ICON = { csv: FileText, xlsx: FileSpreadsheet, json: FileJson } as const
const EXT = /\.(csv|xlsx|json)$/i
const MAX_MB = 25

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function checkFile(f: File): string | null {
  if (!EXT.test(f.name)) return `"${f.name}" is not a .csv, .xlsx or .json file.`
  if (f.size > MAX_MB * 1024 * 1024) return `"${f.name}" is larger than ${MAX_MB} MB.`
  if (f.size === 0) return `"${f.name}" is empty.`
  return null
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function FileCard({ file, onReplace, onRemove, busy }: { file: DataFileDef; onReplace(f: DataFileDef): void; onRemove(f: DataFileDef): void; busy: boolean }) {
  const tables = usePlatform((s) => s.tables)
  const connections = usePlatform((s) => s.connections)
  const mode = usePlatform((s) => s.mode)
  const { fail, toast } = useToast()
  const [moving, setMoving] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  const Icon = KIND_ICON[file.kind] ?? FileText
  const own = file.tableIds.map((id) => tables.find((t) => t.id === id)).filter((t): t is TableDef => !!t)
  const dbDefault = connections.find((c) => c.isDefault && c.connector === 'mysql')
  const canMove = mode === 'server' && !!dbDefault

  const download = async () => {
    setDownloading(true)
    try {
      saveBlob(await platform.files.download(file.id), file.fileName)
    } catch (e) {
      fail(e)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Panel className="overflow-hidden" data-testid={`file-card-${file.id}`}>
      <div className="flex items-start gap-3 p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><Icon className="size-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold" data-testid="file-name">{file.fileName}</span>
            <Badge variant="outline" className="uppercase">{file.kind}</Badge>
            {file.modifiedSinceImport && <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300" title="Rows were changed through apps since the file was imported. Download to get the current contents." data-testid={`file-modified-${file.id}`}>Modified</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{fmtSize(file.sizeBytes)} · imported {fmtDate(file.importedOn)} · {own.length} {own.length === 1 ? 'table' : 'tables'}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Button size="xs" variant="outline" onClick={() => onReplace(file)} disabled={busy} data-testid={`file-replace-${file.id}`}><RefreshCw /> Replace</Button>
          <Button size="xs" variant="outline" onClick={() => void download()} disabled={downloading} data-testid={`file-download-${file.id}`}>{downloading ? <Spinner /> : <Download />} Download</Button>
          <Button size="xs" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onRemove(file)} data-testid={`file-remove-${file.id}`}><Trash2 /> Remove</Button>
        </div>
      </div>
      {own.length > 0 && (
        <ul role="list" className="border-t border-border bg-muted/30">
          {own.map((t) => (
            <li key={t.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0" data-testid={`file-table-${t.id}`}>
              <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
              <button type="button" onClick={() => go({ page: 'table', id: t.id })} className="min-w-0 truncate rounded text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40">{t.displayName}</button>
              {t.origin?.sheet && <span className="text-xs text-muted-foreground">sheet {t.origin.sheet}</span>}
              <span className="font-mono text-xs text-muted-foreground">{t.name}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{platform.tables.rows(t.name, { secure: false }).length} rows</span>
              {canMove && (
                <Button size="xs" variant="outline" disabled={moving === t.id} onClick={() => setMoveTarget({ id: t.id, name: t.displayName })} data-testid={`move-${t.id}`}>
                  {moving === t.id ? <Spinner /> : <ArrowRightLeft />} Move to database
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!moveTarget}
        onOpenChange={(o) => !o && setMoveTarget(null)}
        title={`Move "${moveTarget?.name ?? ''}" to the database?`}
        confirmLabel="Move to database"
        destructive={false}
        description={<>The rows are copied into a table in <strong>{dbDefault?.name}</strong> with the same name, so formulas and apps keep working. The table is then stored in the database instead of this file and can be used on a server. The file copy stays here.</>}
        onConfirm={async () => {
          if (!moveTarget || !dbDefault) return
          setMoving(moveTarget.id)
          try {
            await platform.tables.moveToConnection(moveTarget.id, dbDefault.id)
            toast(`"${moveTarget.name}" now lives in ${dbDefault.name}`, 'success')
          } finally {
            setMoving(null)
          }
        }}
      />
    </Panel>
  )
}

export function DataFiles() {
  const files = usePlatform((s) => s.dataFiles)
  const mode = usePlatform((s) => s.mode)
  const q = useSearch()
  const { fail, toast } = useToast()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState('')
  const [replacing, setReplacing] = useState<DataFileDef | null>(null)
  const [removing, setRemoving] = useState<DataFileDef | null>(null)
  const [confirmReplace, setConfirmReplace] = useState<DataFileDef | null>(null)
  const [dropTables, setDropTables] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const list = files.filter((f) => matches(q, f.fileName, f.kind))
  const demo = mode !== 'server'

  const addAll = async (picked: File[]) => {
    for (const f of picked) {
      const bad = checkFile(f)
      if (bad) { fail(new Error(bad)); continue }
      setBusy(`Adding ${f.name}...`)
      try {
        const d = await platform.files.add(f)
        toast(`Added ${d.fileName}: ${d.tableIds.length} ${d.tableIds.length === 1 ? 'table' : 'tables'} created`, 'success')
      } catch (e) {
        fail(e)
      }
    }
    setBusy('')
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void addAll([...e.dataTransfer.files])
  }
  const doReplace = async (f: File) => {
    if (!replacing) return
    const bad = checkFile(f)
    if (bad) { fail(new Error(bad)); return }
    setBusy(`Replacing ${replacing.fileName}...`)
    try {
      const d = await platform.files.replace(replacing.id, f)
      toast(`Replaced ${d.fileName}`, 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy('')
      setReplacing(null)
    }
  }

  return (
    <div data-testid="data-files-page">
      <PageHeader
        icon={HardDrive}
        title="Data files"
        subtitle="Work with CSV, Excel and JSON files as tables. Appbuilder keeps its own copy; the original is never changed."
        actions={<Button size="sm" onClick={() => addRef.current?.click()} disabled={!!busy} data-testid="add-file-button"><Upload /> Add file</Button>}
      />
      <input ref={addRef} type="file" multiple accept=".csv,.xlsx,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label="Choose data files" data-testid="data-file-input"
        onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void addAll(f) }} />
      <input ref={replaceRef} type="file" accept=".csv,.xlsx,.json" className="sr-only" aria-label="Choose the newer version of the file" data-testid="data-file-replace-input"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doReplace(f); else setReplacing(null) }} />

      <Alert className="mb-4" data-testid="data-files-note">
        <Info />
        <AlertTitle>{demo ? 'Demo mode' : 'Device only'}</AlertTitle>
        <AlertDescription>
          {demo
            ? 'In this browser demo, files are parsed into ordinary tables stored in browser storage. Moving tables to a database and keeping a file copy need the local server.'
            : 'Files and their tables stay on this machine and are not synced or exposed beyond it. To take the data online, move a table to the database or package it in a solution.'}
        </AlertDescription>
      </Alert>

      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn('mb-5 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', over ? 'border-primary bg-accent/60' : 'border-border bg-card/50')}
        data-testid="file-dropzone"
      >
        {busy ? <Spinner className="size-5" /> : <FileUp className="size-6 text-muted-foreground" />}
        <div className="text-sm font-medium">{busy || 'Drop .csv, .xlsx or .json files here'}</div>
        {!busy && (
          <>
            <p className="text-xs text-muted-foreground">One table per sheet (Excel), per file (CSV) or per top-level array (JSON). The first row is the header. Up to {MAX_MB} MB.</p>
            <Button variant="outline" size="sm" onClick={() => addRef.current?.click()}>Choose files</Button>
          </>
        )}
      </div>

      {files.length === 0 ? (
        <Empty icon={FileSpreadsheet} title="No data files yet" description="Add a file to work with it like any table. Edits are written to the copy; download it any time." />
      ) : list.length === 0 ? (
        <Empty icon={FileSpreadsheet} title="No matching files" description={`Nothing matches "${q}".`} />
      ) : (
        <div className="grid gap-3" data-testid="data-files-list">
          {list.map((f) => (
            <FileCard
              key={f.id}
              file={f}
              busy={!!busy}
              onReplace={(d) => { if (d.modifiedSinceImport) setConfirmReplace(d); else { setReplacing(d); setTimeout(() => replaceRef.current?.click(), 0) } }}
              onRemove={(d) => { setDropTables(false); setRemoving(d) }}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmReplace}
        onOpenChange={(o) => !o && setConfirmReplace(null)}
        title={`Replace "${confirmReplace?.fileName ?? ''}"?`}
        confirmLabel="Choose newer file"
        destructive={false}
        description="Rows were edited through apps since this file was imported. Replacing overwrites those edits with the contents of the file you choose. Download the current copy first if you want to keep them."
        onConfirm={() => { setReplacing(confirmReplace); setTimeout(() => replaceRef.current?.click(), 0) }}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove "${removing?.fileName ?? ''}"?`}
        confirmLabel="Remove file"
        description={
          <div className="grid gap-3">
            <p>The stored copy is deleted. Your original file on disk is not touched.{removing?.modifiedSinceImport ? ' It has edits that are not in your original: download it first if you need them.' : ''}</p>
            {!!removing?.tableIds.length && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox checked={dropTables} onCheckedChange={(v) => setDropTables(v === true)} className="mt-0.5" data-testid="remove-drop-tables" />
                <span>Also delete the {removing.tableIds.length} {removing.tableIds.length === 1 ? 'table' : 'tables'} created from this file<span className="block text-xs text-muted-foreground">Otherwise the tables stay, without a file behind them.</span></span>
              </label>
            )}
          </div>
        }
        onConfirm={async () => {
          if (!removing) return
          await platform.files.remove(removing.id, { dropTables })
          toast(`Removed ${removing.fileName}`, 'success')
        }}
      />
    </div>
  )
}
