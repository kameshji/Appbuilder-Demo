/**
 * Connection details (P1 package D): tabs Tables / Actions / Access / Activity for one connection.
 *  - Actions: built-in and custom actions, a "Test action" form generated from the action's JSON Schema, a form to
 *    define custom actions (HTTP connections), OpenAPI 3 import with a preview, the protection state (circuit breaker).
 *  - Access: "use" and "manage" grants to roles and people (administrators change them).
 *  - Activity: calls of the connection's actions (managers see everyone's, others their own); never inputs or secrets.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, FileUp, Play, Plus, RotateCcw, ShieldCheck, TableProperties, Trash2, Wand2, Zap } from 'lucide-react'
import { usePlatform, type ConnectionRef } from '@/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Empty, Field, errMsg, fmtRelative, useToast } from './kit'
import { useCaps } from './security'
import { actionsApi, type ActionDef, type ActionResult, type ActivityItem, type ConnState, type Grant, type JsonSchema, type OpenApiPreview } from './actionsApi'

const selectCls = 'h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30'
const areaCls = 'w-full rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30'

/* ------------------------------------------------------------------ a form from a JSON Schema */

const typeOf = (s: JsonSchema): string => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') ?? 'string' : s.type ?? (s.anyOf ? 'json' : s.enum ? 'string' : 'json'))

/** text values of the form -> typed inputs (blank fields are left out) */
export function formToInputs(schema: JsonSchema, values: Record<string, string>): { inputs: Record<string, unknown>; error?: string } {
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    const v = values[k]
    if (v === undefined || v === '') continue
    const t = typeOf(p)
    if (t === 'number' || t === 'integer') {
      const n = Number(v)
      if (!Number.isFinite(n)) return { inputs: out, error: `${p.title ?? k} must be a number.` }
      out[k] = n
    } else if (t === 'boolean') out[k] = v === 'true'
    else if (t === 'string' && !p.anyOf) out[k] = v
    else {
      try {
        out[k] = JSON.parse(v)
      } catch {
        if (t === 'json' || p.anyOf) out[k] = v
        else return { inputs: out, error: `${p.title ?? k} must be JSON (for example {"a": 1} or ["x"]).` }
      }
    }
  }
  return { inputs: out }
}

