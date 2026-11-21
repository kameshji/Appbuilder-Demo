/** The loader hook of the Accounts area: runs a server call on mount and when its dependencies change. */
import { useCallback, useEffect, useState } from 'react'
import { errMsg } from '../kit'

/** loads on mount and when `deps` change; `reload` runs it again */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string; reload(): void; set(v: T): void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setError('')
    fn().then((d) => { if (alive) setData(d) }).catch((e) => { if (alive) setError(errMsg(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []), set: setData }
}
