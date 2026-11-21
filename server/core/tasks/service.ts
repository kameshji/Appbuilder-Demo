/**
 * Tasks at run time (P3 package T, docs/dev/tasks.md, spec 5.10): what the platform does around Activities of Type Task
 * and the sharing table, beyond the generic DataService.
 *
 *  - Reminders (`tasks.reminders`, every minute): an open activity whose ReminderOn has passed gets ONE notification (kind
 *    `task`, through the notification pipeline: in the app and the person's chosen channels) and ReminderSentOn is
 *    stamped. Idempotent in two ways: a task is due while `ReminderSentOn IS NULL OR ReminderSentOn < ReminderOn` (moving
 *    the reminder later arms it again, a sent one never fires twice), and the notification carries the idempotency key
 *    `task-reminder:<id>:<ReminderOn>`, so a crash between the notification and the stamp cannot send a second one.
 *    Reminders older than 7 days are not sent (a long pause must not flood people).
 *  - Overdue digest (`tasks.digest`, hourly): from 08:00 in each person's own time zone, ONE notification a day (kind `task`;
 *    with email set to "digest" for tasks it lands in their email digest) listing what is overdue and due today. A marker
 *    row per person and day (ab_counters) stops a repeat, also after the person deleted the notification.
 *  - Recurring tasks: completing a task that has a Recurrence creates the next occurrence in the SAME transaction as the
 *    completion (collab.ts calls `afterActivityWrite` from the write hook); the unique index on RecurrenceParent and an
 *    existence check make it exactly once under a double completion.
 *  - Shares (ActivityShares): validation of a share row, cleanup when an activity is deleted (recycle bin aware).
 *
 * Read-only install (hosting-spec.md): while APPBUILDER_READ_ONLY=1 both jobs skip their run (they write); reminders wait
 * and go out after the install is writable again (within 7 days). HOSTING H-C HOOK: when the shared gate of package H-C
 * exists, `installReadOnly` below should ask it instead of the process environment.
 */
import { HttpError } from '../contracts.ts'
import type { DataService, MetaStore, NotificationService, RawRow, SqlDb } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import { REGARDING, SYS, richTextToPlain } from '../../../src/platform/system-tables.ts'
import { sanitizeNoteHtml } from '../../../src/notes/sanitize.ts'
import { civilIn, nextDue, parseRecurrence } from '../../../src/platform/recurrence.ts'
import { currentEnvironment } from '../env-context.ts'
import { errText } from '../util.ts'
import { liveRowsSql } from '../../connectors/postgres/sql.ts'
import type { JobTypeDef } from '../jobs.ts'
import { BUILTIN_SCHEDULES } from '../kernel.ts'

export const TASK_REMINDERS_JOB = 'tasks.reminders'
export const TASK_DIGEST_JOB = 'tasks.digest'
/** reminders older than this are dropped, not sent (a read-only period or an outage must not flood people) */
export const REMINDER_WINDOW_MS = 7 * 24 * 3600_000
/** at most this many reminders per run (the rest go out on the next minute) */
export const REMINDER_BATCH = 200
/** the digest goes out from this local hour (08:00) until DIGEST_LAST_HOUR */
export const DIGEST_HOUR = 8
export const DIGEST_LAST_HOUR = 20
export const DIGEST_LINES = 5
/** a note's stored body (characters), spec 5.10 */
export const NOTE_BODY_MAX = 200_000

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const blank = (v: unknown): boolean => v === null || v === undefined || v === ''
const invalid = (m: string, field?: string) => new HttpError(422, 'invalid', m, field)
const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export interface TaskDeps {
  db(): SqlDb | null
  meta(): MetaStore
  data(): DataService
  notifications(): NotificationService | undefined
  log(level: 'info' | 'warn' | 'error', msg: string): void
  /** the process environment (APPBUILDER_READ_ONLY=1: the install is read-only, hosting-spec.md) */
  env?: NodeJS.ProcessEnv
  /** the clock (tests inject one; jobs use the real time) */
  now?(): Date
  /**
   * P3 review, P3-13: may this person read this activity now (their own security context)? Reminders and the digest
   * fall back to the OWNER of an unassigned task, who may have lost access to the record it is about. Absent: no check.
   */
  canRead?(table: TableDef, rowId: string, userId: string): Promise<boolean>
}