export function SchemaForm({ schema, values, onChange, testId }: { schema: JsonSchema; values: Record<string, string>; onChange(v: Record<string, string>): void; testId?: string }) {
  const props = schema.properties ?? {}
  const order = [...(schema['x-order'] ?? []).filter((k) => props[k]), ...Object.keys(props).filter((k) => !(schema['x-order'] ?? []).includes(k))]
  if (!order.length) return <p className="text-xs text-muted-foreground">This action takes no inputs.</p>
  const set = (k: string, v: string) => onChange({ ...values, [k]: v })
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid={testId}>
      {order.map((k) => {
        const p = props[k]
        const t = typeOf(p)
        const req = schema.required?.includes(k)
        const label = `${p.title ?? k}${req ? ' *' : ''}`
        const hint = p.description ?? (t === 'json' || t === 'object' || t === 'array' ? 'JSON' : undefined)
        let input
        if (p.enum) {
          input = (
            <select className={selectCls} value={values[k] ?? (p.default !== undefined ? String(p.default) : '')} onChange={(e) => set(k, e.target.value)} data-testid={`input-${k}`}>
              {!req && <option value="">(none)</option>}
              {p.enum.map((x) => <option key={String(x)} value={String(x)}>{String(x)}</option>)}
            </select>
          )
        } else if (t === 'boolean') {
          input = <Switch checked={values[k] === 'true'} onCheckedChange={(v) => set(k, v ? 'true' : 'false')} aria-label={label} data-testid={`input-${k}`} />
        } else if (t === 'string' && p['x-ui'] !== 'textarea' && p['x-ui'] !== 'json') {
          input = <Input value={values[k] ?? ''} onChange={(e) => set(k, e.target.value)} placeholder={p.default !== undefined ? String(p.default) : p.format ?? ''} data-testid={`input-${k}`} />
        } else if (t === 'number' || t === 'integer') {
          input = <Input inputMode="decimal" value={values[k] ?? ''} onChange={(e) => set(k, e.target.value)} data-testid={`input-${k}`} />
        } else {
          input = <textarea className={cn(areaCls, 'h-20')} spellCheck={false} value={values[k] ?? ''} onChange={(e) => set(k, e.target.value)} placeholder={t === 'array' ? '["a", "b"]' : t === 'string' ? '' : '{ }'} data-testid={`input-${k}`} />
        }
        return <Field key={k} label={label} hint={hint}>{input}</Field>
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ test an action */

function TestAction({ conn, action, onDone }: { conn: string; action: ActionDef; onDone(): void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { setValues({}); setResult(null); setErr('') }, [action.id])
  const run = async () => {
    const f = formToInputs(action.inputs, values)
    if (f.error) return setErr(f.error)
    setErr('')
    setBusy(true)
    try {
      setResult(await actionsApi.test(conn, action.id, f.inputs))
      onDone()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="test-action">
      <div className="flex items-center gap-2 text-sm font-medium"><Play className="size-4 text-primary" /> Test "{action.title}"</div>
      {action.sideEffect === 'external' && <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs">This action changes something outside Appbuilder: the test really sends it.</p>}
      <SchemaForm schema={action.inputs} values={values} onChange={setValues} testId="test-action-form" />
      {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
      <div><Button size="sm" onClick={() => void run()} disabled={busy} data-testid="run-test-action">{busy ? <Spinner /> : <Play />} Run</Button></div>
      {result && (
        <div className={cn('grid gap-1 rounded-md p-2 text-xs', result.ok ? 'bg-emerald-500/10' : 'bg-destructive/10')} data-testid="test-action-result">
          <div className="font-medium">{result.ok ? `Succeeded${result.replayed ? ' (replayed)' : ''}` : `Failed: ${result.error.code}${result.error.retryable ? ' (a retry may succeed)' : ''}`}{result.durationMs !== undefined ? ` in ${result.durationMs} ms` : ''}</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono">{result.ok ? JSON.stringify(result.output, null, 2) : result.error.message}</pre>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ define a custom action */

interface InputRow { name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'; required: boolean; where: 'path' | 'query' | 'header' | 'body'; description: string }

function CustomActionForm({ conn, initial, onSaved, onCancel }: { conn: string; initial: ActionDef | null; onSaved(): void; onCancel(): void }) {
  const { fail, toast } = useToast()
  const h = initial?.http
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [method, setMethod] = useState(h?.method ?? 'GET')
  const [path, setPath] = useState(h?.path ?? '')
  const [outputPath, setOutputPath] = useState(h?.outputPath ?? '')
  const [sample, setSample] = useState(h?.sample !== undefined ? JSON.stringify(h.sample, null, 2) : '')
  const [rows, setRows] = useState<InputRow[]>(() => Object.entries(initial?.inputs.properties ?? {}).map(([name, p]) => ({
    name, type: (typeOf(p) === 'json' ? 'string' : typeOf(p)) as InputRow['type'], required: !!initial?.inputs.required?.includes(name), description: p.description ?? '',
    where: path.includes(`{{${name}}}`) || h?.path.includes(`{{${name}}}`) ? 'path' : h?.params?.find((x) => x.input === name)?.in === 'header' ? 'header' : h?.params?.some((x) => x.input === name) ? 'query' : 'body',
  })))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    let s: unknown
    if (sample.trim()) {
      try { s = JSON.parse(sample) } catch { return fail(new Error('The sample response must be JSON.')) }
    }
    const properties: Record<string, JsonSchema> = {}
    for (const r of rows) if (r.name.trim()) properties[r.name.trim()] = { type: r.type, ...(r.description ? { description: r.description } : {}) }
    const def = {
      id: id.trim(), title: title.trim() || id.trim(), description,
      inputs: { type: 'object', properties, required: rows.filter((r) => r.required && r.name.trim()).map((r) => r.name.trim()), additionalProperties: false },
      ...(initial?.http && initial.outputs && !s ? { outputs: initial.outputs } : {}),
      http: {
        method, path,
        params: rows.filter((r) => r.name.trim() && (r.where === 'query' || r.where === 'header')).map((r) => ({ name: r.name.trim(), in: r.where, input: r.name.trim() })),
        bodyFields: rows.filter((r) => r.name.trim() && r.where === 'body').map((r) => r.name.trim()),
        ...(outputPath.trim() ? { outputPath: outputPath.trim() } : {}),
        ...(s !== undefined ? { sample: s } : {}),
      },
    }
    setBusy(true)
    try {
      await actionsApi.saveCustom(conn, initial?.id ?? def.id, def)
      toast(`Saved action "${def.id}"`, 'success')
      onSaved()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const upd = (i: number, p: Partial<InputRow>) => setRows((l) => l.map((r, j) => (j === i ? { ...r, ...p } : r)))
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="custom-action-form">
      <div className="text-sm font-medium">{initial ? `Edit action "${initial.id}"` : 'New action'}</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Action id" hint="Used in flows and RunConnector, e.g. getOrder"><Input value={id} onChange={(e) => setId(e.target.value)} data-testid="custom-id" /></Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="custom-title" /></Field>
      </div>
      <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="grid grid-cols-[110px_1fr] gap-3">
        <Field label="Method"><select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value)} data-testid="custom-method">{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Path" hint="Relative to the base URL; {{input}} inserts an input (encoded)"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/orders/{{id}}" data-testid="custom-path" /></Field>
      </div>
      <div className="grid gap-1.5">
        <div className="text-xs font-medium">Inputs</div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_100px_90px_auto_auto] items-center gap-2" data-testid={`custom-input-${i}`}>
            <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="name" aria-label="Input name" />
            <select className={selectCls} value={r.type} onChange={(e) => upd(i, { type: e.target.value as InputRow['type'] })} aria-label="Type">{['string', 'number', 'integer', 'boolean', 'object', 'array'].map((t) => <option key={t}>{t}</option>)}</select>
            <select className={selectCls} value={r.where} onChange={(e) => upd(i, { where: e.target.value as InputRow['where'] })} aria-label="Sent in">{['path', 'query', 'header', 'body'].map((t) => <option key={t}>{t}</option>)}</select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.required} onChange={(e) => upd(i, { required: e.target.checked })} /> required</label>
            <Button variant="ghost" size="icon-sm" aria-label="Remove input" onClick={() => setRows((l) => l.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
        ))}
        <div><Button variant="outline" size="xs" onClick={() => setRows((l) => [...l, { name: '', type: 'string', required: false, where: 'query', description: '' }])} data-testid="custom-add-input"><Plus /> Add input</Button></div>
      </div>
      <Field label="Return part of the answer" hint="Optional dotted path into the JSON answer, e.g. data or data.items"><Input value={outputPath} onChange={(e) => setOutputPath(e.target.value)} data-testid="custom-output-path" /></Field>
      <Field label="Sample response (JSON)" hint="Describes the output for flow designers; the output schema is made from it"><textarea className={cn(areaCls, 'h-24')} value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} data-testid="custom-sample" /></Field>
      <div className="flex gap-2"><Button size="sm" onClick={() => void save()} disabled={busy || !id.trim()} data-testid="custom-save">{busy && <Spinner />} Save action</Button><Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button></div>
    </div>
  )
}

/* ------------------------------------------------------------------ OpenAPI import */

function OpenApiImport({ conn, onDone }: { conn: string; onDone(): void }) {
  const { fail, toast } = useToast()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<OpenApiPreview | null>(null)
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const check = async (t: string) => {
    setBusy(true)
    try {
      const p = await actionsApi.openapi(conn, t)
      setPreview(p)
      setPick(Object.fromEntries(p.actions.map((a) => [a.id, true])))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    setBusy(true)
    try {
      const r = await actionsApi.openapi(conn, text, { apply: true, only: Object.entries(pick).filter(([, v]) => v).map(([k]) => k) })
      toast(`Imported ${r.imported} action${r.imported === 1 ? '' : 's'} from "${r.title}"`, 'success')
      setPreview(null)
      setText('')
      onDone()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="openapi-import">
      <div className="text-sm font-medium">Import from an OpenAPI 3 document</div>
      <textarea className={cn(areaCls, 'h-28')} value={text} onChange={(e) => { setText(e.target.value); setPreview(null) }} placeholder="Paste the OpenAPI 3 document (JSON or YAML) or choose the file." spellCheck={false} data-testid="openapi-text" />
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept=".json,.yaml,.yml" className="sr-only" aria-label="Choose OpenAPI file" data-testid="openapi-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) f.text().then((t) => { setText(t); void check(t) }).catch(fail) }} />
        <Button size="sm" variant="outline" onClick={() => file.current?.click()}><FileUp /> Choose file</Button>
        <Button size="sm" variant="outline" disabled={!text.trim() || busy} onClick={() => void check(text)} data-testid="openapi-preview">{busy && <Spinner />} Preview</Button>
      </div>
      {preview && (
        <div className="grid gap-2 text-xs" data-testid="openapi-preview-list">
          <div><strong>{preview.title}</strong> {preview.version}{preview.baseUrl ? ` · server ${preview.baseUrl}` : ''}{preview.auth ? ` · authentication ${preview.auth.authMode}` : ''}</div>
          {preview.warnings.map((w) => <div key={w} className="rounded bg-amber-500/10 px-2 py-1">{w}</div>)}
          <ul className="grid max-h-56 gap-1 overflow-auto">
            {preview.actions.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <input type="checkbox" checked={!!pick[a.id]} onChange={(e) => setPick((p) => ({ ...p, [a.id]: e.target.checked }))} aria-label={`Import ${a.id}`} />
                <Badge variant="outline" className="font-mono">{a.method}</Badge><span className="font-mono">{a.path}</span><span className="text-muted-foreground">{a.id}</span>{a.exists && <Badge variant="secondary">replaces</Badge>}
              </li>
            ))}
          </ul>
          <div><Button size="sm" onClick={() => void apply()} disabled={busy || !Object.values(pick).some(Boolean)} data-testid="openapi-apply"><Wand2 /> Import selected</Button></div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ tabs */

function ActionsTab({ conn }: { conn: ConnectionRef }) {
  const { fail, toast } = useToast()
  const [items, setItems] = useState<ActionDef[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<ActionDef | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [state, setState] = useState<ConnState | null>(null)
  const [canManage, setCanManage] = useState(false)
  const load = () => {
    actionsApi.list(conn.id).then((r) => { setItems(r.items); setError('') }).catch((e) => setError(errMsg(e)))
    actionsApi.state(conn.id).then(setState).catch(() => {})
    actionsApi.usable().then((r) => setCanManage(!!r.items.find((x) => x.id === conn.id)?.canManage)).catch(() => {})
  }
  useEffect(load, [conn.id])
  const action = items?.find((a) => a.id === selected) ?? null
  if (error) return <Empty icon={ShieldCheck} title="No access to the actions" description={error} />
  if (!items) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Loading actions...</div>
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid="actions-tab">
      {state && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="connection-state">
          <Badge variant={state.circuit === 'closed' ? 'secondary' : 'destructive'}>Circuit {state.circuit}</Badge>
          <span className="text-muted-foreground">{state.perMinute} calls a minute, {state.maxConcurrent} at once, {state.inFlight} running{state.failures ? `, ${state.failures} failures in a row` : ''}</span>
          {state.secretParts?.length ? <span className="text-muted-foreground">Secrets stored: {state.secretParts.join(', ')}</span> : null}
          {state.circuit !== 'closed' && canManage && <Button size="xs" variant="outline" onClick={() => actionsApi.resetState(conn.id).then(setState).catch(fail)} data-testid="reset-circuit"><RotateCcw /> Resume calls</Button>}
          {state.lastError && state.circuit !== 'closed' && <span className="text-destructive">{state.lastError}</span>}
        </div>
      )}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5" data-testid="action-list">
        {items.map((a) => (
          <li key={a.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-2', selected === a.id ? 'border-primary bg-accent/50' : 'border-border')} data-testid={`action-${a.id}`}>
            <Zap className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">{a.title}<code className="font-mono text-xs text-muted-foreground">{a.id}</code>{a.origin === 'custom' && <Badge variant="outline">custom</Badge>}{a.sideEffect === 'external' && <Badge variant="secondary">changes data</Badge>}</div>
              <div className="truncate text-xs text-muted-foreground">{a.http ? `${a.http.method} ${a.http.path} · ` : ''}{a.description}</div>
            </div>
            <Button size="xs" variant="outline" onClick={() => setSelected(selected === a.id ? null : a.id)} data-testid={`test-action-${a.id}`}><Play /> Test</Button>
            {a.origin === 'custom' && canManage && <Button size="xs" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>}
            {a.origin === 'custom' && canManage && <Button size="icon-sm" variant="ghost" aria-label={`Delete ${a.id}`} onClick={() => actionsApi.removeCustom(conn.id, a.id).then(() => { toast('Action deleted', 'success'); load() }).catch(fail)}><Trash2 /></Button>}
          </li>
        ))}
      </ul>
      {action && <TestAction conn={conn.id} action={action} onDone={() => actionsApi.state(conn.id).then(setState).catch(() => {})} />}
      {conn.connector === 'http' && canManage && !editing && !importing && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing('new')} data-testid="new-custom-action"><Plus /> New action</Button>
          <Button size="sm" variant="outline" onClick={() => setImporting(true)} data-testid="import-openapi"><FileUp /> Import OpenAPI</Button>
        </div>
      )}
      {editing && <CustomActionForm conn={conn.id} initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {importing && <><OpenApiImport conn={conn.id} onDone={() => { setImporting(false); load() }} /><div><Button size="xs" variant="ghost" onClick={() => setImporting(false)}>Close import</Button></div></>}
    </div>
  )
}

function AccessTab({ conn }: { conn: ConnectionRef }) {
  const caps = useCaps()
  const roles = usePlatform((s) => s.roles)
  const users = usePlatform((s) => s.users)
  const { fail, toast } = useToast()
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState('')
  useEffect(() => { actionsApi.access(conn.id).then((r) => setGrants(r.items)).catch((e) => setError(errMsg(e))) }, [conn.id])
  const nameOf = (g: Grant) => (g.principalKind === 'role' ? roles.find((r) => r.id === g.principalId)?.name : users.find((u) => u.id === g.principalId)?.name) ?? g.principalId
  const save = async (next: Grant[]) => {
    try {
      setGrants((await actionsApi.setAccess(conn.id, next.map(({ principalKind, principalId, level }) => ({ principalKind, principalId, level })))).items)
      toast('Access saved', 'success')
    } catch (e) {
      fail(e)
    }
  }
  if (error) return <Empty icon={ShieldCheck} title="Access" description={error} />
  if (!grants) return <Spinner />
  const options = [...roles.filter((r) => !r.isAdmin).map((r) => ({ v: `role:${r.id}`, l: `Role: ${r.name}` })), ...users.filter((u) => !grants.some((g) => g.principalId === u.id)).map((u) => ({ v: `user:${u.id}`, l: `${u.name} (${u.email})` }))]
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid="access-tab">
      <p className="text-xs text-muted-foreground"><strong className="text-foreground">Use</strong>: attach the connection to flows and table events and test its actions. <strong className="text-foreground">Manage</strong>: also define custom actions, see everyone's activity and resume calls after failures. Administrators always have both. Nobody but an administrator edits the connection's settings, and no one ever sees its secrets.</p>
      {grants.length === 0 ? <p className="text-sm text-muted-foreground">Only administrators can use this connection.</p> : (
        <ul className="grid gap-1.5">
          {grants.map((g, i) => (
            <li key={`${g.principalKind}:${g.principalId}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm" data-testid={`grant-${g.principalId}`}>
              <span className="flex-1">{nameOf(g)} <span className="text-xs text-muted-foreground">{g.principalKind}</span></span>
              <select className={selectCls} value={g.level} disabled={!caps.isAdmin} onChange={(e) => void save(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as Grant['level'] } : x)))} aria-label="Level"><option value="use">use</option><option value="manage">manage</option></select>
              {caps.isAdmin && <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => void save(grants.filter((_, j) => j !== i))}><Trash2 /></Button>}
            </li>
          ))}
        </ul>
      )}
      {caps.isAdmin && (
        <div className="flex gap-2">
          <select className={cn(selectCls, 'flex-1')} value={pick} onChange={(e) => setPick(e.target.value)} data-testid="grant-pick"><option value="">Choose a role or person...</option>{options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          <Button size="sm" disabled={!pick} onClick={() => { const [k, ...rest] = pick.split(':'); void save([...grants, { principalKind: k as Grant['principalKind'], principalId: rest.join(':'), level: 'use' }]); setPick('') }} data-testid="grant-add"><Plus /> Give use</Button>
        </div>
      )}
    </div>
  )
}

function ActivityTab({ conn }: { conn: ConnectionRef }) {
  const users = usePlatform((s) => s.users)
  const [data, setData] = useState<{ items: ActivityItem[]; all: boolean } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { actionsApi.activity(conn.id).then(setData).catch((e) => setError(errMsg(e))) }, [conn.id])
  if (error) return <Empty icon={Activity} title="Activity" description={error} />
  if (!data) return <Spinner />
  if (!data.items.length) return <Empty icon={Activity} title="No calls yet" description="Calls from flows, table events and tests show here (who, what, when, outcome; never inputs or secrets)." />
  return (
    <div className="grid gap-2" data-testid="activity-tab">
      <p className="text-xs text-muted-foreground">{data.all ? 'Every call of this connection' : 'Your own calls of this connection'}, newest first. Inputs, outputs and secrets are never recorded.</p>
      <table className="w-full text-xs">
        <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="py-1.5">When</th><th>Action</th><th>Who</th><th>From</th><th>Outcome</th><th>Time</th></tr></thead>
        <tbody>
          {data.items.map((r) => (
            <tr key={r.id} className="border-b border-border/60" data-testid="activity-row">
              <td className="py-1.5" title={r.at}>{fmtRelative(r.at)}</td>
              <td className="font-mono">{r.actionId}{r.details?.method ? <span className="text-muted-foreground"> {String(r.details.method)} {String(r.details.host ?? '')}{String(r.details.path ?? '')}</span> : null}</td>
              <td>{r.userId ? (users.find((u) => u.id === r.userId)?.name ?? r.userId) : 'system'}</td>
              <td>{r.source ?? ''}</td>
              <td>{r.status === 'ok' ? <Badge className="border-transparent bg-emerald-500/15 text-emerald-700">ok{r.httpStatus ? ` ${r.httpStatus}` : ''}{r.replayed ? ' replayed' : ''}</Badge> : <span className="text-destructive" title={r.message ?? ''}>{r.errorCode}{r.httpStatus ? ` ${r.httpStatus}` : ''}: {r.message?.slice(0, 80)}</span>}</td>
              <td>{r.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TablesTab({ conn, onBrowse }: { conn: ConnectionRef; onBrowse(): void }) {
  const tables = usePlatform((s) => s.tables)
  const mine = useMemo(() => tables.filter((t) => (t.connectionId ?? 'conn_default') === conn.id), [tables, conn.id])
  if (conn.connector === 'http' || conn.connector === 'email') return <Empty icon={TableProperties} title="No tables" description="This connection offers actions only: use them from flows and table events (Actions tab)." />
  return (
    <div className="grid gap-2" data-testid="tables-tab">
      {mine.length ? <ul className="grid gap-1 text-sm">{mine.map((t) => <li key={t.id} className="flex items-center gap-2"><TableProperties className="size-4 text-primary" />{t.displayName}<span className="text-xs text-muted-foreground">{t.name}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">No tables use this connection yet.</p>}
      {conn.connector !== 'files' && <div><Button size="sm" variant="outline" onClick={onBrowse}><TableProperties /> Browse source tables</Button></div>}
    </div>
  )
}

export function ConnectionDetail({ connection, onOpenChange, onBrowse }: { connection: ConnectionRef | null; onOpenChange(o: boolean): void; onBrowse(c: ConnectionRef): void }) {
  const actionKind = connection?.connector === 'http' || connection?.connector === 'email'
  return (
    <Dialog open={!!connection} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden sm:max-w-3xl" data-testid="connection-detail">
        <DialogHeader>
          <DialogTitle>{connection?.name}</DialogTitle>
          <DialogDescription>Tables, actions, who may use the connection, and what it did.</DialogDescription>
        </DialogHeader>
        {connection && (
          <Tabs defaultValue={actionKind ? 'actions' : 'tables'} className="min-w-0">
            <TabsList>
              <TabsTrigger value="tables" data-testid="tab-tables">Tables</TabsTrigger>
              <TabsTrigger value="actions" data-testid="tab-actions">Actions</TabsTrigger>
              <TabsTrigger value="access" data-testid="tab-access">Access</TabsTrigger>
              <TabsTrigger value="activity" data-testid="tab-activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="tables"><TablesTab conn={connection} onBrowse={() => onBrowse(connection)} /></TabsContent>
            <TabsContent value="actions">{actionKind ? <ActionsTab conn={connection} /> : <Empty icon={Zap} title="No actions" description="Database, sheet and file connections offer tables only in this version. Flows use data steps for them." />}</TabsContent>
            <TabsContent value="access"><AccessTab conn={connection} /></TabsContent>
            <TabsContent value="activity"><ActivityTab conn={connection} /></TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
