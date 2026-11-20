/**
 * Seat passes in Admin console > Users (hosting phase, H-H): the Pass column and the bulk action. The server decides
 * and enforces (server/core/licence/seats.ts); this only shows and asks. Install administrators assign; others see.
 */
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from './kit'
import { PASS_LABELS, assignPasses, fetchPasses, type PassKind, type SeatState } from './licenceApi'

export interface PassesState {
  passes: Record<string, PassKind>
  seats: SeatState | null
  reload(): void
  assign(userIds: string[], pass: PassKind): Promise<boolean>
}

export function usePasses(enabled: boolean, usersKey: number): PassesState | null {
  const { fail, toast } = useToast()
  const [data, setData] = useState<{ passes: Record<string, PassKind>; seats: SeatState | null } | null>(null)
  const reload = useCallback(() => {
    if (!enabled) return
    fetchPasses().then((r) => setData({ passes: r.passes, seats: r.seats })).catch(() => setData(null))
  }, [enabled])
  useEffect(reload, [reload, usersKey])
  if (!enabled || !data) return null
  return {
    ...data,
    reload,
    async assign(userIds, pass) {
      try {
        const r = await assignPasses(userIds, pass)
        toast(r.changed.length ? `${PASS_LABELS[pass]} pass for ${r.changed.length === 1 ? '1 person' : `${r.changed.length} people`}` : 'Nothing to change', 'success')
        reload()
        return true
      } catch (e) {
        fail(e)
        return false
      }
    },
  }
}

const TONE: Record<PassKind, string> = {
  full: 'border-sky-500/40 text-sky-700 dark:text-sky-300',
  operator: 'border-violet-500/40 text-violet-700 dark:text-violet-300',
  external: 'border-border text-muted-foreground',
}

export function PassCell({ userId, name, state, canAssign }: { userId: string; name: string; state: PassesState | null; canAssign: boolean }) {
  const pass = state?.passes[userId] ?? 'full'
  if (!state) return <span className="text-xs text-muted-foreground">-</span>
  if (!canAssign) return <Badge variant="outline" className={TONE[pass]} data-testid={`user-pass-${userId}`}>{PASS_LABELS[pass]}</Badge>
  return (
    <select
      aria-label={`Pass of ${name}`}
      value={pass}
      onChange={(e) => void state.assign([userId], e.target.value as PassKind)}
      className="h-7 rounded-md border border-input bg-background px-2 text-xs"
      data-testid={`user-pass-${userId}`}
    >
      <option value="full">Full user</option>
      <option value="operator">Operator</option>
      {pass === 'external' && <option value="external" disabled>External</option>}
    </select>
  )
}

/** shown when people are selected: set one pass for all of them */
export function PassBulkBar({ selected, state, onDone }: { selected: string[]; state: PassesState | null; onDone(): void }) {
  if (!state || selected.length === 0) return null
  const run = async (p: PassKind) => {
    if (await state.assign(selected, p)) onDone()
  }
  const over = Object.entries(state.seats?.over ?? {}).filter(([, x]) => x)
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm" data-testid="pass-bulk">
      <span className="font-medium">{selected.length === 1 ? '1 person selected' : `${selected.length} people selected`}</span>
      <span className="text-muted-foreground">Set pass:</span>
      <Button size="sm" variant="outline" onClick={() => void run('full')} data-testid="pass-bulk-full">Full user</Button>
      <Button size="sm" variant="outline" onClick={() => void run('operator')} data-testid="pass-bulk-operator">Operator</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Clear selection</Button>
      {over.length > 0 && <span className="text-xs text-amber-700 dark:text-amber-300">Over the licence: {over.map(([k, x]) => `${PASS_LABELS[k as PassKind]} by ${x!.by}`).join(', ')}.</span>}
    </div>
  )
}
