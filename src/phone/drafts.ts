/**
 * Form drafts across reloads (docs/dev/phone.md "Form drafts"). An unsaved New or Edit form of a running app is kept,
 * sealed, in the signed-in user's offline store (offline/index.ts `drafts`: the same AES-GCM key and IndexedDB database
 * as the outbox; never localStorage), keyed by app, screen, form and record. After an accidental reload or a discarded
 * tab the form restores it with a "Draft restored" note and a Discard button. Saving, Discard, putting the values back
 * (ResetForm), signing out and a device wipe delete it.
 *
 * Pure parts (keys, the restore decision) are tested in phone.test.ts; the React side is in
 * src/controls/inputs/Form.tsx. RunApp provides DraftScope (the Studio and design mode do not, so no drafts there).
 */
import { createContext } from 'react'
import { drafts, type FormDraft } from './offline'

export interface DraftScopeValue {
  appId: string
  /** the screen a UI component is on (part of the key) */
  screenOf(nodeId: string): string | undefined
}
export const DraftScope = createContext<DraftScopeValue | null>(null)

/** the record part of a key: Edit forms by row id; New forms (and Edit with a blank Item) by mode */
export function draftRecordKey(mode: string, itemId: string): string {
  return mode === 'Edit' && itemId ? `id:${itemId}` : `${mode.toLowerCase()}:new`
}

export function draftKeyOf(appId: string, screenId: string, formName: string, table: string, recordKey: string): string {
  return [appId, screenId || '-', formName, table.toLowerCase(), recordKey].map((p) => encodeURIComponent(p)).join('|')
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? new Date(v).toISOString() : null)

/**
 * What to do with a stored draft when a form loads:
 *  - 'ignore': no draft, another mode, or the person already typed (never overwrite what they are doing);
 *  - 'restore': same record version (or a New form);
 *  - 'restore-changed': an Edit draft whose record changed on the server since: restore it, SAY so, and keep the old
 *    version as the save's base so the save is refused (409) and the form's conflict panel asks (reload / keep mine).
 */
export function restoreDecision(o: { draft: Pick<FormDraft, 'mode' | 'base'> | null; mode: string; currentBase: unknown; untouched: boolean }): 'ignore' | 'restore' | 'restore-changed' {
  if (!o.draft || !o.untouched || o.draft.mode !== o.mode) return 'ignore'
  if (o.mode !== 'Edit') return 'restore'
  const a = iso(o.draft.base)
  const b = iso(o.currentBase)
  return a === b ? 'restore' : 'restore-changed'
}

/* one queue per draft key: a save that is still sealing never lands after the remove that followed it */
const chains = new Map<string, Promise<unknown>>()
function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next.catch(() => undefined))
  return next
}

export const formDrafts = {
  save: (key: string, d: Omit<FormDraft, 'files' | 'filesDropped'>, files: Array<{ column: string; file: File }>) => queued(key, () => drafts.save(key, d, files).catch(() => false)),
  load: (key: string) => queued(key, () => drafts.load(key).catch(() => null)),
  remove: (key: string) => queued(key, () => drafts.remove(key).catch(() => undefined)),
}

/** "Draft restored" note text */
export function draftNote(savedAt: number, changed: boolean, filesDropped?: boolean, now = Date.now()): string {
  const d = new Date(savedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const when = sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  let t = `Draft restored (kept on this device at ${when}).`
  if (changed) t += ' The record was changed by someone else since: saving will ask whether to keep yours or reload theirs.'
  if (filesDropped) t += ' Large photos were not kept: add them again.'
  return t
}
