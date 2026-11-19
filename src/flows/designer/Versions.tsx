/**
 * Version history with a visual diff: pick a version to compare with the one before it (or with the current one); the
 * outline of steps shows added (green), removed (red), changed (amber, with the fields) and moved (blue) steps and the
 * flow-level changes. Restore makes a new version from an old one (the server asks to confirm a change of identity).
 */
import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FlowDef, FlowVersionInfo } from '@/platform/flows'
import { Panel, errMsg, fmtDate, useToast } from '@/portal/kit'
import { flowsApi } from '../api'
import { diffFlows, type ChangeKind } from './diff'
import { kindInfo } from './palette'
import type { FlowDoc } from './model'

const TONE: Record<ChangeKind, string> = {
  added: 'border-emerald-500 bg-emerald-500/10', removed: 'border-red-500 bg-red-500/10 line-through decoration-red-500/60', changed: 'border-amber-500 bg-amber-500/10',
  moved: 'border-sky-500 bg-sky-500/10', same: 'border-border bg-card',
}

export function VersionHistory({ flow, canEdit, onRestored }: { flow: FlowDef; canEdit: boolean; onRestored(): void }) {
  const [items, setItems] = useState<FlowVersionInfo[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [against, setAgainst] = useState<'previous' | 'current'>('previous')
  const [docs, setDocs] = useState<Record<number, FlowDoc>>({})
  const { toast } = useToast()
  useEffect(() => { flowsApi.versions(flow.id).then((r) => { setItems(r.items); setSel((s) => s ?? r.items[0]?.version ?? null) }).catch((e) => toast(errMsg(e), 'error')) }, [flow.id, flow.version, toast])
  const base = sel === null ? null : against === 'current' ? flow.version : items.find((v) => v.version < sel)?.version ?? null
  useEffect(() => {
    for (const v of [sel, base]) if (v !== null && !docs[v]) flowsApi.version(flow.id, v).then((r) => setDocs((d) => ({ ...d, [v]: r.doc as FlowDoc }))).catch(() => undefined)
  }, [sel, base, flow.id, docs])
  const diff = useMemo(() => {
    if (sel === null || !docs[sel]) return null
    const from = base !== null ? docs[base] : null
    if (base !== null && !from) return null
    return against === 'current' ? diffFlows(docs[sel], from!) : diffFlows(from ?? { ...docs[sel], steps: [] }, docs[sel])
  }, [sel, base, docs, against])
  const restore = (v: number) => flowsApi.restore(flow.id, v)
    .catch((e) => (e.status === 409 && confirm(`${errMsg(e)}\n\nRestore anyway?`) ? flowsApi.restore(flow.id, v, true) : Promise.reject(e)))
    .then(() => { toast(`Version ${v} restored as a new version.`, 'success'); onRestored() }).catch((e) => toast(errMsg(e), 'error'))
  return (
    <div className="grid gap-3 md:grid-cols-[280px_1fr]" data-testid="version-history">
      <Panel className="max-h-[70vh] overflow-auto p-1">
        {items.map((v) => (
          <button key={v.version} type="button" className={cn('block w-full rounded px-2 py-1.5 text-left text-sm', sel === v.version ? 'bg-accent' : 'hover:bg-accent/50')} onClick={() => setSel(v.version)} data-testid={`version-${v.version}`}>
            <div className="font-medium">Version {v.version}{v.version === flow.version ? ' (published)' : ''}</div>
            <div className="text-xs text-muted-foreground">{fmtDate(v.savedOn)} · {v.savedByName ?? ''}{v.note ? ` · ${v.note}` : ''}</div>
          </button>
        ))}
      </Panel>
      <Panel className="p-3">
        {sel === null ? <p className="text-sm text-muted-foreground">No versions.</p> : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">Version {sel}</span>
              <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={against} onChange={(e) => setAgainst(e.target.value as 'previous' | 'current')} aria-label="Compare with">
                <option value="previous">compared with the version before it</option>
                <option value="current">compared with the published version</option>
              </select>
              {canEdit && sel !== flow.version && <Button size="sm" variant="outline" className="ml-auto" onClick={() => restore(sel)} data-testid="version-restore"><RotateCcw className="size-4" />Restore</Button>}
            </div>
            <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
              {(['added', 'removed', 'changed', 'moved'] as ChangeKind[]).map((k) => <span key={k} className={cn('rounded border px-1.5', TONE[k])}>{k}{against === 'current' && k === 'added' ? ' since' : ''}</span>)}
            </div>
            {!diff ? <p className="text-sm text-muted-foreground">Loading…</p> : (
              <>
                {diff.flow.length > 0 && <p className="mb-2 text-xs"><b>Flow:</b> {diff.flow.join(', ')} changed.</p>}
                <ol className="grid gap-1" data-testid="version-diff">
                  {diff.steps.map((s) => {
                    const info = kindInfo(s.kind)
                    const Icon = info.icon
                    return (
                      <li key={`${s.id}-${s.change}`} data-change={s.change} className={cn('flex items-center gap-2 rounded-md border px-2 py-1 text-sm', TONE[s.change])} style={{ marginLeft: s.depth * 20 }}>
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" /><span className="font-medium">{s.name}</span><span className="text-xs text-muted-foreground">{info.title}</span>
                        {s.change !== 'same' && <span className="ml-auto text-[11px] text-muted-foreground">{s.change}{s.fields.length ? `: ${s.fields.join(', ')}` : ''}</span>}
                      </li>
                    )
                  })}
                  {!diff.steps.length && <li className="text-sm text-muted-foreground">No steps.</li>}
                </ol>
              </>
            )}
          </>
        )}
      </Panel>
    </div>
  )
}
