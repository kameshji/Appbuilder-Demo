/**
 * The offline outbox (P2-A, docs/dev/phone.md "Outbox"): creates, updates and attachment uploads made while the
 * server cannot be reached, kept durably (IndexedDB, encrypted) and sent in order when it can.
 *
 * Rules
 *  - Order: items are sent strictly in the order they were made (a sequence number). An item waits while an earlier
 *    item of the same row is not sent (waiting, conflict or rejected): an update never overtakes the create of its row,
 *    an upload never overtakes its row.
 *  - Exactly once: every send carries `Idempotency-Key: <item id>.<revision>`; the server answers a repeated key with
 *    the first answer and writes nothing (server/core/offline.ts). A crash between "sent" and "removed from the outbox"
 *    therefore never duplicates. Creates also carry their client-generated row id.
 *  - Network failure (no answer) or a 5xx: the item stays waiting and the replay stops (retried later with backoff).
 *  - 409 version conflict (the row changed on the server since it was edited here): the item becomes `conflict` with
 *    the server's current row; the user keeps theirs (sent again against the new version) or takes the server's (the
 *    item is dropped).
 *  - Other refusals (validation rules, required columns, permissions: 4xx): the item becomes `rejected` with the
 *    message; "fix and resend" edits its values and sends it again (a new revision of its key). Server rules always win.
 *  - 401: replay pauses until the user signs in again.
 * Item metadata needed to count and order (kind, table, status, time) is stored in clear; values, files, errors and
 * server rows are sealed with the offline key (codec.ts). Without the key (a new browser session) items can be counted
 * but not read or sent.
 */
import type { KV } from './kv'
import type { Codec, Sealed } from './codec'

export type ItemKind = 'create' | 'update' | 'upload'
export type ItemStatus = 'waiting' | 'sending' | 'conflict' | 'rejected'

export interface ItemMeta {
  id: string
  seq: number
  kind: ItemKind
  table: string
  rowId: string
  environmentId: string
  appId: string
  createdAt: number
  status: ItemStatus
  attempts: number
  /** revision of the idempotency key: raised by "fix and resend" and "keep mine" */
  rev: number
  /** the item waits for an earlier item of the same row (computed, not stored) */
  blocked?: boolean
}

export interface ItemBody {
  values?: Record<string, unknown>
  ifModifiedOn?: string
  column?: string
  fileName?: string
  fileType?: string
  fileSize?: number
  label?: string
  /** P3-D: the Form this write is the submit of; sent with the write so the server raises that form's flows once */
  form?: { app: string; form: string }
  error?: { code: string; message: string; field?: string }
  /** conflict: the row as it is on the server now */
  current?: Record<string, unknown>
}

interface Stored extends ItemMeta {
  body: Sealed
  file?: Sealed
}

export interface ItemView extends ItemMeta {
  /** decrypted details; absent while the offline key is not available */
  body?: ItemBody
}

export type SendResult =
  | { ok: true; result: unknown }
  | { ok: false; network: true }
  | { ok: false; status: number; code: string; message: string; field?: string; current?: Record<string, unknown> }

export interface SendRequest {
  item: ItemMeta
  body: ItemBody
  file?: Blob
  idempotencyKey: string
}

export interface Transport {
  send(req: SendRequest): Promise<SendResult>
}

export interface NewItem {
  kind: ItemKind
  table: string
  rowId: string
  environmentId: string
  appId?: string
  values?: Record<string, unknown>
  ifModifiedOn?: string
  column?: string
  file?: Blob
  fileName?: string
  label?: string
  form?: { app: string; form: string }
}

export interface Callbacks {
  done(result: unknown): void
  fail(error: unknown): void
}

export interface FlushResult {
  sent: number
  /** why the replay stopped early: 'network' (offline), 'server' (5xx, try later), 'auth' (sign in), 'busy' (same key in flight), 'locked' (no key) */
  stopped?: 'network' | 'server' | 'auth' | 'busy' | 'locked'
}

const seqKey = (n: number) => String(n).padStart(12, '0')
const META_SEQ = 'outbox-seq'

