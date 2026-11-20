/**
 * Notes (P3 package N) against the sandbox PostgreSQL (APPBUILDER_TEST_DB), over HTTP as real users:
 *  - hostile HTML sent straight to the data API is stored sanitised (NOTE_TAGS);
 *  - the sharing predicate: private by default; a read share reads and cannot change; an edit share changes but cannot
 *    share or delete; a team share reaches the team's members and stops at once when someone leaves the team; a note
 *    about a record is read by the record's readers (and on its timeline), not by others; a bystander gets nothing from
 *    the list, the search, the direct address or the query API, and the response bytes do not contain the note;
 *  - mentions: a person who cannot read the note cannot be mentioned (422); once shared, the mention creates a Mentions
 *    row and a notification that links to the note;
 *  - two saves from the same version: the second answers 409 with the saved version (no silent overwrite);
 *  - record cards resolve per reader; pins are per person.
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

setQuiet(true)
if (!PG_URL) process.stderr.write(`[notes integration] ${SKIP_PG}\n`)

const PW = 'member-password-1'
/* eslint-disable @typescript-eslint/no-explicit-any */

describe.skipIf(!PG_URL)(PG_URL ? 'notes (PostgreSQL)' : `notes (PostgreSQL) ${SKIP_PG}`, () => {
  let h: KernelHarness
  const c: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  const SECRET = 'Zanzibarquokka'
  const ok = (r: { status: number; data: any }) => {
    expect(r.status, JSON.stringify(r.data).slice(0, 400)).toBe(200)
    return r.data
  }
  const list = async (cl: Client, qs = '') => ok(await cl.get(`/notes${qs}`)).items as any[]
  const readable = async (cl: Client, id: string) => ((await cl.post('/query', { plan: { version: 2, table: 'Activities', filter: { col: 'id', op: 'eq', value: id } } })).data.rows as unknown[]).length === 1
  const notifications = (user: string) => h.q<{ title: string; link: string }>(`SELECT title, link FROM ab.notifications WHERE user_id = $1 ORDER BY created_on`, [ids[user]])
  const drain = async () => { await (h.app.services.kernel as any).drain?.({ timeoutMs: 20_000 }) }

  beforeAll(async () => {
    h = await startHarness('notes')
    const t = ok(await h.admin.post('/tables', { displayName: 'Orders', columns: [{ displayName: 'Title', type: 'text' }] }))
    ids.orders = t.id
    const readers = ok(await h.admin.post('/roles', { name: 'Order readers', apps: 'all', privileges: [{ table: t.id, create: true, read: 'all', update: 'all', delete: 'none' }] }))
    await runInEnvironment('default', async () => {
      for (const [k, name, roles] of [['bo', 'Bo Brown', [readers.id]], ['cy', 'Cy Clark', []], ['di', 'Di Diaz', []], ['ed', 'Ed Evans', [readers.id]]] as const) {
        ids[k] = `user_${k}`
        await h.app.services.meta.users.insert({ id: ids[k], name, email: `${k}@example.com`, roleIds: [...roles], status: 'active', passwordHash: await hashPassword(PW) } as UserRecord)
      }
    })
    for (const k of ['bo', 'cy', 'di', 'ed']) await h.q(`INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ('default', $1, false, now()) ON CONFLICT DO NOTHING`, [ids[k]])
    h.app.services.security.invalidate('all')
    for (const k of ['bo', 'cy', 'di', 'ed']) {
      c[k] = new Client(h.base)
      ok(await c[k].post('/auth/login', { email: `${k}@example.com`, password: PW }))
    }
    ids.order = ok(await c.bo.post(`/data/${ids.orders}/rows`, { values: { Title: 'Order for Pune' } })).row.id
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('hostile HTML sent to the data API is stored sanitised', async () => {
    const hostile = `<h2 onclick="x">Visit</h2><p>${SECRET} <b>bold</b><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">j</a><a href="https://ok.example/">ok</a></p>`
      + '<svg onload=alert(1)><text>svg</text></svg><iframe src="https://evil.example"></iframe><table><tr><td>a<table><tr><td>b</td></tr></table></td></tr></table>'
      + '<span data-record="tbl_x:1">leaked name</span><p style="color:red">s</p><img data-att="att_x" onerror="y">'
    const n = ok(await c.bo.post('/data/Activities/rows', { values: { Type: 'Note', Subject: `Plant ${SECRET}`, Body: hostile } })).row
    ids.note = n.id
    const stored = String((await h.q<any>(`SELECT "Body" FROM env_default.sys_activities WHERE id = $1`, [n.id]))[0].Body)
    expect(stored).toBe(`<h2>Visit</h2><p>${SECRET} <b>bold</b><a>j</a><a href="https://ok.example/" rel="noopener noreferrer" target="_blank">ok</a></p><table><tr><td>ab</td></tr></table><span data-record="tbl_x:1"></span><p>s</p><img data-att="att_x">`)
    // and through a PATCH too
    ok(await c.bo.patch(`/data/Activities/rows/${n.id}`, { changes: { Body: `<p>${SECRET}</p><p onmouseover=alert(1)>x</p><style>*{}</style>` } }))
    expect(String((await h.q<any>(`SELECT "Body" FROM env_default.sys_activities WHERE id = $1`, [n.id]))[0].Body)).toBe(`<p>${SECRET}</p><p>x</p>`)
  })

  it('a note is private: a bystander gets nothing from the list, search, direct address or the query API', async () => {
    expect((await list(c.bo)).map((x) => x.id)).toContain(ids.note)
    for (const k of ['cy', 'di']) {
      const all = await c[k].get('/notes')
      const found = await c[k].get(`/notes?q=${SECRET}`)
      const one = await c[k].get(`/notes/${ids.note}`)
      const cards = await c[k].post(`/notes/${ids.note}/cards`, {})
      expect(all.status).toBe(200)
      expect(all.data.items).toEqual([])
      expect(found.data.items).toEqual([])
      expect(one.status).toBe(404)
      expect(cards.status).toBe(404)
      expect(await readable(c[k], ids.note)).toBe(false)
      for (const r of [all, found, one, cards]) expect(JSON.stringify(r.data)).not.toContain(SECRET)
    }
    // the list never carries the body; search finds it by a word of the body
    const mine = await list(c.bo, `?q=${SECRET.toLowerCase()}`)
    expect(mine.map((x) => x.id)).toEqual([ids.note])
    expect(mine[0]).not.toHaveProperty('Body')
    expect(mine[0].snippet).toContain(SECRET)
  })

  it('mentioning someone who cannot read the note is refused; after sharing, the mention notifies them with a link', async () => {
    const before = (await h.q<any>(`SELECT "modifiedOn" FROM env_default.sys_activities WHERE id = $1`, [ids.note]))[0]
    const refused = await c.bo.patch(`/data/Activities/rows/${ids.note}`, { changes: { Body: `<p>${SECRET} <span data-mention="${ids.cy}">@Cy Clark</span></p>` } })
    expect(refused.status).toBe(422)
    expect(refused.data.error.message).toMatch(/Cy Clark cannot open this note/)
    // nothing was written: the refusal rolled the whole save back
    expect((await h.q<any>(`SELECT "modifiedOn" FROM env_default.sys_activities WHERE id = $1`, [ids.note]))[0].modifiedOn.getTime()).toBe(before.modifiedOn.getTime())
    const readers = ok(await c.bo.post(`/notes/${ids.note}/readers`, { userIds: [ids.cy, ids.bo] }))
    expect(readers).toEqual({ readers: [ids.bo], notReaders: [ids.cy] })
    ids.shareCy = ok(await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.cy, Access: 'read' } })).row.id
    ok(await c.bo.patch(`/data/Activities/rows/${ids.note}`, { changes: { Body: `<p>${SECRET} <span data-mention="${ids.cy}">@Cy Clark</span></p>` } }))
    const m = await h.q<any>(`SELECT "MentionedUser", "regardingTable", "regardingId" FROM env_default.sys_mentions WHERE "regardingId" = $1`, [ids.note])
    expect(m).toEqual([{ MentionedUser: ids.cy, regardingTable: SYS.activities, regardingId: ids.note }])
    await drain()
    let got: { title: string; link: string }[] = []
    for (let i = 0; i < 50 && !got.length; i++) {
      got = (await notifications('cy')).filter((n) => n.title.includes('mentioned you in the note'))
      if (!got.length) await new Promise((r) => setTimeout(r, 200))
    }
    expect(got).toHaveLength(1)
    expect(got[0].link).toBe(`#u-notes?n=${encodeURIComponent(ids.note)}`)
    // the mentioned person can open it; a second save without a new mention notifies nobody again
    expect(ok(await c.cy.get(`/notes/${ids.note}`)).note.Body).toContain(SECRET)
    ok(await c.bo.patch(`/data/Activities/rows/${ids.note}`, { changes: { Body: `<p>${SECRET} <span data-mention="${ids.cy}">@Cy Clark</span> again</p>` } }))
    await drain()
    expect((await h.q<any>(`SELECT 1 FROM env_default.sys_mentions WHERE "regardingId" = $1`, [ids.note])).length).toBe(1)
  })

  it('read share: reads, cannot change, share on or delete; edit share: changes, cannot share or delete', async () => {
    const view = ok(await c.cy.get(`/notes/${ids.note}`))
    expect(view).toMatchObject({ canEdit: false, isOwner: false })
    expect((await list(c.cy, '?view=shared')).map((x) => x.id)).toEqual([ids.note])
    expect((await c.cy.patch(`/data/Activities/rows/${ids.note}`, { changes: { Subject: 'Hijacked' } })).status).toBeGreaterThanOrEqual(403)
    expect([403, 404]).toContain((await c.cy.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.di, Access: 'read' } })).status)
    expect((await c.cy.post('/data/Activities/delete', { ids: [ids.note] })).status).toBeGreaterThanOrEqual(403)
    // Ed gets edit
    ok(await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.ed, Access: 'edit' } }))
    expect(ok(await c.ed.get(`/notes/${ids.note}`))).toMatchObject({ canEdit: true, isOwner: false })
    ok(await c.ed.patch(`/data/Activities/rows/${ids.note}`, { changes: { Subject: `Plant ${SECRET} (Ed)` } }))
    expect([403, 404]).toContain((await c.ed.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'user', Principal: ids.di, Access: 'read' } })).status)
    expect((await c.ed.post('/data/Activities/delete', { ids: [ids.note] })).status).toBeGreaterThanOrEqual(403)
    expect(await readable(c.di, ids.note)).toBe(false)
  })

  it('two saves from the same version: the second gets 409 with the saved text (no silent overwrite)', async () => {
    const v = ok(await c.bo.get(`/notes/${ids.note}`)).version
    ok(await c.ed.patch(`/data/Activities/rows/${ids.note}`, { changes: { Body: `<p>${SECRET} from Ed's tab</p>` }, ifModifiedOn: v }))
    const second = await c.bo.patch(`/data/Activities/rows/${ids.note}`, { changes: { Body: `<p>${SECRET} from Bo's tab</p>` }, ifModifiedOn: v })
    expect(second.status).toBe(409)
    expect(second.data.current.Body).toBe(`<p>${SECRET} from Ed's tab</p>`)
    expect(String((await h.q<any>(`SELECT "Body" FROM env_default.sys_activities WHERE id = $1`, [ids.note]))[0].Body)).toBe(`<p>${SECRET} from Ed's tab</p>`)
  })

  it('a team share reaches the members; leaving the team ends it at once', async () => {
    const team = ok(await h.admin.post('/teams', { name: 'Quality', code: 'quality', memberIds: [ids.di], environmentId: 'default' }))
    ids.team = team.id
    h.app.services.security.invalidate('all')
    ok(await c.bo.post('/data/ActivityShares/rows', { values: { Activity: ids.note, PrincipalType: 'team', Principal: team.id, Access: 'read' } }))
    expect(await readable(c.di, ids.note)).toBe(true)
    expect((await list(c.di, '?view=shared')).map((x) => x.id)).toEqual([ids.note])
    expect(ok(await c.bo.get(`/notes/${ids.note}`)).shares.find((s: any) => s.PrincipalType === 'team')?.name).toBe('Quality')
    ok(await h.admin.patch(`/teams/${team.id}`, { memberIds: [] }))
    h.app.services.security.invalidate('all')
    expect(await readable(c.di, ids.note)).toBe(false)
    expect((await c.di.get(`/notes/${ids.note}`)).status).toBe(404)
    expect(await list(c.di)).toEqual([])
  })

  it('a note about a record: readers of the record read it and see it on the timeline; others do not', async () => {
    const n = ok(await c.bo.post('/data/Activities/rows', { values: { Type: 'Note', Subject: 'About the Pune order', Body: `<p>Delivery <span data-record="${ids.orders}:${ids.order}"></span></p>`, regardingTable: ids.orders, regardingId: ids.order } })).row
    ids.about = n.id
    // Ed reads Orders: he reads the note without a share, and sees it on the order's timeline
    expect(await readable(c.ed, n.id)).toBe(true)
    const tl = ok(await c.ed.get(`/collab/timeline?table=${ids.orders}&row=${ids.order}`))
    expect(tl.items.some((i: any) => i.kind === 'activity' && i.id === n.id && i.data.Type === 'Note')).toBe(true)
    expect((await list(c.ed, '?view=records')).find((x) => x.id === n.id)?.regarding).toMatchObject({ label: 'Order for Pune' })
    // Cy cannot read Orders: no note, no timeline
    expect(await readable(c.cy, n.id)).toBe(false)
    expect((await c.cy.get(`/collab/timeline?table=${ids.orders}&row=${ids.order}`)).status).toBe(404)
    // a share shows Cy the note, not the record: the card stays unavailable to her
    ok(await c.bo.post('/data/ActivityShares/rows', { values: { Activity: n.id, PrincipalType: 'user', Principal: ids.cy, Access: 'read' } }))
    const cyCards = ok(await c.cy.post(`/notes/${n.id}/cards`, {})).cards
    expect(cyCards[`${ids.orders}:${ids.order}`]).toEqual({ available: false, kind: 'record' })
    expect(JSON.stringify(cyCards)).not.toContain('Pune')
    const edCards = ok(await c.ed.post(`/notes/${n.id}/cards`, {})).cards
    expect(edCards[`${ids.orders}:${ids.order}`]).toMatchObject({ available: true, title: 'Order for Pune' })
    expect(ok(await c.cy.get(`/notes/${n.id}`)).regarding).toMatchObject({ label: null })
  })

  it('pins are per person', async () => {
    ok(await c.cy.req('PUT', `/notes/${ids.note}/pin`, { on: true }))
    expect((await list(c.cy, '?view=pinned')).map((x) => x.id)).toEqual([ids.note])
    expect(await list(c.bo, '?view=pinned')).toEqual([])
    ok(await c.cy.req('PUT', `/notes/${ids.note}/pin`, { on: false }))
    expect(await list(c.cy, '?view=pinned')).toEqual([])
    expect((await c.di.req('PUT', `/notes/${ids.note}/pin`, { on: true })).status).toBe(404)
  })
})
