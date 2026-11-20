/**
 * Tasks (P3 package T) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): reminders fire once (also when the stamp is
 * lost, as after a crash), a read-only install skips the jobs cleanly, the overdue digest (content, once a day, local
 * time), recurring tasks exactly once under a double completion, note bodies sanitised, and shares visible to the right
 * people only over HTTP. Time-driven behaviour uses an injected `now`, never sleeping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness } from '../kernel-testkit.ts'
import type { KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { SYS } from '../../../src/platform/system-tables.ts'
import { BUILTIN_SCHEDULES } from '../kernel.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[tasks integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
/* eslint-disable @typescript-eslint/no-explicit-any */

describe.skipIf(!PG_URL)(PG_URL ? 'tasks (PostgreSQL)' : `tasks (PostgreSQL) ${SKIP_PG}`, () => {
  let h: KernelHarness
  const env: NodeJS.ProcessEnv = {}
  const c: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  const tasks = () => h.app.services.tasks
  const iso = (d: Date) => d.toISOString()
  const notes = (user: string, like = '%') => h.q<{ id: string; title: string; body: string; kind: string }>(`SELECT id, title, body, kind FROM ab.notifications WHERE user_id = $1 AND title LIKE $2 ORDER BY created_on`, [ids[user], like])
  const create = async (cl: Client, values: Record<string, unknown>) => {
    const r = await cl.post('/data/Activities/rows', { values })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data.row as Record<string, any>
  }
  const readable = async (cl: Client, id: string) => {
    const r = await cl.post('/query', { plan: { version: 2, table: 'Activities', filter: { col: 'id', op: 'eq', value: id } } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return (r.data.rows as unknown[]).length === 1
  }

  beforeAll(async () => {
    h = await startHarness('tasks', { env })
    await runInEnvironment('default', async () => {
      for (const [k, name] of [['bo', 'Bo Brown'], ['cy', 'Cy Clark'], ['di', 'Di Diaz']] as const) {
        ids[k] = `user_${k}`
        await h.app.services.meta.users.insert({ id: ids[k], name, email: `${k}@example.com`, roleIds: [], status: 'active', passwordHash: await hashPassword(PW) } as UserRecord)
      }
    })
    for (const k of ['bo', 'cy', 'di']) await h.q(`INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ('default', $1, false, now()) ON CONFLICT DO NOTHING`, [ids[k]])
    h.app.services.security.invalidate('all')
    for (const k of ['bo', 'cy', 'di']) {
      c[k] = new Client(h.base)
      const r = await c[k].post('/auth/login', { email: `${k}@example.com`, password: PW })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
    }
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('the two jobs are registered with built-in schedules (every minute, hourly)', async () => {
    const reminders = BUILTIN_SCHEDULES.find((s) => s.id === 'sched_task_reminders')
    expect(reminders).toMatchObject({ jobType: 'tasks.reminders', cron: '* * * * *', enabled: true })
    expect(BUILTIN_SCHEDULES.find((s) => s.id === 'sched_task_digest')).toMatchObject({ jobType: 'tasks.digest', enabled: true })
  })

  describe('reminders', () => {
    const now = new Date()
    it('a reminder that has come due is sent once, to the assignee, and stamped; a future one waits', async () => {
      const due = await create(c.bo, { Subject: 'Pay the transporter', Type: 'Task', AssignedTo: ids.cy, DueOn: iso(new Date(now.getTime() + 3600_000)), ReminderOn: iso(new Date(now.getTime() - 5 * 60_000)) })
      const later = await create(c.bo, { Subject: 'Check the dock', Type: 'Task', AssignedTo: ids.cy, ReminderOn: iso(new Date(now.getTime() + 2 * 3600_000)) })
      ids.due = due.id
      ids.later = later.id
      const first = await tasks().runReminders({ now })
      expect(first.sent).toBe(1)
      const got = await notes('cy', 'Reminder:%')
      expect(got.map((n) => n.title)).toEqual(['Reminder: Pay the transporter'])
      expect(got[0].kind).toBe('task')
      expect(got[0].body).toMatch(/^Due /)
      const stamped = await h.q<{ ReminderSentOn: Date | null }>(`SELECT "ReminderSentOn" FROM env_default.sys_activities WHERE id = $1`, [ids.due])
      expect(stamped[0].ReminderSentOn).not.toBeNull()
      // the person who made it (Bo) got nothing; the future reminder is untouched
      expect((await notes('bo', 'Reminder:%')).length).toBe(0)
      expect((await h.q<any>(`SELECT "ReminderSentOn" FROM env_default.sys_activities WHERE id = $1`, [ids.later]))[0].ReminderSentOn).toBeNull()
    })

    it('running again, or running twice at once, sends nothing more', async () => {
      expect((await tasks().runReminders({ now })).sent).toBe(0)
      await Promise.all([tasks().runReminders({ now }), tasks().runReminders({ now })])
      expect((await notes('cy', 'Reminder:%')).length).toBe(1)
    })

    it('survives a crash between the notification and the stamp: the idempotency key stops a second notification', async () => {
      await h.q(`UPDATE env_default.sys_activities SET "ReminderSentOn" = NULL WHERE id = $1`, [ids.due])
      const again = await tasks().runReminders({ now })
      expect(again.sent).toBe(1) // handled again (and stamped), but not delivered twice
      expect((await notes('cy', 'Reminder:%')).length).toBe(1)
      expect((await h.q<any>(`SELECT "ReminderSentOn" FROM env_default.sys_activities WHERE id = $1`, [ids.due]))[0].ReminderSentOn).not.toBeNull()
    })

    it('the later reminder fires when its time comes (an injected clock, no sleeping)', async () => {
      const r = await tasks().runReminders({ now: new Date(now.getTime() + 3 * 3600_000) })
      expect(r.sent).toBe(1)
      expect((await notes('cy', 'Reminder: Check the dock')).length).toBe(1)
    })

    it('moving a sent reminder to a later time arms it again', async () => {
      const p = await c.bo.patch(`/data/Activities/rows/${ids.due}`, { changes: { ReminderOn: iso(new Date(now.getTime() + 4 * 3600_000)) } })
      expect(p.status, JSON.stringify(p.data)).toBe(200)
      expect((await tasks().runReminders({ now: new Date(now.getTime() + 3 * 3600_000) })).sent).toBe(0)
      expect((await tasks().runReminders({ now: new Date(now.getTime() + 5 * 3600_000) })).sent).toBe(1)
      expect((await notes('cy', 'Reminder: Pay the transporter')).length).toBe(2)
    })

    it('done, cancelled and very old reminders are not sent', async () => {
      const n = new Date(now.getTime() + 10 * 86_400_000)
      const done = await create(c.bo, { Subject: 'Already done', Type: 'Task', AssignedTo: ids.cy, Status: 'Done', ReminderOn: iso(new Date(n.getTime() - 60_000)) })
      const old = await create(c.bo, { Subject: 'Ancient reminder', Type: 'Task', AssignedTo: ids.cy, ReminderOn: iso(new Date(n.getTime() - 8 * 86_400_000)) })
      const r = await tasks().runReminders({ now: n })
      expect(r.sent).toBe(0)
      expect((await notes('cy', 'Reminder: Already done')).length).toBe(0)
      expect((await notes('cy', 'Reminder: Ancient%')).length).toBe(0)
      void done
      void old
    })

    it('an unassigned personal task reminds its owner', async () => {
      const mine = await create(c.di, { Subject: 'Renew the licence', Type: 'Task', ReminderOn: iso(new Date(now.getTime() - 60_000)) })
      expect((await tasks().runReminders({ now })).sent).toBeGreaterThanOrEqual(1)
      expect((await notes('di', 'Reminder: Renew%')).length).toBe(1)
      void mine
    })

    it('a read-only install skips the run cleanly (no write, no error); it goes out when writable again', async () => {
      const t = await create(c.bo, { Subject: 'Read-only test', Type: 'Task', AssignedTo: ids.cy, ReminderOn: iso(new Date(now.getTime() - 60_000)) })
      env.APPBUILDER_READ_ONLY = '1'
      try {
        const r = await tasks().runReminders({ now })
        expect(r).toMatchObject({ skipped: expect.stringMatching(/read-only/) })
        expect((await tasks().runDigest({ now })).skipped).toMatch(/read-only/)
        expect((await h.q<any>(`SELECT "ReminderSentOn" FROM env_default.sys_activities WHERE id = $1`, [t.id]))[0].ReminderSentOn).toBeNull()
      } finally {
        delete env.APPBUILDER_READ_ONLY
      }
      expect((await tasks().runReminders({ now })).sent).toBe(1)
      expect((await notes('cy', 'Reminder: Read-only test')).length).toBe(1)
    })
  })

  describe('overdue digest', () => {
    // 20 Nov 2026 09:30 in Kolkata
    const NOW = new Date('2026-11-20T04:00:00Z')
    it('lists what is overdue and due today, once a day, from 08:00 local time', async () => {
      for (const [subject, due, extra] of [
        ['Overdue one', '2026-11-18T05:00:00Z', {}], ['Overdue two', '2026-11-19T05:00:00Z', {}], ['Due today', '2026-11-20T12:00:00Z', {}],
        ['Due tomorrow', '2026-11-21T05:00:00Z', {}], ['Finished', '2026-11-18T05:00:00Z', { Status: 'Done' }], ['No date', null, {}],
      ] as const) await create(c.bo, { Subject: subject, Type: 'Task', AssignedTo: ids.bo, ...(due ? { DueOn: due } : {}), ...extra })
      // before 08:00 in Kolkata (06:30): nothing
      expect((await tasks().runDigest({ now: new Date('2026-11-20T01:00:00Z') })).sent).toBe(0)
      expect((await notes('bo', 'Tasks:%')).length).toBe(0)
      const r = await tasks().runDigest({ now: NOW })
      expect(r.sent).toBeGreaterThanOrEqual(1)
      const got = await notes('bo', 'Tasks:%')
      expect(got.length).toBe(1)
      expect(got[0].title).toBe('Tasks: 2 overdue, 1 due today')
      expect(got[0].kind).toBe('task')
      expect(got[0].body.split('\n')).toEqual(['- Overdue one', '- Overdue two', '- Due today'])
      // not for someone with nothing due
      expect((await notes('di', 'Tasks:%')).length).toBe(0)
    })

    it('is not repeated the same day (also after the person deleted it) and comes again the next day', async () => {
      expect((await tasks().runDigest({ now: new Date('2026-11-20T05:00:00Z') })).sent).toBe(0)
      await h.q(`DELETE FROM ab.notifications WHERE user_id = $1 AND title LIKE 'Tasks:%'`, [ids.bo])
      expect((await tasks().runDigest({ now: new Date('2026-11-20T06:00:00Z') })).sent).toBe(0)
      expect((await notes('bo', 'Tasks:%')).length).toBe(0)
      const next = await tasks().runDigest({ now: new Date('2026-11-21T04:00:00Z') })
      expect(next.sent).toBeGreaterThanOrEqual(1)
      expect((await notes('bo', 'Tasks:%'))[0].title).toBe('Tasks: 3 overdue, 1 due today')
    })

    it('a person in another time zone is served at their 08:00', async () => {
      await h.app.services.notifications!.saveSettings(ids.di, { timeZone: 'America/New_York' })
      await create(c.di, { Subject: 'Overdue in New York', Type: 'Task', DueOn: '2026-11-18T05:00:00Z' })
      // 04:00 UTC = 23:00 the evening before in New York (after the window): nothing for Di yet; 13:30 UTC = 08:30 there
      await tasks().runDigest({ now: new Date('2026-11-22T04:00:00Z') })
      expect((await notes('di', 'Tasks:%')).length).toBe(0)
      await tasks().runDigest({ now: new Date('2026-11-22T13:30:00Z') })
      const di = await notes('di', 'Tasks:%')
      expect(di.map((n) => n.title)).toEqual(['Tasks: 1 overdue'])
    })
  })

  describe('recurring tasks', () => {
    it('completing a repeating task creates the next occurrence in the same write, exactly once even for a double completion', async () => {
      const rule = { frequency: 'daily', interval: 1, time: '09:00', timeZone: 'Asia/Kolkata' }
      const t = await create(c.bo, { Subject: 'Daily check', Type: 'Task', AssignedTo: ids.bo, DueOn: iso(new Date(Date.now() + 3600_000)), ReminderOn: iso(new Date(Date.now() + 1800_000)), Priority: 'High', Description: '<p>Walk the line</p>', Recurrence: JSON.stringify(rule) })
      const stored = JSON.parse(String((await h.q<any>(`SELECT "Recurrence" FROM env_default.sys_activities WHERE id = $1`, [t.id]))[0].Recurrence))
      expect(stored).toMatchObject(rule)
      const both = await Promise.all([c.bo.patch(`/data/Activities/rows/${t.id}`, { changes: { Status: 'Done' } }), c.bo.patch(`/data/Activities/rows/${t.id}`, { changes: { Status: 'Done' } })])
      expect(both.some((r) => r.status === 200)).toBe(true)
      const kids = await h.q<any>(`SELECT * FROM env_default.sys_activities WHERE "RecurrenceParent" = $1`, [t.id])
      expect(kids.length).toBe(1)
      expect(kids[0]).toMatchObject({ Subject: 'Daily check', Type: 'Task', Status: 'Open', Priority: 'High', AssignedTo: ids.bo, createdBy: ids.bo, owner: ids.bo, Description: '<p>Walk the line</p>' })
      expect(new Date(kids[0].DueOn).getTime()).toBeGreaterThan(Date.now())
      // the reminder keeps its lead time (30 minutes before the due time)
      expect(new Date(kids[0].DueOn).getTime() - new Date(kids[0].ReminderOn).getTime()).toBe(1800_000)
      expect(String(kids[0].Recurrence)).toContain('"daily"')
      // reopened and completed again: still one
      await c.bo.patch(`/data/Activities/rows/${t.id}`, { changes: { Status: 'Open' } })
      await c.bo.patch(`/data/Activities/rows/${t.id}`, { changes: { Status: 'Done' } })
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activities WHERE "RecurrenceParent" = $1`, [t.id])).length).toBe(1)
      // the chain goes on: completing the new occurrence makes the next
      await c.bo.patch(`/data/Activities/rows/${kids[0].id}`, { changes: { Status: 'Done' } })
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activities WHERE "RecurrenceParent" = $1`, [kids[0].id])).length).toBe(1)
    })

    it('the unique index is the last line of defence: a second occurrence of one task cannot be written', async () => {
      const t = await create(c.bo, { Subject: 'Weekly', Type: 'Task', AssignedTo: ids.bo, Recurrence: JSON.stringify({ frequency: 'weekly', weekdays: [1], time: '08:00', timeZone: 'UTC' }) })
      await c.bo.patch(`/data/Activities/rows/${t.id}`, { changes: { Status: 'Done' } })
      await expect(h.q(`INSERT INTO env_default.sys_activities (id, "createdOn", "modifiedOn", "Type", "Subject", "RecurrenceParent") VALUES (gen_random_uuid()::text, now(), now(), 'Task', 'dup', $1)`, [t.id])).rejects.toThrow(/unique|duplicate/i)
    })

    it('a rule that has ended, or a task that does not repeat, creates nothing; a bad rule is refused', async () => {
      const ended = await create(c.bo, { Subject: 'Ends', Type: 'Task', AssignedTo: ids.bo, DueOn: iso(new Date(Date.now() + 3600_000)), Recurrence: JSON.stringify({ frequency: 'daily', until: '2020-01-01' }) })
      await c.bo.patch(`/data/Activities/rows/${ended.id}`, { changes: { Status: 'Done' } })
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activities WHERE "RecurrenceParent" = $1`, [ended.id])).length).toBe(0)
      const plain = await create(c.bo, { Subject: 'Once', Type: 'Task', AssignedTo: ids.bo })
      await c.bo.patch(`/data/Activities/rows/${plain.id}`, { changes: { Status: 'Done' } })
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activities WHERE "RecurrenceParent" = $1`, [plain.id])).length).toBe(0)
      const bad = await c.bo.post('/data/Activities/rows', { values: { Subject: 'Bad', Type: 'Task', Recurrence: JSON.stringify({ frequency: 'hourly' }) } })
      expect(bad.status).toBe(422)
      expect(JSON.stringify(bad.data)).toMatch(/day, week or month/)
      const call = await c.bo.post('/data/Activities/rows', { values: { Subject: 'A call', Type: 'Call', Recurrence: JSON.stringify({ frequency: 'daily' }) } })
      expect(call.status).toBe(422)
    })
  })

  describe('notes and shares over HTTP', () => {
    it('a note body is sanitised and capped', async () => {
      const n = await create(c.bo, { Subject: 'Plant visit', Type: 'Note', Body: '<p>Hello <b>team</b></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>' })
      ids.note = n.id
      const body = String((await h.q<any>(`SELECT "Body" FROM env_default.sys_activities WHERE id = $1`, [n.id]))[0].Body)
      expect(body).toContain('<p>Hello <b>team</b></p>')
      expect(body).not.toMatch(/script|onerror|<img|javascript:/i)
      const big = await c.bo.post('/data/Activities/rows', { values: { Subject: 'Huge', Type: 'Note', Body: '<p>' + 'x'.repeat(450_000) + '</p>' } })
      expect(big.status).toBe(422)
    })

    it('a note is private to its owner until the owner shares it; then only with the people it is shared with', async () => {
      expect(await readable(c.bo, ids.note)).toBe(true)
      expect(await readable(c.cy, ids.note)).toBe(false)
      expect(await readable(c.di, ids.note)).toBe(false)
      // Cy cannot share Bo's note (not readable: refused), nor can Di
      const denied = await c.cy.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.cy, Access: 'read' } })
      expect([403, 404, 422]).toContain(denied.status)
      expect(await readable(c.cy, ids.note)).toBe(false)
      // Bo shares it with Cy (read)
      const share = await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.cy, Access: 'read' } })
      expect(share.status, JSON.stringify(share.data)).toBe(200)
      ids.share = share.data.row.id
      expect(await readable(c.cy, ids.note)).toBe(true)
      expect(await readable(c.di, ids.note)).toBe(false)
      // Cy sees the share rows of that note, Di sees none
      const seen = await c.cy.post('/query', { plan: { version: 2, table: 'ActivityShares' } })
      expect((seen.data.rows as any[]).map((r) => r.id)).toEqual([ids.share])
      expect(((await c.di.post('/query', { plan: { version: 2, table: 'ActivityShares' } })).data.rows as any[]).length).toBe(0)
      // a read share cannot change the note; Cy cannot pass it on or remove the share
      expect((await c.cy.patch(`/data/Activities/rows/${ids.note}`, { changes: { Subject: 'Hijacked' } })).status).toBeGreaterThanOrEqual(403)
      const pass = await c.cy.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.di, Access: 'read' } })
      expect([403, 404]).toContain(pass.status)
      expect(await readable(c.di, ids.note)).toBe(false)
      expect([403, 404]).toContain((await c.cy.post('/data/ActivityShares/delete', { ids: [ids.share] })).status)
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activity_shares WHERE id = $1`, [ids.share])).length).toBe(1)
      // an edit share lets Cy change it
      expect((await c.bo.patch(`/data/ActivityShares/rows/${ids.share}`, { changes: { Access: 'edit' } })).status).toBe(200)
      const edited = await c.cy.patch(`/data/Activities/rows/${ids.note}`, { changes: { Subject: 'Plant visit (Cy added)' } })
      expect(edited.status, JSON.stringify(edited.data)).toBe(200)
      // comments on the shared note follow it
      const cm = await c.cy.post('/data/Comments/rows', { values: { Body: 'Seen it', regardingTable: SYS.activities, regardingId: ids.note } })
      expect(cm.status, JSON.stringify(cm.data)).toBe(200)
      const bo = await c.bo.post('/query', { plan: { version: 2, table: 'Comments', filter: { col: 'regardingId', op: 'eq', value: ids.note } } })
      expect((bo.data.rows as any[]).length).toBe(1)
      expect(((await c.di.post('/query', { plan: { version: 2, table: 'Comments', filter: { col: 'regardingId', op: 'eq', value: ids.note } } })).data.rows as any[]).length).toBe(0)
    })

    it('a share needs a real person or team, and one share per person', async () => {
      const ghost = await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: 'user_nobody', Access: 'read' } })
      expect(ghost.status).toBe(422)
      const self = await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.bo, Access: 'read' } })
      expect(self.status).toBe(422)
      const team = await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'team', Principal: 'team_nobody', Access: 'read' } })
      expect(team.status).toBe(422)
      const twice = await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.cy, Access: 'read' } })
      expect(twice.status).toBeGreaterThanOrEqual(400)
    })

    it('shares go when the note is deleted, and an environment administrator keeps full access as for every collaboration table', async () => {
      expect((await h.admin.post('/query', { plan: { version: 2, table: 'ActivityShares' } })).data.rows.length).toBeGreaterThan(0)
      const gone = await c.bo.post('/data/Activities/delete', { ids: [ids.note] })
      expect(gone.status, JSON.stringify(gone.data)).toBe(200)
      expect((await h.q<any>(`SELECT id FROM env_default.sys_activity_shares WHERE "Activity" = $1`, [ids.note])).length).toBe(0)
      expect(await readable(c.cy, ids.note)).toBe(false)
    })
  })
})
