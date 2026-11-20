/**
 * Autosave of a note (docs/dev/notes.md), without React: edits are saved after a pause in typing (`delayMs`), at the
 * latest `maxWaitMs` after the first unsaved edit, and at once on `flush()` (leaving the note, closing the tab). One save
 * at a time; edits made while a save runs are saved right after it. Each save carries the version the edit started from
 * (the row's modifiedOn): a newer save elsewhere answers with a conflict, autosave stops and the page shows the choice
 * (merge.ts). Timers are injected so the tests drive the clock.
 */

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

export interface NoteDraft { subject: string; body: string }

/** what a save that lost the race reports: the saved version as it is now */
export class NoteConflict extends Error {
  readonly current: NoteDraft & { version: string; by?: string | null }
  constructor(current: NoteDraft & { version: string; by?: string | null }) {
    super('This note was changed somewhere else after you opened it.')
    this.current = current
  }
}

export interface AutosaveDeps {
  delayMs: number
  maxWaitMs: number
  /** saves the draft against `version`; resolves with the new version; throws NoteConflict on a stale version */
  save(draft: NoteDraft, version: string): Promise<string>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
  onChange(s: AutosaveSnapshot): void
}

export interface AutosaveSnapshot {
  state: SaveState
  /** the version this tab's edits are based on */
  version: string
  /** what was last saved (or loaded): the base of a three-way merge */
  saved: NoteDraft
  /** set while state is 'conflict' */
  conflict: (NoteDraft & { version: string; by?: string | null }) | null
  error: string | null
}

export function createAutosave(initial: NoteDraft, version: string, deps: AutosaveDeps) {
  let saved: NoteDraft = { ...initial }
  let current: NoteDraft = { ...initial }
  let ver = version
  let state: SaveState = 'saved'
  let conflict: AutosaveSnapshot['conflict'] = null
  let error: string | null = null
  let timer: unknown = null
  let firstDirtyAt: number | null = null
  let running: Promise<void> | null = null
  let stopped = false

  const snapshot = (): AutosaveSnapshot => ({ state, version: ver, saved: { ...saved }, conflict, error })
  const emit = () => deps.onChange(snapshot())
  const isDirty = () => current.subject !== saved.subject || current.body !== saved.body
  const clear = () => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }
  const arm = () => {
    clear()
    if (stopped || state === 'conflict') return
    const now = deps.now()
    firstDirtyAt ??= now
    const wait = Math.max(0, Math.min(deps.delayMs, firstDirtyAt + deps.maxWaitMs - now))
    timer = deps.setTimer(() => {
      timer = null
      void run()
    }, wait)
  }

  async function run(): Promise<void> {
    if (stopped || state === 'conflict') return
    if (running) {
      return running
    }
    if (!isDirty()) {
      state = 'saved'
      firstDirtyAt = null
      emit()
      return
    }
    const draft = { ...current }
    state = 'saving'
    error = null
    emit()
    running = (async () => {
      try {
        const next = await deps.save(draft, ver)
        ver = next
        saved = draft
        firstDirtyAt = null
        state = isDirty() ? 'dirty' : 'saved'
      } catch (e) {
        if (e instanceof NoteConflict) {
          state = 'conflict'
          conflict = e.current
          clear()
        } else {
          state = 'error'
          error = e instanceof Error ? e.message : String(e)
        }
      } finally {
        running = null
      }
      emit()
      // edits made while saving are saved after the usual pause
      if (state === 'dirty') arm()
    })()
    return running
  }

  return {
    /** the editor changed */
    change(next: Partial<NoteDraft>): void {
      current = { ...current, ...next }
      if (state === 'conflict') return
      if (!isDirty()) {
        if (state === 'dirty') { state = 'saved'; firstDirtyAt = null; clear(); emit() }
        return
      }
      if (state !== 'saving') {
        state = 'dirty'
        emit()
      }
      arm()
    },
    /** save now (leaving the note, closing the tab); resolves when nothing is pending */
    async flush(): Promise<void> {
      clear()
      if (running) await running
      if (isDirty() && state !== 'conflict') await run()
    },
    /** retry after an error */
    retry(): void {
      if (state === 'error') { state = 'dirty'; arm(); emit() }
    },
    /**
     * the person chose in the conflict dialog: `draft` becomes this tab's text, based on the version saved elsewhere
     * (then it is saved unless it equals that version)
     */
    resolve(draft: NoteDraft): void {
      if (!conflict) return
      saved = { subject: conflict.subject, body: conflict.body }
      ver = conflict.version
      conflict = null
      current = { ...draft }
      state = isDirty() ? 'dirty' : 'saved'
      firstDirtyAt = null
      emit()
      if (state === 'dirty') void run()
    },
    /** the saved version moved without an edit here (an image upload): take the new version if nothing else changed */
    rebase(next: NoteDraft & { version: string }): boolean {
      if (next.subject !== saved.subject || next.body !== saved.body) {
        state = 'conflict'
        conflict = next
        clear()
        emit()
        return false
      }
      ver = next.version
      emit()
      return true
    },
    /** someone saved elsewhere while this tab has no unsaved edit: take their version as it is (false: there are edits here) */
    adopt(next: NoteDraft & { version: string }): boolean {
      if (isDirty() || running || state === 'conflict') return false
      saved = { subject: next.subject, body: next.body }
      current = { ...saved }
      ver = next.version
      state = 'saved'
      emit()
      return true
    },
    current: () => ({ ...current }),
    snapshot,
    dirty: isDirty,
    stop(): void {
      stopped = true
      clear()
    },
  }
}

export type Autosave = ReturnType<typeof createAutosave>
