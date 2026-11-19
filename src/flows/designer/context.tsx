/**
 * What the designer's panels read besides the definition: the catalogue (step kinds, trigger types, whether approvals
 * are available), the environment's tables, flows (child flows), connections the maker may use and their actions
 * (inputs and output schemas), people and teams. Loaded once per designer.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { usePlatform } from '@/platform'
import type { TableDef } from '@/platform/contracts'
import type { FlowListItem } from '@/platform/flows'
import { actionsApi, type ActionDef } from '@/portal/actionsApi'
import { flowsApi, type FlowCatalog } from '../api'
import { dynamicContent, type DynContext, type DynToken, type JsonSchemaLite } from './dynamic'
import { useDesigner } from './store'

export interface UsableConnection { id: string; name: string; connector: string; status: string; canManage: boolean }

export interface DesignerData {
  catalog: FlowCatalog | null
  tables: TableDef[]
  flows: FlowListItem[]
  /** connections the maker may use (null: not loaded or the actions service is missing) */
  usable: UsableConnection[] | null
  /** actions by connection id (loaded on demand) */
  actions: Record<string, ActionDef[] | undefined>
  loadActions(connectionId: string): void
  users: { id: string; name: string; email: string; kind?: string; status?: string }[]
  teams: { id: string; code: string; name: string }[]
}

const Ctx = createContext<DesignerData | null>(null)

export function DesignerDataProvider({ children }: { children: React.ReactNode }) {
  const tables = usePlatform((s) => s.tables)
  const users = usePlatform((s) => s.users)
  const teams = usePlatform((s) => s.teams)
  const [catalog, setCatalog] = useState<FlowCatalog | null>(null)
  const [flows, setFlows] = useState<FlowListItem[]>([])
  const [usable, setUsable] = useState<UsableConnection[] | null>(null)
  const [actions, setActions] = useState<Record<string, ActionDef[] | undefined>>({})
  useEffect(() => {
    flowsApi.catalog().then(setCatalog).catch(() => setCatalog(null))
    flowsApi.list().then((r) => setFlows(r.items)).catch(() => setFlows([]))
    actionsApi.usable().then((r) => setUsable(r.items)).catch(() => setUsable([]))
  }, [])
  const value = useMemo<DesignerData>(() => ({
    catalog, tables, flows, usable, actions, users, teams: teams.map((t) => ({ id: t.id, code: t.code, name: t.name })),
    loadActions: (id: string) => {
      if (!id || actions[id] !== undefined) return
      setActions((a) => ({ ...a, [id]: a[id] ?? [] }))
      actionsApi.list(id).then((r) => setActions((a) => ({ ...a, [id]: r.items }))).catch(() => setActions((a) => ({ ...a, [id]: [] })))
    },
  }), [catalog, tables, flows, usable, actions, users, teams])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDesignerData(): DesignerData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDesignerData outside the designer')
  return v
}

/** the dynamic-content context: tables and the output schemas of the actions of attached connections */
export function useDynContext(): DynContext {
  const d = useDesignerData()
  const connections = useDesigner((s) => s.connections)
  return useMemo(() => ({
    tables: d.tables,
    actionOutput: (ref: string, action: string) => {
      const id = connections[ref]
      const a = id ? d.actions[id]?.find((x) => x.id === action) : undefined
      return (a?.outputs as JsonSchemaLite | undefined) ?? null
    },
  }), [d.tables, d.actions, connections])
}

/** the tokens a field of a step can insert */
export function useTokens(stepId: string): DynToken[] {
  const doc = useDesigner((s) => s.doc)
  const ctx = useDynContext()
  return useMemo(() => dynamicContent(doc, stepId, ctx), [doc, stepId, ctx])
}
