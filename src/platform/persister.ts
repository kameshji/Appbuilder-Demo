/**
 * Write-behind persistence: debounced, serialised per key, flushable.
 * A writer must be state-based (read the current state when it runs), so a superseded
 * writer can simply be dropped.
 */
export type Writer = () => Promise<void>

export class Persister {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private since = new Map<string, number>()
  private writers = new Map<string, Writer>()
  private chains = new Map<string, Promise<void>>()

  constructor(
    private delayMs: number,
    private maxWaitMs: number,
    private onError: (e: unknown) => void,
  ) {}

  /** number of writes pending or in flight */
  get pending(): number {
    return this.writers.size + this.chains.size
  }

  /** debounced write (trailing edge, with a maximum wait) */
  schedule(key: string, writer: Writer): void {
    this.writers.set(key, writer)
    const first = this.since.get(key) ?? Date.now()
    this.since.set(key, first)
    const t = this.timers.get(key)
    if (t) clearTimeout(t)
    const wait = Math.max(0, Math.min(this.delayMs, first + this.maxWaitMs - Date.now()))
    const handle = setTimeout(() => void this.fire(key), wait)
    ;(handle as { unref?: () => void }).unref?.()
    this.timers.set(key, handle)
  }

  /** write now (after anything already running for the key); the promise resolves when done */
  now(key: string, writer: Writer): Promise<void> {
    this.drop(key)
    return this.enqueue(key, writer)
  }

  private drop(key: string) {
    const t = this.timers.get(key)
    if (t) clearTimeout(t)
    this.timers.delete(key)
    this.since.delete(key)
    this.writers.delete(key)
  }

  private fire(key: string): Promise<void> {
    const w = this.writers.get(key)
    this.drop(key)
    return w ? this.enqueue(key, w) : Promise.resolve()
  }

  private enqueue(key: string, writer: Writer): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next: Promise<void> = prev.then(writer).catch(this.onError)
    this.chains.set(key, next)
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    return next
  }

  /** fire everything pending and wait until all writes (including ones queued meanwhile) are done */
  async flush(): Promise<void> {
    for (const key of [...this.writers.keys()]) void this.fire(key)
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()])
      for (const key of [...this.writers.keys()]) void this.fire(key)
    }
  }
}
