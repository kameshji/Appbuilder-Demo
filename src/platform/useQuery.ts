/**
 * React binding of the Query v2 cache (P0 package D): the current state of a plan, re-rendered when its cache entry
 * changes. Releases the owner on unmount (an in-flight request nobody wants is cancelled).
 */
import { useEffect, useReducer } from 'react'
import { platform } from './index'
import type { QueryPlan } from './query'
import type { QueryOptions, QueryState } from './query-cache'
import { cacheKey } from './query-cache'

export function useQuery(plan: QueryPlan | null, opts: QueryOptions & { owner: string }): QueryState | null {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const key = plan ? cacheKey(plan, opts) : ''
  useEffect(() => {
    if (!plan) return
    return platform.tables.onQueryChange((keys) => {
      if (keys.includes(key)) bump()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => platform.tables.releaseQuery(opts.owner), [opts.owner])
  if (!plan) return null
  return platform.tables.queryState(plan, opts)
}