export type Tasks = ReturnType<typeof createTasks>

export interface RunSummary { sent?: number; skipped?: string; failed?: number; people?: number }

export function createTasks(deps: TaskDeps) {
  const clock = (): Date => deps.now?.() ?? new Date()
  const procEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env
  /** HOSTING H-C HOOK: replace with the shared read-only gate when it exists (licence, suspension, payment) */
  const installReadOnly = (): boolean => procEnv().APPBUILDER_READ_ONLY === '1'
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const S = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
  const tables = () => deps.meta().tables.list()
  const activitiesDef = async (): Promise<TableDef | undefined> => (await tables()).find((t) => t.id === SYS.activities)

  /**
   * the rich-text cleaner of Body: the NOTE_TAGS allow-list of src/notes/sanitize.ts (P3-N) from the start, so every
   * services instance is safe; the Notes service (server/core/notes/service.ts) installs it again through setNoteSanitizer
   */
  let noteSanitizer: (html: string) => string = (html) => sanitizeNoteHtml(html)
  function setNoteSanitizer(fn: (html: string) => string): void {
    noteSanitizer = fn
  }
  /** P3-N: what the Notes service does after a note is written, inside the write's unit of work (mentions) */
  let noteAfterWrite: ((op: 'create' | 'update', row: RawRow, old: RawRow | null) => Promise<void>) | null = null
  function setNoteHooks(h: { afterWrite(op: 'create' | 'update', row: RawRow, old: RawRow | null): Promise<void> }): void {
    noteAfterWrite = (op, row, old) => h.afterWrite(op, row, old)
  }

  /* ---------------------------------------------------------------- write hooks (called by collab.ts) */

  /** Activities: Recurrence is validated and normalised, Body is sanitised and capped; returns the columns to set */
  function beforeActivityWrite(next: RawRow, has: (c: string) => boolean): RawRow {
    const set: RawRow = {}
    if (has('Recurrence')) {
      if (blank(next.Recurrence)) set.Recurrence = null
      else {
        try {
          set.Recurrence = JSON.stringify(parseRecurrence(next.Recurrence))
        } catch (e) {
          throw invalid(errText(e), 'Recurrence')
        }
        if (str(next.Type) && str(next.Type) !== 'Task') throw invalid('Only tasks can repeat.', 'Recurrence')
      }
    }
    if (has('Body') && !blank(next.Body)) {
      const raw = str(next.Body)
      if (raw.length > NOTE_BODY_MAX * 2) throw invalid(`A note body can hold at most ${NOTE_BODY_MAX.toLocaleString('en')} characters.`, 'Body')
      const clean = noteSanitizer(raw)
      if (clean.length > NOTE_BODY_MAX) throw invalid(`A note body can hold at most ${NOTE_BODY_MAX.toLocaleString('en')} characters.`, 'Body')
      set.Body = clean
    }
    return set
  }

  /**
   * After an activity was written (inside the write's unit of work): a task that has just become Done and repeats gets its
   * next occurrence, exactly once. Never throws for a rule that cannot continue (ended, invalid): the completion stands.
   */
  async function afterActivityWrite(op: 'create' | 'update', row: RawRow, old: RawRow | null): Promise<void> {
    if (str(row.Type) === 'Note' && noteAfterWrite) await noteAfterWrite(op, row, old)
    if (op !== 'update' || str(row.Status) !== 'Done' || str(old?.Status) === 'Done' || blank(row.Recurrence) || str(row.Type) !== 'Task') return
    const def = await activitiesDef()
    if (!def) return
    let rule
    try {
      rule = parseRecurrence(row.Recurrence)
    } catch (e) {
      deps.log('warn', `recurring task ${str(row.id)}: ${errText(e)}`)
      return
    }
    // exactly once: the occurrence this task already made (also one that was deleted or completed since) counts
    const made = await db().query<{ id: string }>(`SELECT "id" FROM ${S(SYS.activities)} WHERE "RecurrenceParent" = $1 LIMIT 1`, [str(row.id)])
    if (made.length) return
    const due = asDate(row.DueOn)
    const when = nextDue(rule, due, clock())
    if (!when) return // the rule ended (until)
    const remind = asDate(row.ReminderOn)
    const lead = due && remind ? due.getTime() - remind.getTime() : null
    const next: Record<string, string | number | boolean | null> = {
      Type: 'Task', Subject: str(row.Subject), Status: 'Open', Priority: str(row.Priority) || 'Normal', DueOn: when.toISOString(),
      ...(lead !== null && lead >= 0 ? { ReminderOn: new Date(when.getTime() - lead).toISOString() } : {}),
      Recurrence: str(row.Recurrence), RecurrenceParent: str(row.id),
      ...(blank(row.Description) ? {} : { Description: str(row.Description) }), ...(blank(row.Category) ? {} : { Category: str(row.Category) }),
      ...(blank(row.AssignedTo) ? {} : { AssignedTo: str(row.AssignedTo) }), ...(blank(row.AssignedTeam) ? {} : { AssignedTeam: str(row.AssignedTeam) }),
      ...(blank(row[REGARDING.id]) ? {} : { [REGARDING.table]: str(row[REGARDING.table]), [REGARDING.id]: str(row[REGARDING.id]) }),
      createdBy: blank(row.createdBy) ? null : str(row.createdBy), owner: blank(row.owner) ? (blank(row.createdBy) ? null : str(row.createdBy)) : str(row.owner),
    }
    await deps.data().insert(null, def, next)
  }

  /** a share row: who it is for must exist here; the activity's owner is never shared with themself */
  async function beforeShareWrite(op: 'create' | 'update', next: RawRow, changed: Set<string> | null): Promise<RawRow> {
    const set: RawRow = {}
    const has = (c: string) => op === 'create' || !!changed?.has(c)
    if (!(has('Activity') || has('PrincipalType') || has('Principal'))) return set
    const type = str(next.PrincipalType)
    const who = str(next.Principal).trim()
    if (type !== 'user' && type !== 'team') throw invalid('Share with a person (user) or a team.', 'PrincipalType')
    if (!who) throw invalid('Say who it is shared with.', 'Principal')
    if (type === 'user') {
      const u = await db().query<{ id: string }>(`SELECT "id" FROM ${S(SYS.users)} WHERE "id" = $1 AND "Status" = 'active' LIMIT 1`, [who])
      if (!u.length) throw invalid('That person is not an active user of this environment.', 'Principal')
    } else {
      const t = await db().query<{ id: string }>(`SELECT "id" FROM ${S(SYS.teams)} WHERE "id" = $1 LIMIT 1`, [who])
      if (!t.length) throw invalid('That team does not exist in this environment.', 'Principal')
    }
    const act = await db().query<{ owner: string | null }>(`SELECT "owner" FROM ${S(SYS.activities)} WHERE "id" = $1 LIMIT 1`, [str(next.Activity)])
    if (!act.length) throw invalid('That note or task does not exist.', 'Activity')
    if (type === 'user' && str(act[0].owner) === who) throw invalid('The owner already has it.', 'Principal')
    set.Principal = who
    return set
  }

  /** shares go with their activity; with a recycle bin the removed rows are handed over so a restore brings them back */
  async function afterActivityDelete(ids: string[], capture?: (e: { kind: 'collab' | 'detach'; tableId: string; rowId: string; old: unknown }) => void): Promise<number> {
    if (!ids.length || !(await tables()).some((t) => t.id === SYS.activityShares)) return 0
    const lower = ids.map((x) => (x.length === 36 ? x.toLowerCase() : x))
    if (!capture) return (await db().exec(`DELETE FROM ${S(SYS.activityShares)} WHERE "Activity" = ANY($1::text[])`, [lower])).affectedRows
    const rows = await db().query<{ id: string; j: unknown }>(`DELETE FROM ${S(SYS.activityShares)} AS x WHERE x."Activity" = ANY($1::text[]) RETURNING x."id", to_jsonb(x.*) AS j`, [lower])
    for (const r of rows) capture({ kind: 'collab', tableId: SYS.activityShares, rowId: String(r.id), old: r.j })
    return rows.length
  }

  /** shares of activities that no longer exist (deleted outside the API) */
  async function sweepShares(): Promise<number> {
    if (!(await tables()).some((t) => t.id === SYS.activityShares)) return 0
    return (await db().exec(`DELETE FROM ${S(SYS.activityShares)} s WHERE NOT EXISTS (SELECT 1 FROM ${S(SYS.activities)} a WHERE a."id" = s."Activity")`)).affectedRows
  }

  /* ---------------------------------------------------------------- reminders */

  /** the person's own time zone (notification settings), or '' when they never set one */
  const zoneOf = async (svc: NotificationService, userId: string): Promise<string> => {
    try {
      return (await svc.settings(userId)).timeZone || ''
    } catch {
      return ''
    }
  }

  function when(at: Date, tz: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
    } catch {
      return at.toISOString()
    }
  }

  /**
   * Sends every reminder that is due (ReminderOn <= now) and not yet sent, once. Safe to run twice, concurrently or after
   * a crash. `now` is injected by tests.
   */
  async function runReminders(o: { now?: Date } = {}): Promise<RunSummary> {
    if (installReadOnly()) return { skipped: 'The install is read-only: reminders wait until it can be written again.' }
    if (!deps.db()) return { skipped: 'no database' }
    const svc = deps.notifications()
    const def = await activitiesDef()
    if (!svc || !def) return { sent: 0 }
    const now = o.now ?? clock()
    const rows = await db().query<RawRow>(
      `SELECT "id", "Subject", "DueOn", "ReminderOn", "AssignedTo", "AssignedTeam", "owner", "createdBy", ${q(REGARDING.id)} AS "_re" FROM ${S(SYS.activities)}
        WHERE ${liveRowsSql(def)} AND "Type" <> 'Note' AND "Status" IN ('Open', 'In progress') AND "ReminderOn" IS NOT NULL
          AND "ReminderOn" <= $1 AND "ReminderOn" > $2 AND ("ReminderSentOn" IS NULL OR "ReminderSentOn" < "ReminderOn")
        ORDER BY "ReminderOn" LIMIT ${REMINDER_BATCH}`,
      [now, new Date(now.getTime() - REMINDER_WINDOW_MS)],
    )
    let sent = 0
    let failed = 0
    for (const r of rows) {
      const remindOn = asDate(r.ReminderOn)!
      let person = str(r.AssignedTo) || (str(r.AssignedTeam) ? '' : str(r.owner) || str(r.createdBy))
      // P3-13: the owner of an unassigned task about a record is told only while they may still read the task
      if (person && !str(r.AssignedTo) && !blank(r._re) && deps.canRead && !(await deps.canRead(def, str(r.id), person).catch(() => false))) person = ''
      const target = person ? { userIds: [person] } : str(r.AssignedTeam) ? { teamIds: [str(r.AssignedTeam)] } : null
      try {
        if (target) {
          const due = asDate(r.DueOn)
          const zone = (person ? await zoneOf(svc, person) : '') || (await settingValue('TimeZone')) || 'Asia/Kolkata'
          await svc.notify(target, {
            kind: 'task', title: `Reminder: ${richTextToPlain(str(r.Subject)).slice(0, 150)}`, ...(due ? { body: `Due ${when(due, zone)}` } : {}),
            link: '#u-tasks', environmentId: currentEnvironment().id, source: 'system', idempotencyKey: `task-reminder:${str(r.id)}:${remindOn.toISOString()}`,
          })
        }
        // stamped even when nobody could be notified (no one to tell): the reminder is spent; a changed ReminderOn re-arms it
        await db().exec(`UPDATE ${S(SYS.activities)} SET "ReminderSentOn" = $2 WHERE "id" = $1 AND "ReminderOn" = $3`, [str(r.id), now, remindOn])
        sent++
      } catch (e) {
        failed++
        deps.log('warn', `task reminder ${str(r.id)}: ${errText(e)}`)
      }
    }
    // a failure is retried by the job queue: the keys make the retry harmless
    if (failed && !sent) throw new Error(`${failed} task reminder(s) could not be sent`)
    return { sent, failed }
  }

  /* ---------------------------------------------------------------- overdue digest */

  async function settingValue(key: string): Promise<string | null> {
    if (!(await tables()).some((t) => t.id === SYS.settings)) return null
    const r = await db().query<{ v: string | null }>(`SELECT "Value" AS v FROM ${S(SYS.settings)} WHERE lower("Key") = lower($1) LIMIT 1`, [key])
    return r[0]?.v ?? null
  }

  /**
   * One notification per person and local day: tasks assigned to them (or theirs without an assignee) that are overdue or
   * due today. Runs hourly; each person is served from 08:00 in their own time zone (notification settings, else the
   * environment's TimeZone setting, else Asia/Kolkata). Team-assigned tasks are not listed (no single person owns them).
   */
  async function runDigest(o: { now?: Date } = {}): Promise<RunSummary> {
    if (installReadOnly()) return { skipped: 'The install is read-only: the task digest waits until it can be written again.' }
    if (!deps.db()) return { skipped: 'no database' }
    const svc = deps.notifications()
    const def = await activitiesDef()
    if (!svc || !def) return { sent: 0 }
    const now = o.now ?? clock()
    const envZone = (await settingValue('TimeZone')) || 'Asia/Kolkata'
    // everything due before the end of tomorrow UTC+14 covers "due today" in every zone
    const horizon = new Date(now.getTime() + 38 * 3600_000)
    const rows = await db().query<{ uid: string; id: string; Subject: string; DueOn: Date; Priority: string | null; _check: boolean }>(
      `SELECT COALESCE("AssignedTo", "owner") AS uid, "id", "Subject", "DueOn", "Priority", ("AssignedTo" IS NULL AND ${q(REGARDING.id)} IS NOT NULL) AS "_check" FROM ${S(SYS.activities)}
        WHERE ${liveRowsSql(def)} AND "Type" = 'Task' AND "Status" IN ('Open', 'In progress') AND "DueOn" IS NOT NULL AND "DueOn" < $1
          AND "AssignedTeam" IS NULL AND COALESCE("AssignedTo", "owner") IS NOT NULL ORDER BY "DueOn" LIMIT 20000`,
      [horizon],
    )
    const by = new Map<string, typeof rows>()
    for (const r of rows) (by.get(r.uid) ?? by.set(r.uid, []).get(r.uid)!).push(r)
    let sent = 0
    for (const [uid, all] of by) {
      const zone = (await zoneOf(svc, uid)) || envZone
      const today = civilIn(now, zone)
      if (today.hh < DIGEST_HOUR || today.hh >= DIGEST_LAST_HOUR) continue
      // P3-13: an unassigned task about a record reaches its owner only while they may still read it
      const list: typeof rows = []
      for (const t of all) if (!t._check || !deps.canRead || (await deps.canRead(def, t.id, uid).catch(() => false))) list.push(t)
      const dayKey = `${today.y}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`
      const todayN = today.y * 10000 + today.m * 100 + today.d
      const overdue: typeof rows = []
      const dueToday: typeof rows = []
      for (const t of list) {
        const c = civilIn(new Date(t.DueOn), zone)
        const n = c.y * 10000 + c.m * 100 + c.d
        if (n < todayN) overdue.push(t)
        else if (n === todayN) dueToday.push(t)
      }
      if (!overdue.length && !dueToday.length) continue
      const marker = `tasks.digest:${dayKey}:${uid}`
      if ((await db().query(`SELECT 1 FROM ${S('ab_counters')} WHERE k = $1`, [marker])).length) continue
      const parts = [overdue.length ? `${overdue.length} overdue` : '', dueToday.length ? `${dueToday.length} due today` : ''].filter(Boolean)
      const line = (t: (typeof rows)[number]) => `- ${richTextToPlain(str(t.Subject)).slice(0, 100)}`
      const shown = [...overdue, ...dueToday].slice(0, DIGEST_LINES)
      const rest = overdue.length + dueToday.length - shown.length
      try {
        await svc.notify({ userIds: [uid] }, {
          kind: 'task', title: `Tasks: ${parts.join(', ')}`, body: [...shown.map(line), ...(rest > 0 ? [`and ${rest} more`] : [])].join('\n'),
          link: '#u-tasks', environmentId: currentEnvironment().id, source: 'system', idempotencyKey: `task-digest:${currentEnvironment().id}:${dayKey}:${uid}`,
        })
        await db().exec(`INSERT INTO ${S('ab_counters')} (k, v) VALUES ($1, 1) ON CONFLICT (k) DO NOTHING`, [marker])
        sent++
      } catch (e) {
        deps.log('warn', `task digest for ${uid}: ${errText(e)}`)
      }
    }
    // markers of earlier days are not needed again (the key sorts by date)
    const cutoff = civilIn(new Date(now.getTime() - 3 * 86_400_000), envZone)
    await db().exec(`DELETE FROM ${S('ab_counters')} WHERE k LIKE 'tasks.digest:%' AND k < $1`, [`tasks.digest:${cutoff.y}-${String(cutoff.m).padStart(2, '0')}-${String(cutoff.d).padStart(2, '0')}`])
    return { sent, people: by.size }
  }

  /* ---------------------------------------------------------------- registration */

  function registerJobs(kernel: { jobs: { register<P>(def: JobTypeDef<P>): void } }): void {
    kernel.jobs.register<Record<string, never>>({
      type: TASK_REMINDERS_JOB,
      description: 'Sends each task reminder that has come due once, as a notification (in the app and the person\'s chosen channels).',
      concurrency: 1, maxAttempts: 3, timeoutMs: 5 * 60_000, parse: () => ({}),
      handler: () => runReminders(),
    })
    kernel.jobs.register<Record<string, never>>({
      type: TASK_DIGEST_JOB,
      description: 'Once a day for each person, from 08:00 their time: a notification with their overdue tasks and the ones due today.',
      concurrency: 1, maxAttempts: 3, timeoutMs: 10 * 60_000, parse: () => ({}),
      handler: () => runDigest(),
    })
    if (!BUILTIN_SCHEDULES.some((x) => x.id === 'sched_task_reminders')) {
      BUILTIN_SCHEDULES.push(
        { id: 'sched_task_reminders', name: 'Task reminders', description: 'Every minute: notifies people of task reminders that have come due (once each).', cron: '* * * * *', jobType: TASK_REMINDERS_JOB, payload: {}, enabled: true },
        { id: 'sched_task_digest', name: 'Overdue task digest', description: 'Every hour: sends each person, once a day from 08:00 their time, their overdue and due-today tasks.', cron: '11 * * * *', jobType: TASK_DIGEST_JOB, payload: {}, enabled: true },
      )
    }
  }

  return { runReminders, runDigest, beforeActivityWrite, afterActivityWrite, beforeShareWrite, afterActivityDelete, sweepShares, setNoteSanitizer, setNoteHooks, registerJobs, installReadOnly }
}

