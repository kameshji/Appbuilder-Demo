/** The loader hook of the Accounts area: runs a server call on mount and when its dependencies change. */
import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '../kit'

/**
 * loads on mount and when `deps` change; `reload` runs it again. When `deps` change, the answer for the old ones is not
 * returned while the new one loads (switching Reference data from Rates to States must not show rate rows under the
 * States headings); a `reload` with the same deps keeps showing the last answer until the new one arrives.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string; reload(): void; set(v: T): void } {
  const key = JSON.stringify(deps)
  const [got, setGot] = useState<{ key: string; data: T } | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setError('')
    fn().then((d) => { if (alive) setGot({ key, data: d }) }).catch((e) => { if (alive) setError(errMsg(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key])
  const set = useCallback((v: T) => setGot({ key, data: v }), [key])
  return { data: got && got.key === key ? got.data : null, error, reload: useCallback(() => setTick((t) => t + 1), []), set }
}
