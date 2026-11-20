/**
 * Unit tests of the backup building blocks (no database): the tar container, the chunked AES-256-GCM container
 * (wrong passphrase, tampering, truncation, random access), COPY text parsing, SQL splitting and schema renaming of
 * pg_restore output, and the retention rules (table-driven).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  ArchiveError, TarWriter, encryptedFileSink, isEncryptedFile, listTar, memberBuffer, memberStream, openReader, plainFileSink, type OpenFile,
} from './archive.ts'
import { RestoreDataParser, parseCopyLine, readCopyLines, renameInSql, renameSchemaRefs, skipRestoreStatement, splitSql } from './dbdump.ts'
import { CopyBlock, closeAfter, openArchive } from './engine.ts'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decideRetention, localParts, type RetentionItem } from './retention.ts'

const FAST_KDF = { log2N: 10, r: 8, p: 1 }
let tmp = ''
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bk-unit-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

async function writeArchive(file: string, members: [string, Buffer][], pass?: string, chunkSize?: number) {
  const sink = pass ? await encryptedFileSink(file, pass, { kdf: FAST_KDF, chunkSize }) : plainFileSink(file)
  const t = new TarWriter(sink)
  for (const [n, b] of members) {
    if (b.length > 100_000) await t.addStream(n, b.length, Readable.from([b.subarray(0, 50_000), b.subarray(50_000)]))
    else await t.addBuffer(n, b)
  }
  return { ...(await t.finish()), members: t.members }
}

describe('tar container', () => {
  it('round-trips members, long and non-ASCII names, empty and large members', async () => {
    const big = randomBytes(300_000)
    const long = 'files/default/attachments/' + 'x'.repeat(150) + '/ünïcödé.bin'
    const f = path.join(tmp, 'plain.abbak')
    const w = await writeArchive(f, [['appbuilder-backup.json', Buffer.from('{}')], [long, Buffer.from('long name')], ['empty', Buffer.alloc(0)], ['big', big]])
    expect(w.bytes % 512).toBe(0)
    const r = await openReader(f)
    expect(r.encrypted).toBe(false)
    const list = await listTar(r)
    expect(list.map((e) => e.name)).toEqual(['appbuilder-backup.json', long, 'empty', 'big'])
    expect((await memberBuffer(r, list[1])).toString()).toBe('long name')
    expect((await memberBuffer(r, list[2])).length).toBe(0)
    const chunks: Buffer[] = []
    for await (const c of memberStream(r, list[3], 7000)) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).equals(big)).toBe(true)
    await r.close()
    // other tools can read it too (POSIX tar)
    expect(w.members[3].size).toBe(big.length)
  })

  it('a stream shorter or longer than announced is an error', async () => {
    const t = new TarWriter(plainFileSink(path.join(tmp, 'bad.tar')))
    await expect(t.addStream('a', 10, Readable.from([Buffer.alloc(5)]))).rejects.toThrow(/changed size/)
    const t2 = new TarWriter(plainFileSink(path.join(tmp, 'bad2.tar')))
    await expect(t2.addStream('a', 3, Readable.from([Buffer.alloc(5)]))).rejects.toThrow(/grew/)
  })

  it('a damaged header and a truncated file are detected', async () => {
    const f = path.join(tmp, 'dmg.abbak')
    await writeArchive(f, [['a', Buffer.from('hello')], ['b', randomBytes(2000)]])
    const buf = fs.readFileSync(f)
    const bad = Buffer.from(buf)
    bad[10] ^= 0xff
    fs.writeFileSync(f + '.1', bad)
    const r1 = await openReader(f + '.1')
    await expect(listTar(r1)).rejects.toThrow(/bad member header/)
    await r1.close()
    fs.writeFileSync(f + '.2', buf.subarray(0, 1024 + 512))
    const r2 = await openReader(f + '.2')
    await expect(listTar(r2)).rejects.toBeInstanceOf(ArchiveError)
    await r2.close()
  })
})

describe('encrypted container', () => {
  const members: [string, Buffer][] = [['appbuilder-backup.json', Buffer.from('{"format":"x"}')], ['data', randomBytes(200_000)], ['tail', Buffer.from('end')]]

  it('round-trips and supports random access; plaintext never appears in the file', async () => {
    const f = path.join(tmp, 'enc.abbak')
    await writeArchive(f, members, 'correct horse battery', 4096)
    expect(await isEncryptedFile(f)).toBe(true)
    expect(fs.readFileSync(f).includes(Buffer.from('appbuilder-backup.json'))).toBe(false)
    const r = await openReader(f, 'correct horse battery')
    expect(r.encrypted).toBe(true)
    const list = await listTar(r)
    expect(list.map((e) => e.name)).toEqual(['appbuilder-backup.json', 'data', 'tail'])
    const data = list[1]
    const slice = await r.read(data.offset + 12345, 9000)
    expect(slice.equals(members[1][1].subarray(12345, 12345 + 9000))).toBe(true)
    expect((await memberBuffer(r, list[2])).toString()).toBe('end')
    await r.close()
  })

  it('wrong and missing passphrases fail cleanly', async () => {
    const f = path.join(tmp, 'enc2.abbak')
    await writeArchive(f, members, 'right passphrase', 4096)
    await expect(openReader(f, 'wrong passphrase')).rejects.toMatchObject({ kind: 'passphrase' })
    await expect(openReader(f)).rejects.toMatchObject({ kind: 'needs-passphrase' })
    await expect(openReader(f, '')).rejects.toMatchObject({ kind: 'needs-passphrase' })
  })

  it('a changed byte, a truncated file and swapped chunks are detected', async () => {
    const f = path.join(tmp, 'enc3.abbak')
    await writeArchive(f, members, 'pass phrase 1', 4096)
    const buf = fs.readFileSync(f)
    const flip = Buffer.from(buf)
    flip[64 + 4112 * 10 + 5] ^= 1
    fs.writeFileSync(f + '.flip', flip)
    const r = await openReader(f + '.flip', 'pass phrase 1')
    await expect(listTar(r).then(async (l) => { for (const e of l) await memberBuffer(r, e) })).rejects.toMatchObject({ kind: 'corrupt' })
    await r.close()
    // truncated at a chunk boundary: the last chunk flag is missing
    fs.writeFileSync(f + '.cut', buf.subarray(0, 64 + 4112 * 20))
    const r2 = await openReader(f + '.cut', 'pass phrase 1')
    await expect(r2.read(r2.size - 10, 10)).rejects.toMatchObject({ kind: 'corrupt' })
    await r2.close()
    // two chunks swapped
    const sw = Buffer.from(buf)
    const a = buf.subarray(64 + 4112 * 3, 64 + 4112 * 4)
    const b = buf.subarray(64 + 4112 * 4, 64 + 4112 * 5)
    a.copy(sw, 64 + 4112 * 4)
    b.copy(sw, 64 + 4112 * 3)
    fs.writeFileSync(f + '.swap', sw)
    const r3 = await openReader(f + '.swap', 'pass phrase 1')
    await expect(r3.read(4096 * 3, 10)).rejects.toMatchObject({ kind: 'corrupt' })
    await r3.close()
  })
})

/**
 * A file handle that is not closed is closed by the garbage collector, which is an error since Node 24 (it can end the
 * process). Every way of opening an archive that fails must leave no handle behind, and a reader that was opened and then
 * failed while reading is closed by whoever opened it.
 */
