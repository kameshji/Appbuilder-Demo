/**
 * Dev mode > Print templates (P2 package B; maker guide docs/guide/maker/print-templates.md). The list (new, from a
 * built-in, Word template, letterhead) and the designer: block palette (click or drag), a page canvas with a fast
 * approximate preview and estimated page breaks, a properties panel, the data source with a field picker that inserts
 * {Field} into the focused property, header and footer, page setup and styles, draft / publish / versions, and the real
 * preview: the server's PDF of the draft for a sample record, embedded.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowUp, Copy, Eye, FileText, FileType2, GripVertical, History, LayoutTemplate, Loader2, Plus, Printer, Save, Settings2, Trash2, Upload, Rocket, TriangleAlert, Files,
} from 'lucide-react'
import { usePlatform } from '@/platform'
import type { TableDef } from '@/platform/contracts'
import {
  BLOCK_CATALOGUE, MM, newBlock, pageSizeMm, parseRichText, splitTemplateText, walkBlocks,
  type Block, type BlockKind, type PrintRunInfo, type PrintSettings, type PrintTemplateDoc, type PrintTemplateFull, type PrintTemplateInfo, type TableColumn,
} from '@/platform/print'
import { API_BASE, CSRF_HEADER } from '@/platform/http'
import { environmentHeaders } from '@/platform/environments'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { go } from '@/router'
import { ConfirmDialog, Empty, Field, PageHeader, Panel, TextDialog, fmtRelative, useToast } from '@/portal/kit'
import { useCaps } from '@/portal/security'
import { printApi, type BuiltinInfo, type PreviewResult } from './api'

const sel = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
const userTables = (tables: TableDef[]) => tables.filter((t) => !t.system || t.id === 'sys_documents')

/* ------------------------------------------------------------------ the page */

export function PrintTemplatesPage({ id }: { id?: string }) {
  const mode = usePlatform((s) => s.mode)
  if (mode !== 'server') {
    return (
      <div className="mx-auto max-w-3xl p-6" data-testid="print-templates-demo">
        <PageHeader icon={Printer} title="Print templates" subtitle="PDF documents from your records and queries." />
        <Empty icon={Printer} title="Print templates need the server" description="PDFs and Word files are made on the server (fonts, layout, your data read with your access). This demo runs in the browser only, so templates cannot be designed or printed here. Install Appbuilder with its server to use them." />
      </div>
    )
  }
  if (id) return <Designer id={id} />
  return <TemplateList />
}