let idCounter = 0
function newId(now: number): string {
  const rnd = new Uint8Array(8)
  ;(globalThis as { crypto: Crypto }).crypto.getRandomValues(rnd)
  return `ob_${now.toString(36)}${(++idCounter).toString(36)}_${[...rnd].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export class Outbox {
  private items: Stored[] = []
  private codec: Codec | null = null
  private callbacks = new Map<string, Callbacks>()
  private listeners = new Set<() => void>()
  private flushing: Promise<FlushResult> | null = null
  private loaded = false
  private seq = 0
  private views: ItemView[] = []
  private viewsDirty = true
  private decoded = new Map<string, ItemBody>()

  constructor(private readonly kv: KV, private readonly transport: Transport, private readonly now: () => number = () => Date.now()) {}

  /** read what is stored (after a restart); works without the key */
  async load(): Promise<void> {
    const rows = await this.kv.entries<Stored>('outbox')
    this.items = rows.map(([, v]) => v).sort((a, b) => a.seq - b.seq)
    // a send cut short by a crash or a closed tab: send it again (the idempotency key makes that safe)
    for (const it of this.items) if (it.status === 'sending') it.status = 'waiting'
    this.seq = Math.max((await this.kv.get<number>('meta', META_SEQ)) ?? 0, ...this.items.map((i) => i.seq))
    this.loaded = true
    await this.decodeAll()
    this.changed()
  }

  /** the offline key arrived (or was dropped: null) */
  async setCodec(codec: Codec | null): Promise<void> {
    this.codec = codec
    this.decoded.clear()
    await this.decodeAll()
    this.changed()
  }
  get unlocked(): boolean {
    return this.codec !== null
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** items in order, with `blocked` set and the details when the key is available */
  list(): ItemView[] {
    if (!this.viewsDirty) return this.views
    const blockedRows = new Set<string>()
    this.views = this.items.map((it) => {
      const rowKey = `${it.table}\u0000${it.rowId}`
      const blocked = blockedRows.has(rowKey)
      if (it.status !== 'sending') blockedRows.add(rowKey)
      const body = this.decoded.get(it.id)
      return { id: it.id, seq: it.seq, kind: it.kind, table: it.table, rowId: it.rowId, environmentId: it.environmentId, appId: it.appId, createdAt: it.createdAt, status: it.status, attempts: it.attempts, rev: it.rev, ...(blocked ? { blocked } : {}), ...(body ? { body } : {}) }
    })
    this.viewsDirty = false
    return this.views
  }

  get count(): number {
    return this.items.length
  }

  /** an unsent item of this row exists (later writes of the row must queue behind it) */
  pendingFor(table: string, rowId: string): boolean {
    const t = table.toLowerCase()
    return this.items.some((i) => i.rowId === rowId && i.table.toLowerCase() === t)
  }

  async add(n: NewItem, cb?: Callbacks): Promise<ItemView> {
    if (!this.codec) throw new Error('The offline store is locked: connect once to unlock it.')
    if (!this.loaded) await this.load()
    const at = this.now()
    const id = newId(at)
    const seq = ++this.seq
    const body: ItemBody = {
      ...(n.values ? { values: n.values } : {}),
      ...(n.ifModifiedOn ? { ifModifiedOn: n.ifModifiedOn } : {}),
      ...(n.column ? { column: n.column } : {}),
      ...(n.file ? { fileName: n.fileName ?? 'file', fileType: n.file.type || 'application/octet-stream', fileSize: n.file.size } : {}),
      ...(n.label ? { label: n.label } : {}),
      ...(n.form ? { form: n.form } : {}),
    }
    const stored: Stored = {
      id, seq, kind: n.kind, table: n.table, rowId: n.rowId, environmentId: n.environmentId, appId: n.appId ?? '', createdAt: at, status: 'waiting', attempts: 0, rev: 0,
      body: await this.codec.seal(body),
      ...(n.file ? { file: await this.codec.sealBytes(await n.file.arrayBuffer()) } : {}),
    }
    // durable before we say it is kept: the item and the sequence counter
    await this.kv.put('outbox', seqKey(seq), stored)
    await this.kv.put('meta', META_SEQ, this.seq)
    this.items.push(stored)
    this.decoded.set(id, body)
    if (cb) this.callbacks.set(id, cb)
    this.changed()
    return this.list().find((v) => v.id === id)!
  }

  /**
   * Send what can be sent, in order. Concurrent calls share one replay. Items behind a conflict or rejection of the
   * same row wait; other rows go on.
   */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.replay().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async replay(): Promise<FlushResult> {
    if (!this.loaded) await this.load()
    if (!this.codec) return { sent: 0, stopped: this.items.length ? 'locked' : undefined }
    let sent = 0
    const blocked = new Set<string>()
    for (const it of [...this.items]) {
      const rowKey = `${it.table}\u0000${it.rowId}`
      if (it.status === 'conflict' || it.status === 'rejected' || blocked.has(rowKey)) {
        blocked.add(rowKey)
        continue
      }
      const body = await this.bodyOf(it)
      const file = it.file ? new Blob([await this.codec.openBytes(it.file)], { type: body.fileType ?? 'application/octet-stream' }) : undefined
      await this.setStatus(it, 'sending')
      let res: SendResult
      try {
        res = await this.transport.send({ item: this.metaOf(it), body, ...(file ? { file } : {}), idempotencyKey: `${it.id}.${it.rev}` })
      } catch {
        res = { ok: false, network: true }
      }
      if (res.ok) {
        await this.kv.delete('outbox', seqKey(it.seq))
        this.items = this.items.filter((x) => x !== it)
        this.decoded.delete(it.id)
        sent++
        const cb = this.callbacks.get(it.id)
        this.callbacks.delete(it.id)
        this.changed()
        this.onSent?.(this.metaOf(it), res.result, !!cb)
        try {
          cb?.done(res.result)
        } catch {
          /* the UI callback must not stop the replay */
        }
        continue
      }
      it.attempts++
      if ('network' in res) {
        await this.setStatus(it, 'waiting')
        return { sent, stopped: 'network' }
      }
      if (res.status === 401) {
        await this.setStatus(it, 'waiting')
        return { sent, stopped: 'auth' }
      }
      if (res.status >= 500 || res.status === 429) {
        await this.setStatus(it, 'waiting')
        return { sent, stopped: 'server' }
      }
      if (res.status === 409 && res.field === 'Idempotency-Key') {
        await this.setStatus(it, 'waiting')
        return { sent, stopped: 'busy' }
      }
      const conflict = res.status === 409 && res.field === 'modifiedOn'
      const nextBody: ItemBody = { ...body, error: { code: res.code, message: res.message, ...(res.field ? { field: res.field } : {}) }, ...(conflict && res.current ? { current: res.current } : {}) }
      await this.rewrite(it, conflict ? 'conflict' : 'rejected', nextBody)
      blocked.add(rowKey)
      const cb = this.callbacks.get(it.id)
      this.callbacks.delete(it.id)
      try {
        cb?.fail(Object.assign(new Error(res.message), { code: res.code, field: res.field }))
      } catch {
        /* ignore */
      }
    }
    return { sent }
  }

  /** called after every item the server accepted: (item, server answer, whether a live callback settled it) */
  onSent: ((item: ItemMeta, result: unknown, settled: boolean) => void) | null = null

  /** conflict: send my version again against the server's current version */
  async keepMine(id: string): Promise<void> {
    const it = this.need(id)
    const body = await this.bodyOf(it)
    const v = body.current?.modifiedOn
    const next: ItemBody = { ...body, ...(typeof v === 'string' ? { ifModifiedOn: v } : {}) }
    delete next.error
    delete next.current
    it.rev++
    await this.rewrite(it, 'waiting', next)
  }

  /** conflict: keep the server's version (drop my change) */
  async useServer(id: string): Promise<void> {
    await this.discard(id)
  }

  /** rejected: send again, optionally with corrected values (merged into the item's values) */
  async resend(id: string, values?: Record<string, unknown>): Promise<void> {
    const it = this.need(id)
    const body = await this.bodyOf(it)
    const next: ItemBody = { ...body, ...(values ? { values: { ...(body.values ?? {}), ...values } } : {}) }
    delete next.error
    delete next.current
    it.rev++
    it.attempts = 0
    await this.rewrite(it, 'waiting', next)
  }

  async discard(id: string): Promise<void> {
    const it = this.need(id)
    await this.kv.delete('outbox', seqKey(it.seq))
    this.items = this.items.filter((x) => x !== it)
    this.decoded.delete(id)
    this.callbacks.get(id)?.fail(new Error('Discarded'))
    this.callbacks.delete(id)
    this.changed()
  }

  /** forget everything (sign-out, wipe); the caller destroys the database */
  reset(): void {
    this.items = []
    this.decoded.clear()
    this.callbacks.clear()
    this.seq = 0
    this.changed()
  }

  /* ---------------------------------------------------------------- internals */

  private need(id: string): Stored {
    const it = this.items.find((x) => x.id === id)
    if (!it) throw new Error('This item is no longer waiting to be sent.')
    if (!this.codec) throw new Error('The offline store is locked: connect once to unlock it.')
    return it
  }
  private metaOf(it: Stored): ItemMeta {
    return { id: it.id, seq: it.seq, kind: it.kind, table: it.table, rowId: it.rowId, environmentId: it.environmentId, appId: it.appId, createdAt: it.createdAt, status: it.status, attempts: it.attempts, rev: it.rev }
  }
  private async bodyOf(it: Stored): Promise<ItemBody> {
    const hit = this.decoded.get(it.id)
    if (hit) return hit
    const body = await this.codec!.open<ItemBody>(it.body)
    this.decoded.set(it.id, body)
    return body
  }
  private async decodeAll() {
    if (!this.codec) return
    for (const it of this.items) {
      try {
        await this.bodyOf(it)
      } catch {
        /* sealed with another key (wiped epoch): the keyring discards such stores */
      }
    }
  }
  private async setStatus(it: Stored, status: ItemStatus) {
    it.status = status
    await this.kv.put('outbox', seqKey(it.seq), it)
    this.changed()
  }
  private async rewrite(it: Stored, status: ItemStatus, body: ItemBody) {
    it.status = status
    it.body = await this.codec!.seal(body)
    this.decoded.set(it.id, body)
    await this.kv.put('outbox', seqKey(it.seq), it)
    this.changed()
  }
  private changed() {
    this.viewsDirty = true
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        /* a listener must not break the outbox */
      }
    }
  }
}