describe('file handles', () => {
  function countingOpen() {
    const open = new Set<number>()
    let opened = 0
    const fn: OpenFile = async (file, flags) => {
      const h = await fs.promises.open(file, flags)
      const id = ++opened
      open.add(id)
      const close = h.close.bind(h)
      h.close = async () => { open.delete(id); await close() }
      return h
    }
    return { fn, open, opened: () => opened }
  }

  it('openReader closes its handle when it refuses a file', async () => {
    const c = countingOpen()
    const members: [string, Buffer][] = [['appbuilder-backup.json', Buffer.from('{}')], ['data', randomBytes(20_000)]]
    const good = path.join(tmp, 'h-enc.abbak')
    await writeArchive(good, members, 'right one', 4096)
    const raw = fs.readFileSync(good)
    const refused: [string, Buffer, string | undefined, string][] = [
      ['h-nopass', raw, undefined, 'needs-passphrase'],
      ['h-wrongpass', raw, 'wrong one', 'passphrase'],
      ['h-cut', raw.subarray(0, 64 + 4112 + 5), 'right one', 'corrupt'],
      ['h-newer', Buffer.concat([raw.subarray(0, 8), Buffer.from([9]), raw.subarray(9)]), 'right one', 'format'],
      ['h-kdf', Buffer.concat([raw.subarray(0, 9), Buffer.from([40]), raw.subarray(10)]), 'right one', 'format'],
    ]
    for (const [name, bytes, pass, kind] of refused) {
      const f = path.join(tmp, name)
      fs.writeFileSync(f, bytes)
      await expect(openReader(f, pass, { open: c.fn })).rejects.toMatchObject({ kind })
    }
    await expect(openReader(path.join(tmp, 'no-such-file'), undefined, { open: c.fn })).rejects.toThrow()
    expect(c.opened()).toBe(refused.length)
    expect([...c.open]).toEqual([])
  })

  it('openArchive closes its reader when the file is not a usable backup', async () => {
    const c = countingOpen()
    const junk = path.join(tmp, 'h-junk.abbak')
    fs.writeFileSync(junk, randomBytes(3000))
    await expect(openArchive(junk, null, { open: c.fn })).rejects.toThrow()
    const nomarker = path.join(tmp, 'h-nomarker.abbak')
    await writeArchive(nomarker, [['other', Buffer.from('x')]])
    await expect(openArchive(nomarker, null, { open: c.fn })).rejects.toThrow(/not an Appbuilder backup/)
    const wrongMarker = path.join(tmp, 'h-wrongmarker.abbak')
    await writeArchive(wrongMarker, [['appbuilder-backup.json', Buffer.from('{"format":"x"}')], ['appbuilder-manifest.json', Buffer.from('{}')]])
    await expect(openArchive(wrongMarker, null, { open: c.fn })).rejects.toThrow()
    const enc = path.join(tmp, 'h-enc2.abbak')
    await writeArchive(enc, [['appbuilder-backup.json', Buffer.from('{}')]], 'pp pp pp', 4096)
    await expect(openArchive(enc, 'nope', { open: c.fn })).rejects.toMatchObject({ kind: 'passphrase' })
    expect(c.opened()).toBe(4)
    expect([...c.open]).toEqual([])
  })

  it('an archive handed to queued work is closed when the work can never start', async () => {
    let closed = 0
    const a = { close: async () => { closed++ } }
    // the queue refuses the job (its lock connection failed): the work function never runs
    closeAfter(a, Promise.reject(new Error('connect ECONNREFUSED')))
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
    // work that ran closes the archive itself; a second close from here is harmless
    closeAfter(a, Promise.resolve())
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
  })

  it('closing a reader twice is harmless', async () => {
    const f = path.join(tmp, 'h-twice.abbak')
    await writeArchive(f, [['a', Buffer.from('x')]])
    const r = await openReader(f)
    await r.close()
    await r.close()
  })
})

