/**
 * A run shown on the canvas (pure): the status, duration, attempts, inputs/outputs of each step of the definition,
 * from the run's step rows (keys like /mgr, /decide.then/dir, /each#2/inner). Inside loops the canvas shows one
 * iteration at a time (a pager per loop); the loop's own card sums them up.
 */
import type { FlowRunDetail, FlowStepRun } from '@/platform/flows'

export interface StepOverlay { status: string; durationMs?: number; attempt: number; simulated: boolean; row: FlowStepRun; count: number }

/** the iterations a run has for each loop id, sorted */
export function loopIterations(run: FlowRunDetail | null): Record<string, number[]> {
  const out: Record<string, Set<number>> = {}
  for (const s of run?.steps ?? []) {
    for (const m of s.key.matchAll(/\/([A-Za-z0-9_]+)#(\d+)/g)) (out[m[1]] ??= new Set()).add(Number(m[2]))
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))
}

/** step id -> what the canvas shows; `iteration` picks the iteration of each loop (default: the last one) */
export function overlayOf(run: FlowRunDetail | null, iteration: Record<string, number>): Map<string, StepOverlay> {
  const out = new Map<string, StepOverlay>()
  if (!run) return out
  const iters = loopIterations(run)
  const chosen = (loop: string) => iteration[loop] ?? iters[loop]?.[iters[loop].length - 1]
  for (const s of run.steps) {
    if (s.kind === 'iteration') continue
    // a row inside loop iterations other than the chosen ones is not shown
    let other = false
    for (const m of s.key.matchAll(/\/([A-Za-z0-9_]+)#(\d+)/g)) if (Number(m[2]) !== chosen(m[1])) other = true
    if (other) continue
    const prev = out.get(s.stepId)
    out.set(s.stepId, { status: s.status, durationMs: s.durationMs, attempt: s.attempt, simulated: !!s.simulated, row: s, count: (prev?.count ?? 0) + 1 })
  }
  return out
}

export const fmtDuration = (ms?: number): string => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)