function TemplateList() {
  const { fail, toast } = useToast()
  const caps = useCaps()
  const tables = usePlatform((s) => s.tables)
  const [items, setItems] = useState<PrintTemplateInfo[] | null>(null)
  const [dlg, setDlg] = useState<'' | 'new' | 'builtin' | 'docx' | 'settings'>('')
  const [del, setDel] = useState<PrintTemplateInfo | null>(null)
  const [copyOf, setCopyOf] = useState<PrintTemplateInfo | null>(null)
  const load = () => printApi.list().then((r) => setItems(r.items)).catch((e) => { fail(e); setItems([]) })
  useEffect(() => { void load() }, [])
  return (
    <div className="mx-auto max-w-6xl p-6" data-testid="print-templates-page">
      <PageHeader icon={Printer} title="Print templates" subtitle="PDF documents from your records and queries: inspection reports, summaries, challans. Word templates too."
        actions={<>
          {caps.isAdmin && <Button variant="outline" size="sm" onClick={() => setDlg('settings')} data-testid="print-settings-button"><Settings2 />Letterhead and formats</Button>}
          <Button variant="outline" size="sm" onClick={() => setDlg('docx')}><FileType2 />Word template</Button>
          <Button variant="outline" size="sm" onClick={() => setDlg('builtin')} data-testid="print-builtin-button"><LayoutTemplate />From a built-in</Button>
          <Button size="sm" onClick={() => setDlg('new')} data-testid="print-new-button"><Plus />New template</Button>
        </>} />
      {items === null ? <div className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Loading...</div>
        : !items.length ? <Empty icon={Printer} title="No print templates yet" description="Start from a built-in (inspection report, OEE summary, purchase request, delivery challan, record sheet, table list) or a blank page." />
          : (
            <Panel className="overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Table</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Changed</th><th /></tr></thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id} className="border-t hover:bg-muted/30" data-testid={`print-row-${t.name}`}>
                      <td className="px-3 py-2"><button type="button" className="font-medium hover:underline" onClick={() => go({ page: 'printtemplate', id: t.id })}>{t.name}</button>{t.description && <div className="max-w-md truncate text-xs text-muted-foreground">{t.description}</div>}</td>
                      <td className="px-3 py-2">{t.kind === 'docx' ? 'Word' : 'PDF'}</td>
                      <td className="px-3 py-2">{t.table ?? '-'}</td>
                      <td className="px-3 py-2">{t.status === 'published' ? <Badge variant="secondary">v{t.version}{t.dirty ? ' + draft' : ''}</Badge> : <Badge variant="outline">draft</Badge>}{typeof t.runAs === 'object' && <Badge variant="destructive" className="ml-1">service account</Badge>}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{fmtRelative(t.modifiedOn)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setCopyOf(t)} title="Copy"><Copy /></Button>
                        {t.canEdit && <Button variant="ghost" size="sm" onClick={() => setDel(t)} title="Delete"><Trash2 /></Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
      <NewDialog open={dlg === 'new'} onOpenChange={(o) => setDlg(o ? 'new' : '')} tables={userTables(tables)} />
      <BuiltinDialog open={dlg === 'builtin'} onOpenChange={(o) => setDlg(o ? 'builtin' : '')} tables={userTables(tables)} />
      <DocxDialog open={dlg === 'docx'} onOpenChange={(o) => setDlg(o ? 'docx' : '')} tables={userTables(tables)} />
      <SettingsDialog open={dlg === 'settings'} onOpenChange={(o) => setDlg(o ? 'settings' : '')} />
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete "${del?.name}"?`} description="The template and its versions are deleted. Documents already generated stay where they were stored." confirmLabel="Delete" destructive
        onConfirm={async () => { try { await printApi.remove(del!.id); toast('Deleted.'); setDel(null); void load() } catch (e) { fail(e) } }} />
      <TextDialog open={!!copyOf} onOpenChange={(o) => !o && setCopyOf(null)} title="Copy template" label="Name of the copy" initial={copyOf ? `${copyOf.name} (copy)` : ''}
        onSubmit={async (name: string) => { try { const r = await printApi.copy(copyOf!.id, name); setCopyOf(null); go({ page: 'printtemplate', id: r.template.id }) } catch (e) { fail(e) } }} />
    </div>
  )
}

function NewDialog({ open, onOpenChange, tables }: { open: boolean; onOpenChange(o: boolean): void; tables: TableDef[] }) {
  const { fail } = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'record' | 'query' | 'none'>('record')
  const [table, setTable] = useState('')
  useEffect(() => { if (open) { setName(''); setKind('record'); setTable(tables[0]?.name ?? '') } }, [open])
  const create = async () => {
    try {
      const r = await printApi.catalog()
      const doc: PrintTemplateDoc = { ...r.empty, source: kind === 'record' ? { kind: 'record', table, related: [] } : kind === 'query' ? { kind: 'query', table, top: 1000 } : { kind: 'none' } }
      doc.body = [{ id: 'title', kind: 'heading', level: 1, text: name }]
      const t = await printApi.create({ name: name.trim(), doc })
      onOpenChange(false)
      go({ page: 'printtemplate', id: t.template.id })
    } catch (e) { fail(e) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New print template</DialogTitle><DialogDescription>Choose what one document prints: one record (with its related lists), the rows of a query, or nothing (fixed content and formulas).</DialogDescription></DialogHeader>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} data-testid="print-new-name" autoFocus /></Field>
        <Field label="Data source">
          <select className={sel} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} data-testid="print-new-kind">
            <option value="record">One record of a table</option><option value="query">Rows of a table (query)</option><option value="none">No data source</option>
          </select>
        </Field>
        {kind !== 'none' && <Field label="Table"><select className={sel} value={table} onChange={(e) => setTable(e.target.value)} data-testid="print-new-table">{tables.map((t) => <option key={t.id} value={t.name}>{t.displayName || t.name}</option>)}</select></Field>}
        <DialogFooter><Button disabled={!name.trim() || (kind !== 'none' && !table)} onClick={() => void create()} data-testid="print-new-create">Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BuiltinDialog({ open, onOpenChange, tables }: { open: boolean; onOpenChange(o: boolean): void; tables: TableDef[] }) {
  const { fail } = useToast()
  const [list, setList] = useState<BuiltinInfo[]>([])
  const [key, setKey] = useState('')
  const [table, setTable] = useState('')
  useEffect(() => { if (open) printApi.catalog().then((c) => { setList(c.builtins); setKey(c.builtins[0]?.key ?? '') }).catch(fail); setTable(tables[0]?.name ?? '') }, [open])
  const b = list.find((x) => x.key === key)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Start from a built-in template</DialogTitle><DialogDescription>A ready template becomes yours to edit. The manufacturing ones expect the tables and columns named below; change the names in the designer when yours differ.</DialogDescription></DialogHeader>
        <Field label="Template"><select className={sel} value={key} onChange={(e) => setKey(e.target.value)} data-testid="print-builtin-key">{list.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></Field>
        {b && <p className="text-xs text-muted-foreground">{b.description}<br /><span className="font-medium">Expects:</span> {b.expects}</p>}
        {b?.needsTable && <Field label="Table"><select className={sel} value={table} onChange={(e) => setTable(e.target.value)}>{tables.map((t) => <option key={t.id} value={t.name}>{t.displayName || t.name}</option>)}</select></Field>}
        <DialogFooter><Button disabled={!b} onClick={async () => { try { const r = await printApi.fromBuiltin(key, b?.needsTable ? table : undefined); onOpenChange(false); go({ page: 'printtemplate', id: r.template.id }) } catch (e) { fail(e) } }} data-testid="print-builtin-create">Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const fileToBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => rej(r.error); r.readAsDataURL(f) })
const fileToDataUrl = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f) })

function DocxDialog({ open, onOpenChange, tables }: { open: boolean; onOpenChange(o: boolean): void; tables: TableDef[] }) {
  const { fail } = useToast()
  const [name, setName] = useState('')
  const [table, setTable] = useState('')
  const [file, setFile] = useState<File | null>(null)
  useEffect(() => { if (open) { setName(''); setFile(null); setTable(tables[0]?.name ?? '') } }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Word template</DialogTitle><DialogDescription>Upload a .docx with merge fields: {'{Number}'}, loops {'{#Related.Lines}...{/Related.Lines}'} and conditions {'{#Result = "Fail"}...{/Result = "Fail"}'}. The result is a Word file; there is no conversion to PDF.</DialogDescription></DialogHeader>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Record of table"><select className={sel} value={table} onChange={(e) => setTable(e.target.value)}>{tables.map((t) => <option key={t.id} value={t.name}>{t.displayName || t.name}</option>)}</select></Field>
        <Field label="Word file (.docx)"><Input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <DialogFooter><Button disabled={!name.trim() || !file || !table} onClick={async () => {
          try {
            const c = await printApi.catalog()
            const r = await printApi.create({ name: name.trim(), kind: 'docx', doc: { ...c.empty, source: { kind: 'record', table, related: [] } }, docxBase64: await fileToBase64(file!), docxFileName: file!.name })
            onOpenChange(false)
            go({ page: 'printtemplate', id: r.template.id })
          } catch (e) { fail(e) }
        }}><Upload />Upload</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { fail, toast } = useToast()
  const [s, setS] = useState<PrintSettings | null>(null)
  useEffect(() => { if (open) printApi.settings().then((r) => setS(r.settings)).catch(fail) }, [open])
  if (!s) return null
  const lh = s.letterhead
  const setLh = (p: Partial<PrintSettings['letterhead']>) => setS({ ...s, letterhead: { ...lh, ...p } })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Letterhead and formats</DialogTitle><DialogDescription>Used by every print template of this environment. The GSTIN is printed as text; nothing computes tax.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company name"><Input value={lh.companyName} onChange={(e) => setLh({ companyName: e.target.value })} data-testid="lh-name" /></Field>
          <Field label="GSTIN"><Input value={lh.gstin ?? ''} onChange={(e) => setLh({ gstin: e.target.value })} /></Field>
          <Field label="Address"><Textarea rows={2} value={lh.address ?? ''} onChange={(e) => setLh({ address: e.target.value })} /></Field>
          <div className="space-y-2">
            <Field label="Phone"><Input value={lh.phone ?? ''} onChange={(e) => setLh({ phone: e.target.value })} /></Field>
            <Field label="Email"><Input value={lh.email ?? ''} onChange={(e) => setLh({ email: e.target.value })} /></Field>
          </div>
          <Field label="Website"><Input value={lh.website ?? ''} onChange={(e) => setLh({ website: e.target.value })} /></Field>
          <Field label="Logo (PNG or JPEG, at most 500 KB)">
            <div className="flex items-center gap-2">{lh.logo && <img src={lh.logo} alt="" className="h-8" />}<Input type="file" accept="image/png,image/jpeg" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setLh({ logo: await fileToDataUrl(f) }) }} />{lh.logo && <Button variant="ghost" size="sm" onClick={() => setLh({ logo: undefined })}>Remove</Button>}</div>
          </Field>
          <Field label="Digit grouping"><select className={sel} value={s.grouping} onChange={(e) => setS({ ...s, grouping: e.target.value as PrintSettings['grouping'] })}><option value="indian">Indian: 12,34,567.89</option><option value="international">International: 1,234,567.89</option></select></Field>
          <Field label="Date format"><select className={sel} value={s.dateFormat} onChange={(e) => setS({ ...s, dateFormat: e.target.value })}>{['dd-MM-yyyy', 'dd/MM/yyyy', 'd MMM yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy'].map((f) => <option key={f}>{f}</option>)}</select></Field>
          <Field label="Currency (blank: the environment's)"><Input value={s.currency ?? ''} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() || undefined })} placeholder="INR" /></Field>
          <Field label="Time zone (blank: the environment's)"><Input value={s.timeZone ?? ''} onChange={(e) => setS({ ...s, timeZone: e.target.value || undefined })} placeholder="Asia/Kolkata" /></Field>
        </div>
        <DialogFooter><Button onClick={async () => { try { await printApi.saveSettings(s); toast('Saved.'); onOpenChange(false) } catch (e) { fail(e) } }} data-testid="lh-save"><Save />Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ the designer */

type Sel = string // a block id, or 'page' | 'header' | 'footer' | 'source'

/** the text input that last had the focus: the field picker inserts {Field} there */
let insertTarget: ((text: string) => void) | null = null

function findBlock(doc: PrintTemplateDoc, id: string): Block | null {
  let hit: Block | null = null
  for (const list of [doc.body, doc.header.blocks, doc.footer.blocks]) walkBlocks(list, (b) => { if (b.id === id) hit = b })
  return hit
}
/** maps every block list of the document (immutable update) */
function mapLists(doc: PrintTemplateDoc, fn: (list: Block[]) => Block[]): PrintTemplateDoc {
  const deep = (list: Block[]): Block[] => fn(list).map((b) => b.kind === 'columns' ? { ...b, columns: b.columns.map((c) => ({ ...c, blocks: deep(c.blocks ?? []) })) } : b.kind === 'repeat' ? { ...b, blocks: deep(b.blocks ?? []) } : b)
  return { ...doc, body: deep(doc.body), header: { ...doc.header, blocks: deep(doc.header.blocks) }, footer: { ...doc.footer, blocks: deep(doc.footer.blocks) } }
}

function Designer({ id }: { id: string }) {
  const { fail, toast } = useToast()
  const tables = usePlatform((s) => s.tables)
  const [tpl, setTpl] = useState<PrintTemplateFull | null>(null)
  const [doc, setDoc] = useState<PrintTemplateDoc | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Sel>('page')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [record, setRecord] = useState('')
  const [records, setRecords] = useState<{ id: string; label: string }[]>([])
  const [versions, setVersions] = useState<{ version: number; savedOn: string; note: string | null }[] | null>(null)
  const [bulk, setBulk] = useState(false)
  const [runs, setRuns] = useState<PrintRunInfo[] | null>(null)

  useEffect(() => {
    printApi.get(id).then((r) => { setTpl(r.template); setDoc(r.template.doc); setName(r.template.name) }).catch(fail)
  }, [id])
  const srcTable = doc && (doc.source.kind === 'record' || doc.source.kind === 'query') ? tables.find((t) => t.name === (doc.source as { table: string }).table || t.id === (doc.source as { table: string }).table) : undefined
  useEffect(() => {
    if (!srcTable || doc?.source.kind !== 'record') { setRecords([]); return }
    const prim = srcTable.primaryColumn || 'id'
    fetch(`${API_BASE}/query`, { method: 'POST', credentials: 'same-origin', headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...environmentHeaders() }, body: JSON.stringify({ plan: { version: 2, table: srcTable.name, select: [prim], sort: [{ col: 'createdOn', dir: 'desc' }], take: { n: 50, from: 'start' } } }) })
      .then((r) => r.json()).then((b: { rows?: Record<string, unknown>[] }) => {
        const list = (b.rows ?? []).map((r) => ({ id: String(r.id), label: String(r[prim] ?? r.id) }))
        setRecords(list)
        setRecord((cur) => cur && list.some((x) => x.id === cur) ? cur : list[0]?.id ?? '')
      }).catch(() => setRecords([]))
  }, [srcTable?.name, doc?.source.kind])

  if (!tpl || !doc) return <div className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Loading...</div>
  const ro = !tpl.canEdit
  const update = (d: PrintTemplateDoc) => { setDoc(d); setDirty(true) }
  const updateBlock = (bid: string, patch: Partial<Block>) => update(mapLists(doc, (list) => list.map((b) => (b.id === bid ? ({ ...b, ...patch } as Block) : b))))
  const removeBlock = (bid: string) => { update(mapLists(doc, (list) => list.filter((b) => b.id !== bid))); setSelected('page') }
  const moveBlock = (bid: string, d: -1 | 1) => update(mapLists(doc, (list) => {
    const i = list.findIndex((b) => b.id === bid)
    if (i < 0 || i + d < 0 || i + d >= list.length) return list
    const next = list.slice()
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    return next
  }))
  const insertBody = (b: Block, at?: number) => {
    const body = doc.body.slice()
    const after = at ?? (doc.body.findIndex((x) => x.id === selected) + 1 || body.length)
    body.splice(after, 0, b)
    update({ ...doc, body })
    setSelected(b.id)
  }
  const moveToIndex = (bid: string, at: number) => {
    const i = doc.body.findIndex((b) => b.id === bid)
    if (i < 0) return
    const body = doc.body.slice()
    const [b] = body.splice(i, 1)
    body.splice(at > i ? at - 1 : at, 0, b)
    update({ ...doc, body })
  }
  const save = async (publish: boolean) => {
    setBusy(publish ? 'publish' : 'save')
    try {
      const r = await printApi.save(id, { name, doc, ...(publish ? { publish: true } : {}) })
      setTpl(r.template)
      setDoc(r.template.doc)
      setDirty(false)
      toast(publish ? `Published version ${r.template.version}.` : 'Draft saved.')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const runPreview = async () => {
    setBusy('preview')
    try {
      if (preview) URL.revokeObjectURL(preview.url)
      setPreview(await printApi.preview(id, record || undefined, doc))
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const sel0 = selected === 'page' || selected === 'header' || selected === 'footer' || selected === 'source' ? null : findBlock(doc, selected)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="print-designer">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => go({ page: 'printtemplates' })}><ArrowLeft />Templates</Button>
        <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} className="h-8 w-64" disabled={ro} data-testid="print-name" />
        {tpl.version ? <Badge variant="secondary">published v{tpl.version}</Badge> : <Badge variant="outline">never published</Badge>}
        {dirty && <Badge variant="outline">unsaved changes</Badge>}
        {ro && <Badge variant="outline">read-only</Badge>}
        {tpl.kind === 'docx' && <Badge variant="outline">Word: {tpl.docxFileName}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {doc.source.kind === 'record' && (
            <select className={cn(sel, 'w-48')} value={record} onChange={(e) => setRecord(e.target.value)} title="Sample record for the preview" data-testid="print-sample-record">
              {!records.length && <option value="">no records</option>}
              {records.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          )}
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void runPreview()} data-testid="print-preview-button">{busy === 'preview' ? <Loader2 className="animate-spin" /> : <Eye />}Preview PDF</Button>
          <Button variant="outline" size="sm" onClick={() => { setRuns(null); printApi.runs(id).then((r) => setRuns(r.items)).catch(fail) }}><Files />Log</Button>
          <Button variant="outline" size="sm" onClick={() => printApi.versions(id).then((r) => setVersions(r.items)).catch(fail)}><History />Versions</Button>
          {tpl.version > 0 && doc.source.kind === 'record' && <Button variant="outline" size="sm" onClick={() => setBulk(true)} data-testid="print-bulk-button"><Printer />Many records</Button>}
          {!ro && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void save(false)} data-testid="print-save"><Save />Save draft</Button>}
          {!ro && <Button size="sm" disabled={!!busy} onClick={() => void save(true)} data-testid="print-publish"><Rocket />Publish</Button>}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[230px_1fr_320px]">
        <aside className="min-h-0 overflow-auto border-r p-3 text-sm">
          {tpl.kind === 'pdf' && <Palette disabled={ro} onAdd={(k) => insertBody(newBlock(k))} />}
          <FieldTree doc={doc} tables={tables} />
        </aside>
        <main className="min-h-0 overflow-auto bg-muted/40 p-6">
          {tpl.kind === 'docx'
            ? <DocxPanel tpl={tpl} ro={ro} onUploaded={(t) => { setTpl(t); toast('Word file replaced (draft).') }} />
            : <PageCanvas doc={doc} selected={selected} onSelect={setSelected} onMove={moveBlock} onRemove={removeBlock} onDropNew={(k, at) => insertBody(newBlock(k), at)} onDropMove={moveToIndex} ro={ro} />}
          {preview && (
            <div className="mx-auto mt-6 max-w-4xl" data-testid="print-preview">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><FileText className="size-3.5" />Server PDF: <span data-testid="print-preview-pages">{preview.pages}</span> page(s), {Math.round(preview.bytes / 1024)} KB<a className="ml-auto underline" href={preview.url} target="_blank" rel="noreferrer" data-testid="print-preview-open">Open in a new tab</a><a className="underline" href={preview.url} download={`${name}.pdf`}>Download</a></div>
              {preview.warnings.length > 0 && <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="print-preview-warnings">{preview.warnings.map((w, i) => <div key={i}><TriangleAlert className="mr-1 inline size-3" />{w}</div>)}</div>}
              <iframe title="PDF preview" src={preview.frameUrl || preview.url} className="h-[80vh] w-full rounded-md border bg-white" />
            </div>
          )}
        </main>
        <aside className="min-h-0 overflow-auto border-l p-3 text-sm" data-testid="print-properties">
          <div className="mb-3 flex flex-wrap gap-1">
            {(['source', 'page', 'header', 'footer'] as const).map((k) => <Button key={k} size="sm" variant={selected === k ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setSelected(k)} data-testid={`print-tab-${k}`}>{k === 'source' ? 'Data' : k === 'page' ? 'Page' : k === 'header' ? 'Header' : 'Footer'}</Button>)}
          </div>
          {selected === 'source' && <SourcePanel doc={doc} tables={tables} ro={ro} onChange={update} />}
          {selected === 'page' && <PagePanel doc={doc} ro={ro} onChange={update} />}
          {(selected === 'header' || selected === 'footer') && <HeaderFooterPanel which={selected} doc={doc} ro={ro} onChange={update} />}
          {sel0 && <BlockPanel key={sel0.id} block={sel0} ro={ro} onChange={(p) => updateBlock(sel0.id, p)} onRemove={() => removeBlock(sel0.id)} />}
        </aside>
      </div>
      <Dialog open={!!versions} onOpenChange={(o) => !o && setVersions(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Published versions</DialogTitle><DialogDescription>Restoring puts an old version into the draft; publish it to use it.</DialogDescription></DialogHeader>
          <div className="max-h-80 space-y-1 overflow-auto">
            {versions?.length ? versions.map((v) => (
              <div key={v.version} className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm"><Badge variant="secondary">v{v.version}</Badge><span className="text-xs text-muted-foreground">{fmtRelative(v.savedOn)}{v.note ? ` · ${v.note}` : ''}</span>
                {!ro && <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { try { const r = await printApi.restore(id, v.version); setTpl(r.template); setDoc(r.template.doc); setDirty(false); setVersions(null); toast(`Version ${v.version} is in the draft.`) } catch (e) { fail(e) } }}>Restore</Button>}
              </div>
            )) : <p className="text-sm text-muted-foreground">Not published yet.</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!runs} onOpenChange={(o) => !o && setRuns(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Generation log</DialogTitle><DialogDescription>Every document made from this template: who, as whom, pages, time and warnings.</DialogDescription></DialogHeader>
          <div className="max-h-96 overflow-auto text-xs">
            {runs?.map((r) => (
              <div key={r.id} className="border-b py-1.5">
                <div className="flex gap-2"><Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge><span>{r.kind}</span><span>{r.source}</span><span className="text-muted-foreground">{fmtRelative(r.startedOn)}</span><span className="ml-auto">{r.pages} p · {Math.round(r.bytes / 1024)} KB · {r.ms} ms</span></div>
                <div className="text-muted-foreground">as {r.runAs}{r.progress ? ` · ${r.progress.done}/${r.progress.total}` : ''}{r.error ? ` · ${r.error}` : ''}</div>
                {r.warnings.slice(0, 5).map((w, i) => <div key={i} className="text-amber-700">{w}</div>)}
                {r.fileToken && r.status === 'succeeded' && <a className="underline" href={printApi.fileUrl(r.fileToken, true)}>Download</a>}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {srcTable && <BulkDialog open={bulk} onOpenChange={setBulk} templateId={id} table={srcTable} />}
    </div>
  )
}

/* ------------------------------------------------------------------ palette and field picker */

function Palette({ onAdd, disabled }: { onAdd(k: BlockKind): void; disabled: boolean }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Blocks</div>
      {(['Text', 'Data', 'Graphics', 'Layout'] as const).map((g) => (
        <div key={g} className="mb-2">
          <div className="text-[11px] text-muted-foreground">{g}</div>
          {BLOCK_CATALOGUE.filter((b) => b.group === g).map((b) => (
            <button key={b.kind} type="button" disabled={disabled} draggable={!disabled}
              onDragStart={(e) => e.dataTransfer.setData('application/x-print-block', b.kind)}
              onClick={() => onAdd(b.kind)} title={b.summary} data-testid={`palette-${b.kind}`}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent disabled:opacity-50">
              <GripVertical className="size-3 text-muted-foreground" />{b.title}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function FieldTree({ doc, tables }: { doc: PrintTemplateDoc; tables: TableDef[] }) {
  const t = (n: string) => tables.find((x) => x.name === n || x.id === n)
  const groups: { title: string; prefix: string; table?: TableDef }[] = []
  if (doc.source.kind === 'record') {
    groups.push({ title: 'Record', prefix: '', table: t(doc.source.table) })
    for (const r of doc.source.related ?? []) groups.push({ title: `Related.${r.name} (ThisItem)`, prefix: 'ThisItem.', table: t(r.table) })
  } else if (doc.source.kind === 'query') groups.push({ title: 'Rows (ThisItem)', prefix: 'ThisItem.', table: t(doc.source.table) })
  const extra = ['Company.Name', 'Company.Address', 'Company.GSTIN', 'User().FullName', 'FormatDate(Now())', 'PageNumber', 'PageCount', ...(doc.source.kind === 'record' ? (doc.source.related ?? []).map((r) => `Related.${r.name}`) : doc.source.kind === 'query' ? ['Rows', 'CountRows(Rows)'] : [])]
  const put = (s: string) => {
    if (insertTarget) insertTarget(s)
    else void navigator.clipboard?.writeText(s).catch(() => {})
  }
  return (
    <div data-testid="print-field-tree">
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Fields</div>
      <p className="mb-2 text-[11px] text-muted-foreground">Click a property, then a field: it is inserted as {'{Field}'} (formula properties get the bare name).</p>
      {groups.map((g) => (
        <div key={g.title} className="mb-2">
          <div className="text-[11px] text-muted-foreground">{g.title}</div>
          {(g.table?.columns ?? []).filter((c) => !c.system || c.name === 'createdOn').map((c) => (
            <button key={c.name} type="button" className="block w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs hover:bg-accent" onClick={() => put(`${g.prefix}${c.name}`)} data-testid={`field-${g.prefix}${c.name}`}>{g.prefix}{c.name}</button>
          ))}
        </div>
      ))}
      <div className="text-[11px] text-muted-foreground">More</div>
      {extra.map((x) => <button key={x} type="button" className="block w-full truncate rounded px-2 py-0.5 text-left font-mono text-xs hover:bg-accent" onClick={() => put(x)}>{x}</button>)}
    </div>
  )
}

/** a text property: {formula} parts; the field picker inserts {Field} at the caret */
function TextProp({ label, value, onChange, ro, multiline, formula, testid }: { label: string; value: string; onChange(v: string): void; ro: boolean; multiline?: boolean; formula?: boolean; testid?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  // the latest value and handler: the field picker inserts after the focus moved away, into what is typed by then
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const focus = () => {
    insertTarget = (s: string) => {
      const el = ref.current
      const ins = formula ? s : `{${s}}`
      const cur = el?.value ?? latest.current.value
      const a = el?.selectionStart ?? cur.length
      const b = el?.selectionEnd ?? cur.length
      latest.current.onChange(cur.slice(0, a) + ins + cur.slice(b))
    }
  }
  const Comp = multiline ? Textarea : Input
  return (
    <Field label={label}>
      <Comp ref={ref} value={value} disabled={ro} onFocus={focus} onChange={(e: { target: { value: string } }) => onChange(e.target.value)} className={cn('text-xs', formula && 'font-mono')} rows={multiline ? 5 : undefined} data-testid={testid} />
    </Field>
  )
}
const NumProp = ({ label, value, onChange, ro, testid }: { label: string; value: number | undefined; onChange(v: number | undefined): void; ro: boolean; testid?: string }) => (
  <Field label={label}><Input type="number" value={value ?? ''} disabled={ro} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className="text-xs" data-testid={testid} /></Field>
)
function SelProp<T extends string>({ label, value, options, onChange, ro, testid }: { label: string; value: T | undefined; options: (T | [T, string])[]; onChange(v: T): void; ro: boolean; testid?: string }) {
  return <Field label={label}><select className={sel} value={value ?? ''} disabled={ro} onChange={(e) => onChange(e.target.value as T)} data-testid={testid}>{options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option> })}</select></Field>
}
const BoolProp = ({ label, value, onChange, ro, testid }: { label: string; value: boolean | undefined; onChange(v: boolean): void; ro: boolean; testid?: string }) => (
  <label className="mb-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={!!value} disabled={ro} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />{label}</label>
)

/* ------------------------------------------------------------------ panels */

function SourcePanel({ doc, tables, ro, onChange }: { doc: PrintTemplateDoc; tables: TableDef[]; ro: boolean; onChange(d: PrintTemplateDoc): void }) {
  const s = doc.source
  const list = userTables(tables)
  const set = (src: PrintTemplateDoc['source']) => onChange({ ...doc, source: src })
  return (
    <div>
      <SelProp label="Data source" value={s.kind} ro={ro} options={[['record', 'One record'], ['query', 'Rows of a table'], ['formula', 'A formula'], ['none', 'None']]}
        onChange={(k) => set(k === 'record' ? { kind: 'record', table: list[0]?.name ?? '', related: [] } : k === 'query' ? { kind: 'query', table: list[0]?.name ?? '' } : k === 'formula' ? { kind: 'formula', formula: '' } : { kind: 'none' })} />
      {(s.kind === 'record' || s.kind === 'query') && <SelProp label="Table" value={s.table} ro={ro} options={list.map((t) => [t.name, t.displayName || t.name] as [string, string])} onChange={(v) => set({ ...s, table: v })} testid="print-source-table" />}
      {s.kind === 'query' && <>
        <TextProp label="Filter (formula over the row)" value={s.filter ?? ''} ro={ro} formula onChange={(v) => set({ ...s, filter: v })} />
        <NumProp label="At most rows" value={s.top} ro={ro} onChange={(v) => set({ ...s, top: v })} />
      </>}
      {s.kind === 'formula' && <TextProp label="Formula (a table or a record)" value={s.formula} ro={ro} formula multiline onChange={(v) => set({ ...s, formula: v })} />}
      {s.kind === 'record' && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold">Related lists</div>
          {(s.related ?? []).map((r, i) => {
            const ct = tables.find((t) => t.name === r.table)
            const setR = (p: Partial<typeof r>) => set({ ...s, related: (s.related ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) })
            return (
              <div key={i} className="mb-2 rounded border p-2">
                <TextProp label="Name (Related.<name>)" value={r.name} ro={ro} onChange={(v) => setR({ name: v })} testid={`related-name-${i}`} />
                <SelProp label="Table" value={r.table} ro={ro} options={list.map((t) => [t.name, t.displayName || t.name] as [string, string])} onChange={(v) => setR({ table: v, column: '' })} testid={`related-table-${i}`} />
                <SelProp label="Lookup column pointing at the record" value={r.column} ro={ro} options={[['', '—'] as [string, string], ...(ct?.columns ?? []).filter((c) => c.type === 'lookup').map((c) => [c.name, c.displayName || c.name] as [string, string])]} onChange={(v) => setR({ column: v })} testid={`related-column-${i}`} />
                <TextProp label="Filter (optional)" value={r.filter ?? ''} ro={ro} formula onChange={(v) => setR({ filter: v || undefined })} />
                {!ro && <Button size="sm" variant="ghost" onClick={() => set({ ...s, related: (s.related ?? []).filter((_, j) => j !== i) })}><Trash2 />Remove</Button>}
              </div>
            )
          })}
          {!ro && <Button size="sm" variant="outline" onClick={() => set({ ...s, related: [...(s.related ?? []), { name: `List${(s.related ?? []).length + 1}`, table: list[0]?.name ?? '', column: '' }] })} data-testid="related-add"><Plus />Related list</Button>}
        </div>
      )}
      <div className="mt-3"><TextProp label="File name (without .pdf)" value={doc.fileName ?? ''} ro={ro} onChange={(v) => onChange({ ...doc, fileName: v || undefined })} /></div>
    </div>
  )
}

function PagePanel({ doc, ro, onChange }: { doc: PrintTemplateDoc; ro: boolean; onChange(d: PrintTemplateDoc): void }) {
  const p = doc.page
  const st = doc.styles
  const setP = (x: Partial<typeof p>) => onChange({ ...doc, page: { ...p, ...x } })
  const setS = (x: Partial<typeof st>) => onChange({ ...doc, styles: { ...st, ...x } })
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <SelProp label="Size" value={p.size} ro={ro} options={['A4', 'A5', 'Letter', 'Legal', 'custom']} onChange={(v) => setP({ size: v })} testid="page-size" />
        <SelProp label="Orientation" value={p.orientation} ro={ro} options={['portrait', 'landscape']} onChange={(v) => setP({ orientation: v })} testid="page-orientation" />
        {p.size === 'custom' && <><NumProp label="Width (mm)" value={p.width} ro={ro} onChange={(v) => setP({ width: v })} /><NumProp label="Height (mm)" value={p.height} ro={ro} onChange={(v) => setP({ height: v })} /></>}
        {(['top', 'right', 'bottom', 'left'] as const).map((k) => <NumProp key={k} label={`Margin ${k} (mm)`} value={p.margins[k]} ro={ro} onChange={(v) => setP({ margins: { ...p.margins, [k]: v ?? 0 } })} />)}
      </div>
      <div className="mt-3 mb-1 text-xs font-semibold">Styles</div>
      <div className="grid grid-cols-2 gap-2">
        <NumProp label="Font size (pt)" value={st.fontSize} ro={ro} onChange={(v) => setS({ fontSize: v ?? 10 })} />
        <SelProp label="Table style" value={st.tableStyle} ro={ro} options={['zebra', 'lines', 'grid', 'plain']} onChange={(v) => setS({ tableStyle: v })} />
        {(['color', 'headingColor', 'accent'] as const).map((k) => <Field key={k} label={k === 'color' ? 'Text colour' : k === 'headingColor' ? 'Heading colour' : 'Accent colour'}><input type="color" value={st[k]} disabled={ro} onChange={(e) => setS({ [k]: e.target.value })} className="h-8 w-full" /></Field>)}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">Fonts: Noto Sans and Noto Sans Devanagari (Hindi), embedded in every PDF. Templates are a fixed set of blocks, not HTML.</p>
    </div>
  )
}

function HeaderFooterPanel({ which, doc, ro, onChange }: { which: 'header' | 'footer'; doc: PrintTemplateDoc; ro: boolean; onChange(d: PrintTemplateDoc): void }) {
  const hf = doc[which]
  const set = (x: Partial<typeof hf>) => onChange({ ...doc, [which]: { ...hf, ...x } })
  return (
    <div>
      {which === 'header' && <SelProp label="Letterhead" value={hf.letterhead ?? 'first'} ro={ro} options={[['first', 'On the first page'], ['all', 'On every page'], ['none', 'None']]} onChange={(v) => set({ letterhead: v })} />}
      {which === 'footer' && <BoolProp label='"Page X of Y" at the right' value={hf.pageNumbers !== false} ro={ro} onChange={(v) => set({ pageNumbers: v })} />}
      <TextProp label="Left" value={hf.left ?? ''} ro={ro} onChange={(v) => set({ left: v || undefined })} testid={`${which}-left`} />
      <TextProp label="Center" value={hf.center ?? ''} ro={ro} onChange={(v) => set({ center: v || undefined })} />
      <TextProp label="Right" value={hf.right ?? ''} ro={ro} onChange={(v) => set({ right: v || undefined })} />
      <p className="text-[11px] text-muted-foreground">{'{PageNumber}'} and {'{PageCount}'} work here. Blocks of the {which}: select one on the page.</p>
      {!ro && <Button size="sm" variant="outline" className="mt-2" onClick={() => set({ blocks: [...hf.blocks, newBlock('text')] })}><Plus />Text block in the {which}</Button>}
    </div>
  )
}

function BlockPanel({ block: b, ro, onChange, onRemove }: { block: Block; ro: boolean; onChange(p: Partial<Block>): void; onRemove(): void }) {
  const doc = BLOCK_CATALOGUE.find((x) => x.kind === b.kind)
  const set = onChange as (p: Record<string, unknown>) => void
  return (
    <div data-testid={`block-panel-${b.kind}`}>
      <div className="mb-2 flex items-center gap-2"><span className="font-semibold">{doc?.title}</span><span className="text-[11px] text-muted-foreground">{b.id}</span>{!ro && <Button size="sm" variant="ghost" className="ml-auto" onClick={onRemove}><Trash2 /></Button>}</div>
      {b.kind === 'heading' && <>
        <TextProp label="Text" value={b.text} ro={ro} onChange={(v) => set({ text: v })} testid="prop-text" />
        <SelProp label="Level" value={String(b.level) as '1' | '2' | '3'} ro={ro} options={['1', '2', '3']} onChange={(v) => set({ level: Number(v) })} />
        <SelProp label="Align" value={b.align ?? 'left'} ro={ro} options={['left', 'center', 'right']} onChange={(v) => set({ align: v })} />
      </>}
      {b.kind === 'text' && <>
        <TextProp label="Text (**bold**, *italic*, __underline__, [color=#c00]…[/color], - bullets, 1. numbers)" value={b.text} multiline ro={ro} onChange={(v) => set({ text: v })} testid="prop-text" />
        <SelProp label="Align" value={b.align ?? 'left'} ro={ro} options={['left', 'center', 'right', 'justify']} onChange={(v) => set({ align: v })} />
        <NumProp label="Size (pt)" value={b.size} ro={ro} onChange={(v) => set({ size: v })} />
      </>}
      {b.kind === 'keyValue' && <>
        <SelProp label="Columns" value={String(b.columns ?? 2) as '1'} ro={ro} options={['1', '2', '3', '4']} onChange={(v) => set({ columns: Number(v) })} />
        <BoolProp label="Boxed (KPI tiles)" value={b.boxed} ro={ro} onChange={(v) => set({ boxed: v })} />
        <ListEditor ro={ro} items={b.items} onChange={(items) => set({ items })} make={(): Extract<Block, { kind: 'keyValue' }>['items'][number] => ({ label: 'Label', value: '' })} render={(it, up) => <>
          <TextProp label="Label" value={it.label} ro={ro} onChange={(v) => up({ ...it, label: v })} />
          <TextProp label="Value (formula)" value={it.value} ro={ro} formula onChange={(v) => up({ ...it, value: v })} />
          <SelProp label="Format" value={it.format ?? 'text'} ro={ro} options={['text', 'number', 'integer', 'currency', 'percent', 'date', 'datetime', 'boolean']} onChange={(v) => up({ ...it, format: v })} />
        </>} />
      </>}
      {b.kind === 'table' && <>
        <TextProp label="Rows (formula)" value={b.rows} ro={ro} formula onChange={(v) => set({ rows: v })} testid="prop-rows" />
        <SelProp label="Style" value={b.style ?? 'zebra'} ro={ro} options={['zebra', 'lines', 'grid', 'plain']} onChange={(v) => set({ style: v })} />
        <BoolProp label="Totals row" value={b.totals} ro={ro} onChange={(v) => set({ totals: v })} testid="prop-totals" />
        <TextProp label="Group by (formula, optional)" value={b.groupBy ?? ''} ro={ro} formula onChange={(v) => set({ groupBy: v || undefined })} />
        {b.groupBy && <><TextProp label="Group header" value={b.groupHeader ?? ''} ro={ro} onChange={(v) => set({ groupHeader: v || undefined })} /><BoolProp label="Subtotals" value={b.subtotals} ro={ro} onChange={(v) => set({ subtotals: v })} /></>}
        <BoolProp label="Repeat the header on every page" value={b.repeatHeader !== false} ro={ro} onChange={(v) => set({ repeatHeader: v })} />
        <TextProp label="When there are no rows" value={b.emptyText ?? ''} ro={ro} onChange={(v) => set({ emptyText: v || undefined })} />
        <div className="mt-2 mb-1 text-xs font-semibold">Columns</div>
        <ListEditor ro={ro} items={b.columns} onChange={(columns) => set({ columns })} make={(): TableColumn => ({ header: 'Column', value: 'ThisItem.' })} render={(c, up) => <>
          <TextProp label="Header" value={c.header} ro={ro} onChange={(v) => up({ ...c, header: v })} />
          <TextProp label="Value (formula over ThisItem)" value={c.value} ro={ro} formula onChange={(v) => up({ ...c, value: v })} testid="prop-col-value" />
          <div className="grid grid-cols-2 gap-2">
            <NumProp label="Width (mm; blank: share)" value={c.width} ro={ro} onChange={(v) => up({ ...c, width: v })} />
            <SelProp label="Format" value={c.format ?? 'text'} ro={ro} options={['text', 'number', 'integer', 'currency', 'percent', 'date', 'datetime', 'boolean']} onChange={(v) => up({ ...c, format: v })} />
            <SelProp label="Align" value={c.align ?? 'left'} ro={ro} options={['left', 'center', 'right']} onChange={(v) => up({ ...c, align: v })} />
            <SelProp label="Total" value={c.total ?? ''} ro={ro} options={[['', 'none'], 'sum', 'count', 'avg', 'min', 'max', 'label'] as ('' | ['', string] | 'sum')[] as never} onChange={(v) => up({ ...c, total: (v || undefined) as TableColumn['total'] })} />
          </div>
        </>} />
      </>}
      {b.kind === 'repeat' && <>
        <TextProp label="Rows (formula)" value={b.rows} ro={ro} formula onChange={(v) => set({ rows: v })} />
        <BoolProp label="A new page per row" value={b.pageBreakBetween} ro={ro} onChange={(v) => set({ pageBreakBetween: v })} />
        <ChildBlocks ro={ro} blocks={b.blocks} onChange={(blocks) => set({ blocks })} />
      </>}
      {b.kind === 'columns' && <>
        <NumProp label="Gap (mm)" value={b.gap} ro={ro} onChange={(v) => set({ gap: v })} />
        {b.columns.map((c, i) => (
          <div key={i} className="mb-2 rounded border p-2">
            <div className="text-xs font-semibold">Column {i + 1}</div>
            <NumProp label="Width (mm; blank: share)" value={c.width} ro={ro} onChange={(v) => set({ columns: b.columns.map((x, j) => (j === i ? { ...x, width: v } : x)) })} />
            <ChildBlocks ro={ro} blocks={c.blocks} onChange={(blocks) => set({ columns: b.columns.map((x, j) => (j === i ? { ...x, blocks } : x)) })} />
          </div>
        ))}
        {!ro && b.columns.length < 4 && <Button size="sm" variant="outline" onClick={() => set({ columns: [...b.columns, { blocks: [] }] })}><Plus />Column</Button>}
      </>}
      {b.kind === 'image' && <>
        <SelProp label="Source" value={b.source} ro={ro} options={[['logo', 'Letterhead logo'], ['static', 'Uploaded image'], ['attachment', 'Image or file column']]} onChange={(v) => set({ source: v })} />
        {b.source === 'static' && <Field label="Image (PNG or JPEG)"><Input type="file" accept="image/png,image/jpeg" disabled={ro} onChange={async (e) => { const f = e.target.files?.[0]; if (f) set({ data: await fileToDataUrl(f) }) }} /></Field>}
        {b.source === 'attachment' && <TextProp label="Images (formula)" value={b.value ?? ''} ro={ro} formula onChange={(v) => set({ value: v })} />}
        <div className="grid grid-cols-2 gap-2"><NumProp label="Width (mm)" value={b.width} ro={ro} onChange={(v) => set({ width: v })} /><NumProp label="Height (mm)" value={b.height} ro={ro} onChange={(v) => set({ height: v })} /></div>
        <NumProp label="Images per row" value={b.perRow} ro={ro} onChange={(v) => set({ perRow: v })} />
        <SelProp label="Align" value={b.align ?? 'left'} ro={ro} options={['left', 'center', 'right']} onChange={(v) => set({ align: v })} />
      </>}
      {b.kind === 'barcode' && <>
        <SelProp label="Kind" value={b.symbology} ro={ro} options={[['code128', 'Code 128 barcode'], ['qr', 'QR code']]} onChange={(v) => set({ symbology: v })} />
        <TextProp label="Text (formula)" value={b.value} ro={ro} formula onChange={(v) => set({ value: v })} />
        <div className="grid grid-cols-2 gap-2"><NumProp label="Width (mm)" value={b.width} ro={ro} onChange={(v) => set({ width: v })} />{b.symbology === 'code128' && <NumProp label="Height (mm)" value={b.height} ro={ro} onChange={(v) => set({ height: v })} />}</div>
        <BoolProp label="Print the text" value={b.showText ?? b.symbology === 'code128'} ro={ro} onChange={(v) => set({ showText: v })} />
      </>}
      {b.kind === 'chart' && <>
        <SelProp label="Chart" value={b.chartType} ro={ro} options={['bar', 'line', 'pie', 'gauge']} onChange={(v) => set({ chartType: v })} />
        <TextProp label="Title" value={b.title ?? ''} ro={ro} onChange={(v) => set({ title: v || undefined })} />
        {b.chartType !== 'gauge' && <><TextProp label="Rows (formula)" value={b.rows ?? ''} ro={ro} formula onChange={(v) => set({ rows: v })} /><TextProp label="Category (formula over ThisItem)" value={b.label ?? ''} ro={ro} formula onChange={(v) => set({ label: v })} /></>}
        {b.chartType === 'gauge' && <div className="grid grid-cols-2 gap-2"><NumProp label="Minimum" value={b.min} ro={ro} onChange={(v) => set({ min: v })} /><NumProp label="Maximum" value={b.max} ro={ro} onChange={(v) => set({ max: v })} /></div>}
        <ListEditor ro={ro} items={b.values} onChange={(values) => set({ values })} make={() => ({ name: 'Series', value: '' })} render={(v, up) => <>
          <TextProp label="Name" value={v.name} ro={ro} onChange={(x) => up({ ...v, name: x })} />
          <TextProp label={b.chartType === 'gauge' ? 'Value (formula)' : 'Value (formula over ThisItem)'} value={v.value} ro={ro} formula onChange={(x) => up({ ...v, value: x })} />
        </>} />
        <NumProp label="Height (mm)" value={b.height} ro={ro} onChange={(v) => set({ height: v })} />
      </>}
      {b.kind === 'signature' && <>
        <TextProp label="Labels (one per line)" value={b.labels.join('\n')} multiline ro={ro} onChange={(v) => set({ labels: v.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4) })} />
        <BoolProp label="Date line" value={b.showDate} ro={ro} onChange={(v) => set({ showDate: v })} />
      </>}
      {b.kind === 'approvals' && <><TextProp label="Title" value={b.title ?? ''} ro={ro} onChange={(v) => set({ title: v || undefined })} /><TextProp label="When there was no approval" value={b.emptyText ?? ''} ro={ro} onChange={(v) => set({ emptyText: v || undefined })} /></>}
      {b.kind === 'spacer' && <NumProp label="Height (mm)" value={b.height} ro={ro} onChange={(v) => set({ height: v ?? 0 })} />}
      {b.kind === 'line' && <><NumProp label="Thickness (pt)" value={b.thickness} ro={ro} onChange={(v) => set({ thickness: v })} /><BoolProp label="Dashed" value={b.dashed} ro={ro} onChange={(v) => set({ dashed: v })} /></>}
      <div className="mt-3 border-t pt-2">
        <TextProp label="Visible when (formula; blank: always)" value={b.visible ?? ''} ro={ro} formula onChange={(v) => set({ visible: v || undefined })} />
        <BoolProp label="Keep together on one page" value={b.keepTogether} ro={ro} onChange={(v) => set({ keepTogether: v })} />
        <div className="grid grid-cols-2 gap-2"><NumProp label="Space before (mm)" value={b.spaceBefore} ro={ro} onChange={(v) => set({ spaceBefore: v })} /><NumProp label="Space after (mm)" value={b.spaceAfter} ro={ro} onChange={(v) => set({ spaceAfter: v })} /></div>
      </div>
    </div>
  )
}

function ListEditor<T>({ items, onChange, make, render, ro }: { items: T[]; onChange(x: T[]): void; make(): T; render(item: T, update: (x: T) => void): ReactNode; ro: boolean }) {
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} className="mb-2 rounded border p-2">
          {render(it, (x) => onChange(items.map((y, j) => (j === i ? x : y))))}
          {!ro && <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => { const n = items.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n) }}><ArrowUp /></Button>
            <Button size="sm" variant="ghost" disabled={i === items.length - 1} onClick={() => { const n = items.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChange(n) }}><ArrowDown /></Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>}
        </div>
      ))}
      {!ro && <Button size="sm" variant="outline" onClick={() => onChange([...items, make()])} data-testid="list-add"><Plus />Add</Button>}
    </div>
  )
}

function ChildBlocks({ blocks, onChange, ro }: { blocks: Block[]; onChange(b: Block[]): void; ro: boolean }) {
  const [kind, setKind] = useState<BlockKind>('text')
  return (
    <div className="mt-1">
      <div className="text-[11px] text-muted-foreground">{blocks.length} block(s) inside: select them on the page to edit.</div>
      {!ro && <div className="mt-1 flex gap-1">
        <select className={sel} value={kind} onChange={(e) => setKind(e.target.value as BlockKind)}>{BLOCK_CATALOGUE.filter((b) => b.kind !== 'pageBreak').map((b) => <option key={b.kind} value={b.kind}>{b.title}</option>)}</select>
        <Button size="sm" variant="outline" onClick={() => onChange([...blocks, newBlock(kind)])}><Plus /></Button>
      </div>}
    </div>
  )
}

function DocxPanel({ tpl, ro, onUploaded }: { tpl: PrintTemplateFull; ro: boolean; onUploaded(t: PrintTemplateFull): void }) {
  const { fail } = useToast()
  return (
    <Panel className="mx-auto max-w-xl p-6 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold"><FileType2 className="size-4" />Word template: {tpl.docxFileName}</div>
      <p className="mb-3 text-muted-foreground">Merge fields are formulas in {'{ }'}: {'{Number}'}, {'{FormatDate(InspectedOn)}'}, {'{Company.Name}'}. Loops: {'{#Related.Lines}{Item} {Qty}{/Related.Lines}'} (inside a table row: one row per line). Conditions: {'{#Result = "Fail"}...{/Result = "Fail"}'}, {'{^...}'} for "not". The fields of the data source are listed on the left. Images, charts and HTML are not filled (they need paid docxtemplater modules); the output is a .docx file only.</p>
      {!ro && <Field label="Replace the Word file"><Input type="file" accept=".docx" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { onUploaded((await printApi.save(tpl.id, { docxBase64: await fileToBase64(f), docxFileName: f.name })).template) } catch (err) { fail(err) } }} /></Field>}
    </Panel>
  )
}

function BulkDialog({ open, onOpenChange, templateId, table }: { open: boolean; onOpenChange(o: boolean): void; templateId: string; table: TableDef }) {
  const { fail } = useToast()
  const [rows, setRows] = useState<{ id: string; label: string }[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'zip' | 'merged'>('zip')
  const [run, setRun] = useState<PrintRunInfo | null>(null)
  useEffect(() => {
    if (!open) return
    setRun(null)
    const prim = table.primaryColumn || 'id'
    fetch(`${API_BASE}/query`, { method: 'POST', credentials: 'same-origin', headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/json', ...environmentHeaders() }, body: JSON.stringify({ plan: { version: 2, table: table.name, select: [prim], sort: [{ col: 'createdOn', dir: 'desc' }], take: { n: 500, from: 'start' } } }) })
      .then((r) => r.json()).then((b: { rows?: Record<string, unknown>[] }) => { const l = (b.rows ?? []).map((r) => ({ id: String(r.id), label: String(r[prim] ?? r.id) })); setRows(l); setPicked(new Set(l.map((x) => x.id))) }).catch(fail)
  }, [open])
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const t = setTimeout(() => { printApi.run(run.id).then((r) => setRun(r.run)).catch(() => {}) }, 1000)
    return () => clearTimeout(t)
  }, [run])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Generate for many records</DialogTitle><DialogDescription>One PDF per record in a zip file, or one merged PDF. It runs in the background; you are notified when it is ready.</DialogDescription></DialogHeader>
        <div className="max-h-56 overflow-auto rounded border p-2 text-sm">
          <label className="mb-1 flex items-center gap-2 text-xs"><input type="checkbox" checked={picked.size === rows.length && rows.length > 0} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />All ({rows.length}, newest first)</label>
          {rows.map((r) => <label key={r.id} className="flex items-center gap-2"><input type="checkbox" checked={picked.has(r.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(r.id); else n.delete(r.id); setPicked(n) }} />{r.label}</label>)}
        </div>
        <SelProp label="Output" value={mode} ro={false} options={[['zip', 'A zip file with one PDF per record'], ['merged', 'One merged PDF']]} onChange={(v) => setMode(v as 'zip' | 'merged')} testid="bulk-mode" />
        {run && <div className="text-sm" data-testid="bulk-status">{run.status === 'running' ? <><Loader2 className="inline size-3.5 animate-spin" /> {run.progress?.done ?? 0} of {run.progress?.total ?? 0}...</> : run.status === 'succeeded' ? <>Done: {run.pages} pages. {run.fileToken && <a className="underline" href={printApi.fileUrl(run.fileToken, true)} data-testid="bulk-download">Download</a>}{run.warnings.length ? ` (${run.warnings.length} warning(s))` : ''}</> : <span className="text-destructive">Failed: {run.error}</span>}</div>}
        <DialogFooter><Button disabled={!picked.size || run?.status === 'running'} onClick={async () => { try { const r = await printApi.bulk(templateId, [...picked], mode); setRun((await printApi.run(r.runId)).run) } catch (e) { fail(e) } }} data-testid="bulk-start"><Printer />Generate {picked.size}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ the page canvas (approximate preview) */

const PX = 2.6 // px per mm on the canvas

function PageCanvas({ doc, selected, onSelect, onMove, onRemove, onDropNew, onDropMove, ro }: {
  doc: PrintTemplateDoc; selected: string; onSelect(s: string): void; onMove(id: string, d: -1 | 1): void; onRemove(id: string): void; onDropNew(k: BlockKind, at: number): void; onDropMove(id: string, at: number): void; ro: boolean
}) {
  const [w, h] = pageSizeMm(doc.page)
  const m = doc.page.margins
  const fontPx = doc.styles.fontSize * (PX / MM)
  // estimated page breaks: block heights measured in the DOM, accumulated against the body height of a page
  const bodyRef = useRef<HTMLDivElement>(null)
  const [breaks, setBreaks] = useState<number[]>([])
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const frame = (h - m.top - m.bottom - 20) * PX
    const out: number[] = []
    let y = 0
    for (const c of [...el.querySelectorAll<HTMLElement>(':scope > [data-block]')]) {
      const bh = c.offsetHeight
      if (c.dataset.kind === 'pageBreak' || (y + bh > frame && y > 0)) { out.push(c.offsetTop); y = c.dataset.kind === 'pageBreak' ? 0 : bh; continue }
      y += bh
    }
    setBreaks(out)
  }, [doc, w, h])
  const drop = (e: React.DragEvent, at: number) => {
    e.preventDefault()
    const k = e.dataTransfer.getData('application/x-print-block')
    const mv = e.dataTransfer.getData('application/x-print-move')
    if (k && !ro) onDropNew(k as BlockKind, at)
    else if (mv && !ro) onDropMove(mv, at)
  }
  const Zone = ({ at }: { at: number }) => <div className="h-2 rounded transition-colors hover:bg-primary/20" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, at)} data-testid={`drop-${at}`} />
  return (
    <div className="mx-auto bg-white shadow-md" style={{ width: w * PX, minHeight: h * PX, padding: `${m.top * PX}px ${m.right * PX}px ${m.bottom * PX}px ${m.left * PX}px`, fontSize: fontPx, color: doc.styles.color, fontFamily: '"Noto Sans", system-ui, sans-serif' }} data-testid="print-canvas">
      <div className={cn('mb-2 cursor-pointer rounded border border-dashed px-1 py-0.5 text-[10px] text-muted-foreground', selected === 'header' && 'border-primary')} onClick={() => onSelect('header')} data-testid="canvas-header">
        Header{doc.header.letterhead !== 'none' ? ` · letterhead ${doc.header.letterhead === 'all' ? 'on every page' : 'on page 1'}` : ''}{doc.header.right ? ` · ${doc.header.right}` : ''}
        {doc.header.blocks.map((b) => <BlockBox key={b.id} b={b} doc={doc} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} ro={ro} />)}
      </div>
      <div ref={bodyRef} className="relative">
        <Zone at={0} />
        {doc.body.map((b, i) => (
          <div key={b.id} data-block data-kind={b.kind}>
            <BlockBox b={b} doc={doc} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} ro={ro} draggable />
            <Zone at={i + 1} />
          </div>
        ))}
        {!doc.body.length && <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, 0)}>Click or drag blocks from the left.</div>}
        {breaks.map((y, i) => <div key={i} className="pointer-events-none absolute right-0 left-0 border-t-2 border-dashed border-sky-400" style={{ top: y - 3 }}><span className="absolute -top-4 right-0 bg-white px-1 text-[10px] text-sky-600">page {i + 2} (estimate)</span></div>)}
      </div>
      <div className={cn('mt-2 cursor-pointer rounded border border-dashed px-1 py-0.5 text-[10px] text-muted-foreground', selected === 'footer' && 'border-primary')} onClick={() => onSelect('footer')} data-testid="canvas-footer">
        Footer{doc.footer.left ? ` · ${doc.footer.left}` : ''}{doc.footer.pageNumbers !== false ? ' · Page X of Y' : ''}
        {doc.footer.blocks.map((b) => <BlockBox key={b.id} b={b} doc={doc} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} ro={ro} />)}
      </div>
    </div>
  )
}

function BlockBox({ b, doc, selected, onSelect, onMove, onRemove, ro, draggable }: { b: Block; doc: PrintTemplateDoc; selected: string; onSelect(s: string): void; onMove(id: string, d: -1 | 1): void; onRemove(id: string): void; ro: boolean; draggable?: boolean }) {
  const isSel = selected === b.id
  return (
    <div className={cn('group relative rounded outline-1 outline-transparent hover:outline-dashed hover:outline-slate-300', isSel && 'outline-2 outline-primary outline-solid')}
      onClick={(e) => { e.stopPropagation(); onSelect(b.id) }} draggable={draggable && !ro}
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('application/x-print-move', b.id) }} data-testid={`canvas-block-${b.id}`}>
      {isSel && !ro && (
        <div className="absolute -top-3 right-1 z-10 flex gap-0.5 rounded border bg-background p-0.5 shadow-sm">
          <button type="button" className="rounded p-0.5 hover:bg-accent" onClick={(e) => { e.stopPropagation(); onMove(b.id, -1) }} title="Up"><ArrowUp className="size-3" /></button>
          <button type="button" className="rounded p-0.5 hover:bg-accent" onClick={(e) => { e.stopPropagation(); onMove(b.id, 1) }} title="Down"><ArrowDown className="size-3" /></button>
          <button type="button" className="rounded p-0.5 hover:bg-accent" onClick={(e) => { e.stopPropagation(); onRemove(b.id) }} title="Delete"><Trash2 className="size-3" /></button>
        </div>
      )}
      {b.visible && <span className="absolute -left-2 top-0 text-[9px] text-amber-600" title={`Visible when ${b.visible}`}>if</span>}
      <BlockPreview b={b} doc={doc} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} ro={ro} />
    </div>
  )
}

/** formulas in text shown as chips */
function Templated({ text }: { text: string }) {
  return <>{splitTemplateText(text).map((p, i) => ('lit' in p ? <span key={i}>{p.lit}</span> : <span key={i} className="rounded bg-sky-50 px-0.5 font-mono text-[0.85em] text-sky-700">{`{${p.fx}}`}</span>))}</>
}

function BlockPreview({ b, doc, ...rest }: { b: Block; doc: PrintTemplateDoc; selected: string; onSelect(s: string): void; onMove(id: string, d: -1 | 1): void; onRemove(id: string): void; ro: boolean }) {
  const s = doc.styles
  switch (b.kind) {
    case 'heading': return <div style={{ fontSize: `${b.level === 1 ? 1.8 : b.level === 2 ? 1.4 : 1.15}em`, fontWeight: 700, color: b.color ?? s.headingColor, textAlign: b.align ?? 'left' }} className="py-0.5"><Templated text={b.text} /></div>
    case 'text': return (
      <div style={{ textAlign: b.align ?? 'left', fontSize: b.size ? `${b.size / s.fontSize}em` : undefined, color: b.color }} className="py-0.5">
        {parseRichText(b.text).map((p, i) => <p key={i} className={cn('mb-1', p.list && 'pl-4')}>{p.list ? (p.list === 'bullet' ? '• ' : `${p.number}. `) : ''}{p.runs.map((r, j) => <span key={j} style={{ fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined, textDecoration: r.underline ? 'underline' : undefined, color: r.color, whiteSpace: 'pre-wrap' }}><Templated text={r.text} /></span>)}</p>)}
      </div>
    )
    case 'keyValue': return (
      <div className="grid gap-x-3 py-1" style={{ gridTemplateColumns: `repeat(${b.columns ?? 2}, minmax(0, 1fr))` }}>
        {b.items.map((it, i) => b.boxed
          ? <div key={i} className="rounded border bg-slate-50 p-1"><div className="text-[0.8em] text-slate-500">{it.label}</div><div className="font-bold" style={{ fontSize: '1.4em' }}><span className="font-mono text-[0.6em] text-sky-700">{it.value}</span></div></div>
          : <div key={i} className="flex gap-2"><span className="w-2/5 text-slate-500">{it.label}</span><span className="font-mono text-[0.85em] font-semibold text-sky-700">{it.value}</span></div>)}
      </div>
    )
    case 'table': {
      const style = b.style ?? s.tableStyle
      return (
        <div className="py-1">
          <table className="w-full border-collapse" style={{ fontSize: '0.9em' }}>
            <thead><tr style={{ background: s.accent, color: '#fff' }}>{b.columns.map((c, i) => <th key={i} className="px-1 py-0.5 text-left font-semibold" style={{ width: c.width ? c.width * PX : undefined, textAlign: c.align }}>{c.header}</th>)}</tr></thead>
            <tbody>
              {b.groupBy && <tr><td colSpan={b.columns.length} className="bg-indigo-50 px-1 font-semibold"><Templated text={b.groupHeader || '{Group}'} /></td></tr>}
              {[0, 1].map((r) => <tr key={r} className={cn(style === 'zebra' && r % 2 && 'bg-slate-50', style === 'grid' && 'border')}>{b.columns.map((c, i) => <td key={i} className={cn('px-1 py-0.5 font-mono text-[0.8em] text-sky-700', style === 'grid' && 'border')} style={{ textAlign: c.align }}>{c.value}</td>)}</tr>)}
              {b.totals && <tr className="bg-indigo-50 font-semibold">{b.columns.map((c, i) => <td key={i} className="px-1">{c.total === 'label' ? c.totalLabel ?? 'Total' : c.total ?? ''}</td>)}</tr>}
            </tbody>
          </table>
          <div className="text-[10px] text-slate-400">rows: {b.rows}</div>
        </div>
      )
    }
    case 'repeat': return <div className="my-1 rounded border border-dashed border-violet-300 p-1"><div className="text-[10px] text-violet-600">for each row of {b.rows}{b.pageBreakBetween ? ' (a page each)' : ''}</div>{b.blocks.map((c) => <BlockBox key={c.id} b={c} doc={doc} {...rest} />)}</div>
    case 'columns': return <div className="flex py-1" style={{ gap: (b.gap ?? 6) * PX }}>{b.columns.map((c, i) => <div key={i} className="min-h-6 rounded border border-dashed border-slate-200" style={{ flex: c.width ? `0 0 ${c.width * PX}px` : '1 1 0' }}>{c.blocks.map((x) => <BlockBox key={x.id} b={x} doc={doc} {...rest} />)}</div>)}</div>
    case 'image': return <div className="my-1 flex gap-1" style={{ justifyContent: b.align === 'center' ? 'center' : b.align === 'right' ? 'flex-end' : 'flex-start' }}>{b.source === 'static' && b.data ? <img src={b.data} alt="" style={{ width: b.width ? b.width * PX : undefined, maxWidth: '100%' }} /> : <div className="grid place-items-center rounded bg-slate-100 text-[10px] text-slate-500" style={{ width: (b.width ?? 40) * PX, height: (b.height ?? 25) * PX }}>{b.source === 'logo' ? 'logo' : `images: ${b.value}`}</div>}</div>
    case 'barcode': return <div className="my-1 flex" style={{ justifyContent: b.align === 'center' ? 'center' : b.align === 'right' ? 'flex-end' : 'flex-start' }}><div className="grid place-items-center border border-slate-800 text-[9px]" style={{ width: (b.width ?? (b.symbology === 'qr' ? 25 : 60)) * PX, height: (b.symbology === 'qr' ? b.width ?? 25 : b.height ?? 14) * PX, background: 'repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px)' }}><span className="bg-white px-1 font-mono">{b.symbology}: {b.value}</span></div></div>
    case 'chart': return <div className="my-1 grid place-items-center rounded bg-slate-50 text-[10px] text-slate-500" style={{ height: (b.height ?? 60) * PX }}>{b.chartType} chart{b.title ? `: ${b.title}` : ''}</div>
    case 'signature': return <div className="flex gap-6 pt-6">{b.labels.map((l, i) => <div key={i} className="flex-1 border-t border-slate-600 pt-1 text-[0.85em] text-slate-500">{l}{b.showDate ? <div>Date: ________</div> : null}</div>)}</div>
    case 'approvals': return <div className="py-1"><div className="font-semibold">{b.title ?? 'Approval history'}</div><div className="text-[0.85em] text-slate-500">When · Request · Stage · Action · By · Comment</div></div>
    case 'spacer': return <div style={{ height: b.height * PX }} className="bg-[repeating-linear-gradient(45deg,transparent_0_4px,#f1f5f9_4px_8px)]" />
    case 'line': return <hr className="my-1" style={{ borderTopWidth: b.thickness ?? 0.6, borderStyle: b.dashed ? 'dashed' : 'solid', borderColor: b.color ?? '#cbd5e1' }} />
    case 'pageBreak': return <div className="my-1 border-t-2 border-dashed border-slate-400 text-center text-[10px] text-slate-500">page break</div>
  }
}