describe('COPY text and pg_restore SQL', () => {
  it('parses the escapes of the COPY text format', () => {
    expect(parseCopyLine('a\t\\N\tline\\nbreak\ttab\\there\tback\\\\slash\t\\x41\\101')).toEqual(['a', null, 'line\nbreak', 'tab\there', 'back\\slash', 'AA'])
    expect(parseCopyLine('')).toEqual([''])
  })

  it('reads a page of lines', async () => {
    const src = Readable.from([Buffer.from('1\n2\n3'), Buffer.from('\n4\n5\n')])
    expect(await readCopyLines(src, 1, 2)).toEqual({ lines: ['2', '3'], more: true })
    expect(await readCopyLines(Readable.from([Buffer.from('1\n2\n')]), 0, 10)).toEqual({ lines: ['1', '2'], more: false })
  })

  it('splits SQL outside quotes, dollar quotes and comments', () => {
    const sql = "SET x = 1;\n-- a; comment\nCREATE TABLE a (b text DEFAULT 'x;y');\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nCOMMENT ON TABLE a IS 'it''s;';\nSELECT 1"
    const { statements, rest } = splitSql(sql)
    expect(statements).toHaveLength(4)
    expect(statements[2]).toContain('$$ SELECT 1; $$')
    expect(rest.trim()).toBe('SELECT 1')
    expect(skipRestoreStatement('SET statement_timeout = 0')).toBe(true)
    expect(skipRestoreStatement("SELECT pg_catalog.set_config('search_path', '', false)")).toBe(true)
    expect(skipRestoreStatement('CREATE SCHEMA env_x')).toBe(true)
    expect(skipRestoreStatement('CREATE TABLE env_x.t (a int)')).toBe(false)
  })

  it('reads pg_restore data output: comments, \\restrict lines, COPY blocks, sequence values', async () => {
    const out = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict abc123', '', 'SET statement_timeout = 0;', "SELECT pg_catalog.set_config('search_path', '', false);", '',
      '--', '-- Data for Name: audit; Type: TABLE DATA', '--', '', 'COPY ab.audit (id, action, details) FROM stdin;', '1\ta\t{"x": 1}', '2\tb\t\\N', '\\.', '', '',
      'COPY ab."Users" (id, "Name") FROM stdin;', 'u1\tAnn', '\\.', '', "SELECT pg_catalog.setval('ab.audit_id_seq', 2, true);", '', '\\unrestrict abc123', ''].join('\n')
    const blocks: { table: string; columns: string[]; lines: number }[] = []
    const stmts: string[] = []
    let cur: { table: string; columns: string[]; lines: number } | null = null
    const p = new RestoreDataParser({
      async onCopy(h) { cur = { table: h.table, columns: h.columns, lines: 0 }; return new Writable({ write(c: Buffer, _e, cb) { cur!.lines += c.toString().split('\n').length - 1; cb() } }) },
      async onCopyEnd() { blocks.push(cur!) },
      async onStatement(s) { stmts.push(s) },
    })
    await pipeline(Readable.from([Buffer.from(out.slice(0, 100)), Buffer.from(out.slice(100))]), p)
    expect(blocks).toEqual([{ table: 'audit', columns: ['id', 'action', 'details'], lines: 2 }, { table: 'Users', columns: ['id', 'Name'], lines: 1 }])
    expect(stmts).toEqual(["SELECT pg_catalog.setval('ab.audit_id_seq', 2, true)"])
  })

  it('reads pg_restore output with CR LF line endings (Windows): the same blocks and bytes, a literal \\r in data kept', async () => {
    const lines = ['--', '\\restrict abc', 'SET statement_timeout = 0;', '', 'COPY ab.audit (id, note) FROM stdin;', '1\tline one\\rline two', '2\t\\N', '\\.', '', '',
      'COPY ab.t2 (id) FROM stdin;', 'x', '\\.', '', "SELECT pg_catalog.setval('ab.audit_id_seq', 2, true);", '\\unrestrict abc', '']
    const run = async (text: string, cut: number) => {
      const got: { table: string; data: string }[] = []
      const stmts: string[] = []
      let cur: { table: string; data: string } | null = null
      const p = new RestoreDataParser({
        async onCopy(h) { cur = { table: h.table, data: '' }; return new Writable({ write(c: Buffer, _e, cb) { cur!.data += c.toString(); cb() } }) },
        async onCopyEnd() { got.push(cur!) },
        async onStatement(s) { stmts.push(s) },
      })
      await pipeline(Readable.from([Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))]), p)
      return { got, stmts }
    }
    const lf = await run(lines.join('\n'), 60)
    expect(lf.got).toEqual([{ table: 'audit', data: '1\tline one\\rline two\n2\t\\N\n' }, { table: 't2', data: 'x\n' }])
    const crlf = lines.join('\r\n')
    // every cut position, so a chunk boundary between the CR and the LF is covered
    for (let cut = 1; cut < crlf.length; cut++) expect(await run(crlf, cut), `cut ${cut}`).toEqual(lf)
    // one table's block (browse and selective restore)
    const block = async (text: string, cut: number) => {
      const b = new CopyBlock()
      const chunks: Buffer[] = []
      b.on('data', (c: Buffer) => chunks.push(c))
      await pipeline(Readable.from([Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))]), b)
      return { columns: b.columns, data: Buffer.concat(chunks).toString() }
    }
    const one = await block(lines.join('\n'), 60)
    expect(one).toEqual({ columns: ['id', 'note'], data: '1\tline one\\rline two\n2\t\\N\n' })
    for (let cut = 1; cut < crlf.length; cut++) expect(await block(crlf, cut), `cut ${cut}`).toEqual(one)
  })

  it('renames the schema of qualified names, regclass literals, never other text', () => {
    expect(renameInSql("CREATE INDEX ab_ix ON env_a.t_orders USING btree (lower(name))", 'env_a', 'env_b')).toBe('CREATE INDEX ab_ix ON "env_b".t_orders USING btree (lower(name))')
    expect(renameInSql("SELECT pg_catalog.setval('env_a.ab_audit_id_seq', 31, true)", 'env_a', 'env_b')).toBe(`SELECT pg_catalog.setval('"env_b".ab_audit_id_seq', 31, true)`)
    expect(renameInSql('CREATE TABLE env_ab.t (x int)', 'env_a', 'env_b')).toBe('CREATE TABLE env_ab.t (x int)')
    expect(renameSchemaRefs('REFERENCES "env_a".t(id)', 'env_a', 'S')).toBe('REFERENCES S.t(id)')
    expect(renameSchemaRefs('x_env_a.t', 'env_a', 'S')).toBe('x_env_a.t')
  })
})

describe('retention (grandfather-father-son)', () => {
  const tz = 'UTC'
  const at = (d: string) => `${d}T02:00:00.000Z`
  const sched = (id: string, d: string, extra: Partial<RetentionItem> = {}): RetentionItem => ({ id, createdOn: at(d), trigger: 'schedule', state: 'ok', scope: 'install', ...extra })
  const daysBack = (n: number, from = '2026-11-18') => {
    const out: string[] = []
    const base = new Date(`${from}T00:00:00Z`).getTime()
    for (let i = 0; i < n; i++) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10))
    return out
  }

  it('knows calendar parts in a time zone', () => {
    expect(localParts('2026-11-15T23:30:00Z', 'UTC')).toEqual({ day: '2026-11-15', week: '2026-W46', month: '2026-11' })
    // 23:30 UTC is already the next day in India
    expect(localParts('2026-11-15T23:30:00Z', 'Asia/Kolkata')).toEqual({ day: '2026-11-16', week: '2026-W47', month: '2026-11' })
    expect(localParts('2027-01-01T12:00:00Z', 'UTC').week).toBe('2026-W53')
  })

  const cases: { name: string; items: RetentionItem[]; policy?: Partial<{ daily: number; weekly: number; monthly: number; snapshotDays: number }>; keep: string[]; prune: string[] }[] = [
    {
      name: '100 nightly backups: 7 days, 4 more weeks, 3 months',
      items: daysBack(100).map((d) => sched(d, d)),
      keep: [
        ...daysBack(7),
        // newest of the ISO weeks after the 7 days (weeks of 2026-11-16, 11-09 are covered by the dailies)
        '2026-11-08', '2026-11-01',
        // months: November is covered, then the newest of October and September
        '2026-10-31', '2026-09-30',
      ],
      prune: [],
    },
    {
      name: 'two backups the same day: only the newest counts for that day',
      items: [sched('a', '2026-11-18'), { ...sched('b', '2026-11-18'), createdOn: '2026-11-18T14:00:00.000Z' }, sched('c', '2026-11-17')],
      policy: { daily: 2, weekly: 0, monthly: 0 },
      keep: ['b', 'c'],
      prune: ['a'],
    },
    {
      name: 'failed backups do not use up a day; old failures go',
      items: [sched('f1', '2026-11-18', { state: 'failed' }), sched('ok1', '2026-11-17'), sched('ok2', '2026-11-16'), sched('fOld', '2026-09-01', { state: 'failed' })],
      policy: { daily: 1, weekly: 0, monthly: 0 },
      keep: ['f1', 'ok1'],
      prune: ['ok2', 'fOld'],
    },
    {
      name: 'manual, pinned and recent snapshots stay; old snapshots go; the newest good backup always stays',
      items: [
        { id: 'man', createdOn: at('2025-01-01'), trigger: 'manual', state: 'ok', scope: 'install' },
        sched('pin', '2025-02-01', { pinned: true }),
        { id: 'snapNew', createdOn: at('2026-11-10'), trigger: 'pre-upgrade', state: 'ok', scope: 'install' },
        { id: 'snapOld', createdOn: at('2026-08-01'), trigger: 'pre-delete', state: 'ok', scope: 'install' },
      ],
      policy: { daily: 0, weekly: 0, monthly: 0 },
      keep: ['man', 'pin', 'snapNew'],
      prune: ['snapOld'],
    },
    {
      name: 'scopes are independent',
      items: [sched('i1', '2026-11-18'), sched('i2', '2026-11-17'), sched('e1', '2026-11-18', { scope: 'sales' }), sched('e2', '2026-11-17', { scope: 'sales' })],
      policy: { daily: 1, weekly: 0, monthly: 0 },
      keep: ['i1', 'e1'],
      prune: ['i2', 'e2'],
    },
    {
      name: 'running backups are never pruned',
      items: [sched('r', '2026-01-01', { state: 'running' }), sched('ok', '2026-11-18')],
      policy: { daily: 1, weekly: 0, monthly: 0 },
      keep: ['r', 'ok'],
      prune: [],
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const d = decideRetention(c.items, { daily: 7, weekly: 4, monthly: 3, snapshotDays: 30, ...c.policy }, { timeZone: tz, now: new Date('2026-11-18T12:00:00Z') })
      expect(d.keep.map((k) => k.id).sort()).toEqual([...c.keep].sort())
      expect(d.prune.map((k) => k.id).sort()).toEqual([...c.prune, ...c.items.map((i) => i.id).filter((id) => !c.keep.includes(id) && !c.prune.includes(id))].sort())
    })
  }
})
