/**
 * Print templates end to end against the sandbox PostgreSQL (APPBUILDER_TEST_DB) and a fake SMTP server: the built-in
 * templates on the pilot's data (PNG renders for review when APPBUILDER_PRINT_RENDERS names a folder), security-trimmed
 * generation (rows, hidden columns, unreadable records), the service identity, GeneratePdf tokens claimed by file columns,
 * Documents with a number sequence, the flow step document.generate with an emailed PDF, scheduled reports with PDFs,
 * bulk jobs (zip and merged), Word templates, settings, versions, locked environments, solutions, a large report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import PizZip from 'pizzip'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { runInEnvironment } from '../env-context.ts'
import { hashPassword } from '../password.ts'
import type { UserRecord } from '../contracts.ts'
import { ROLE_MAKER } from '../auth.ts'
import { startFakeSmtp, type FakeSmtp } from '../identity/fake-smtp.ts'
import { createPilot, hasPoppler, hasRaster, pdfPageCount, pdfText, rasterise, samplePng, type Pilot } from './print-testkit.ts'

if (!PG_URL) process.stderr.write(`[server/core/print integration] ${SKIP_PG}\n`)
const PW = 'print-password-1'
const DAY = '2026-11-19'
const RENDERS = process.env.APPBUILDER_PRINT_RENDERS || ''

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.skipIf(!PG_URL)('print templates (PostgreSQL)', () => {
  let h: KernelHarness
  let p: Pilot
  let smtp: FakeSmtp
  let mia: Client
  let bo: Client
  const tpl: Record<string, string> = {}
  const A = () => h.admin
  const drain = async () => {
    for (let i = 0; i < 6; i++) {
      await h.app.services.kernel.drain({ timeoutMs: 60_000 })
      const n = await runInEnvironment('default', () => h.app.services.flows.sweep(true))
      if (!n) break
    }
  }
  const getBytes = async (c: Client, path: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> => {
    const res = await fetch(`${h.base}/api/v1${path}`, { headers: { 'X-Appbuilder': '1', Cookie: c.cookie } })
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers }
  }
  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.replace('user_', '').replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, false, now()) ON CONFLICT DO NOTHING', ['default', id])
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }
  const review = (bytes: Buffer, name: string) => { if (RENDERS && hasRaster()) rasterise(bytes, RENDERS, name, 70) }

  beforeAll(async () => {
    smtp = await startFakeSmtp()
    h = await startHarness('print', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    h.app.services.print!.setFixedTime(new Date(`${DAY}T06:30:00Z`))
    const mail = await A().req('PUT', '/identity/email', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'apps@example.com', installName: 'Acme Apps', publicUrl: 'https://apps.example.com' })
    expect(mail.status, JSON.stringify(mail.data)).toBe(200)
    p = await createPilot(h, DAY)
    mia = await addUser('user_mia', 'mia@example.com', [ROLE_MAKER])
    // Bo: his own inspections, without the Notes column; all defects
    const role = await A().post('/roles', { name: 'Inspector', apps: 'all', privileges: [
      { table: p.inspections, create: true, read: 'own', update: 'own', delete: 'none', columns: { Notes: 'none' } },
      { table: p.defects, create: true, read: 'all', update: 'all', delete: 'none' },
    ] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    bo = await addUser('user_bo', 'bo@example.com', [role.data.id])
    const lh = await A().req('PUT', '/print/settings', { letterhead: { companyName: 'Shakti Precision Components Pvt Ltd', address: 'Plot 22, Govindpura Industrial Area, Bhopal 462023', phone: '+91 755 400 1234', email: 'quality@shakti.example', gstin: '23AABCS1234F1Z5', logo: `data:image/png;base64,${samplePng(240, 80, [30, 64, 175]).toString('base64')}` }, grouping: 'indian', dateFormat: 'dd-MM-yyyy' })
    expect(lh.status, JSON.stringify(lh.data)).toBe(200)
    for (const [key, table] of [['inspection-report'], ['daily-oee'], ['purchase-request'], ['delivery-challan'], ['record-sheet', 'Inspections'], ['table-list', 'ProductionLogs']] as [string, string?][]) {
      const r = await A().post('/print/builtins', { key, ...(table ? { table } : {}) })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      expect(r.data.template.version).toBe(1)
      tpl[key] = r.data.template.id
    }
  }, 240_000)

  afterAll(async () => {
    await h?.close()
    await smtp?.close()
  }, 60_000)

  it('the six built-in templates print the pilot data (text, pages, Hindi, totals, grouping, letterhead)', async () => {
    const cases: [string, string | undefined, RegExp[]][] = [
      ['inspection-report', p.inspection1, [/Inspection report/, /INSP-2026-0042/, /Thread pitch out of tolerance/, /Total\s+11/, /Shakti Precision Components/, /GSTIN: 23AABCS1234F1Z5/, /FAIL/, /Page 1 of 1/]],
      ['daily-oee', undefined, [/Daily production and OEE/, /19 November 2026/, /CNC-07 \(3 shifts\)/, /Subtotal/, /Total/, /OEE by machine and shift/]],
      ['purchase-request', p.request1, [/Purchase request PR-0107/, /Bearing 6205-2RS/, /₹7,786\.00/, /Approval history/]],
      ['delivery-challan', p.challan1, [/DELIVERY CHALLAN/, /DC\/26-27\/0315/, /MH 14 AB 1234/, /Total quantity\s+1,920/, /not a tax invoice/]],
      ['record-sheet', p.inspection1, [/Inspections: INSP-2026-0042/, /Asha Verma/]],
      ['table-list', undefined, [/Production logs/, /15 rows/]],
    ]
    for (const [key, rec, want] of cases) {
      const r = await getBytes(A(), `/print/templates/${tpl[key]}/pdf${rec ? `?recordId=${rec}` : ''}`)
      expect(r.status, r.bytes.toString().slice(0, 300)).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/pdf')
      expect(r.bytes.subarray(0, 8).toString()).toBe('%PDF-1.7')
      review(r.bytes, key)
      if (hasPoppler()) {
        const text = pdfText(r.bytes)
        for (const re of want) expect(text, `${key}: ${re}`).toMatch(re)
      }
    }
    // the generation log has every run, with pages and no warnings for the pilot data
    const runs = (await A().get('/print/runs')).data.items as any[]
    expect(runs.filter((x) => x.status === 'succeeded').length).toBeGreaterThanOrEqual(6)
    expect(runs.find((x) => x.templateId === tpl['inspection-report']).warnings).toEqual([])
    // the daily summary: landscape, the KPIs, gauge and chart on page 1, the log (header repeated) after it
    const oee = await getBytes(A(), `/print/templates/${tpl['daily-oee']}/pdf`)
    expect(pdfPageCount(oee.bytes)).toBe(3)
    if (hasPoppler()) expect(pdfText(oee.bytes).split('\f').slice(1, 3).every((pg) => /Shift\s+Planned \(min\)/.test(pg))).toBe(true)
  }, 120_000)

  it('the approval history block prints who decided what (as the generating identity may read it)', async () => {
    const req = await mia.post('/approvals', { approvers: ['ada@example.com'], title: 'Approve PR-0107', regarding: { rowId: p.request1 } })
    expect(req.status, JSON.stringify(req.data)).toBe(200)
    const ans = await A().post(`/approvals/${req.data.id}/respond`, { response: 'Approve', comment: 'Bearings are needed this week' })
    expect(ans.status, JSON.stringify(ans.data)).toBe(200)
    const r = await getBytes(A(), `/print/templates/${tpl['purchase-request']}/pdf?recordId=${p.request1}`)
    expect(r.status).toBe(200)
    review(r.bytes, 'purchase-request')
    if (hasPoppler()) {
      const t = pdfText(r.bytes)
      expect(t).toMatch(/Approval history/)
      expect(t).toMatch(/Approve PR-0107/)
      expect(t.replace(/\s+/g, ' ')).toMatch(/Bearings are needed this week/)
      expect(t).not.toMatch(/has not been sent for approval/)
    }
    // Bo cannot read the request's record (no role on PurchaseRequests): he gets no document at all
    expect((await bo.post('/print/generate', { template: tpl['purchase-request'], recordId: p.request1 })).status).toBe(404)
  }, 60_000)

  it('the inspection report shows its photos and decodes as Hindi text (shaping kept in the text layer)', async () => {
    const r = await getBytes(A(), `/print/templates/${tpl['inspection-report']}/pdf?recordId=${p.inspection1}`)
    const s = r.bytes.toString('latin1')
    expect((s.match(/\/Subtype \/Image/g) ?? []).length).toBe(4) // three photos and the logo
    if (hasPoppler()) expect(pdfText(r.bytes)).toMatch(/गियर हाउसिंग/)
  }, 60_000)

  it('security: generation runs as the person; unreadable records are 404, hidden columns print blank with a warning', async () => {
    // Bo cannot read Ada's inspection
    expect((await bo.post('/print/generate', { template: tpl['inspection-report'], recordId: p.inspection1 })).status).toBe(404)
    // his own one prints; Notes is hidden from him: blank and a warning, never an error
    const own = await bo.post('/data/Inspections/rows', { values: { Number: 'INSP-BO-1', Product: 'Bracket', Inspector: 'Bo', Result: 'Pass', InspectedOn: DAY } })
    expect(own.status, JSON.stringify(own.data)).toBe(200)
    await A().post('/data/Inspections/rows', { values: { Number: 'X' } })
    await h.q(`UPDATE env_default.t_inspections SET "Notes" = 'TOP-SECRET-NOTE' WHERE id = $1`, [own.data.row.id])
    await bo.post('/data/InspectionDefects/rows', { values: { Inspection: own.data.row.id, Defect: 'Chipped edge', Severity: 'Minor', Qty: 1 } })
    const g = await bo.post('/print/generate', { template: tpl['inspection-report'], recordId: own.data.row.id })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data.file.warnings.join(' ')).toMatch(/column Notes of Inspections is not visible to Bo; it prints blank/)
    const f = await getBytes(bo, `/print/files/${g.data.file.token}`)
    expect(f.status).toBe(200)
    if (hasPoppler()) {
      const t = pdfText(f.bytes)
      expect(t).toContain('INSP-BO-1')
      expect(t).toContain('Chipped edge')
      expect(t).not.toContain('TOP-SECRET-NOTE')
    }
    // the token is Bo's: Mia cannot download it; an administrator can
    expect((await getBytes(mia, `/print/files/${g.data.file.token}`)).status).toBe(404)
    expect((await getBytes(A(), `/print/files/${g.data.file.token}`)).status).toBe(200)
    // the generation log records who and as whom
    const run = (await A().get(`/print/runs/${g.data.file.runId}`)).data.run
    expect(run).toMatchObject({ userId: 'user_bo', runAs: 'Bo', status: 'succeeded', recordIds: [own.data.row.id] })
  }, 60_000)

  it('service identity: administrators only, audited; the template then reads what the service account may read', async () => {
    const sa = await A().post('/identity/service-accounts', { name: 'Printer bot', roleIds: ['role_admin'] })
    expect(sa.status, JSON.stringify(sa.data)).toBe(200)
    const saId = sa.data.id ?? sa.data.user?.id
    const copy = await mia.post(`/print/templates/${tpl['inspection-report']}/copy`, { name: 'Inspection (bot)' })
    expect(copy.status, JSON.stringify(copy.data)).toBe(200)
    const id = copy.data.template.id
    expect((await mia.req('PUT', `/print/templates/${id}`, { runAs: { serviceAccount: saId } })).status).toBe(403)
    const set = await A().req('PUT', `/print/templates/${id}`, { runAs: { serviceAccount: saId }, publish: true })
    expect(set.status, JSON.stringify(set.data)).toBe(200)
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'print.run_as_service'`)).length).toBe(1)
    // Mia may no longer change it
    expect((await mia.req('PUT', `/print/templates/${id}`, { description: 'x' })).status).toBe(403)
    // Bo prints Ada's inspection through it: allowed (the service account reads it), audited
    const g = await bo.post('/print/generate', { template: id, recordId: p.inspection1 })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'print.generate_as_service'`)).length).toBe(1)
    const run = (await A().get(`/print/runs/${g.data.file.runId}`)).data.run
    expect(run.runAs).toMatch(/^service account Printer bot for Bo$/)
  }, 60_000)

  it('GeneratePdf tokens: a file column claims the generated file (Patch); others cannot use the token', async () => {
    const token = 'gen_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
    const g = await A().post('/print/generate', { template: tpl['inspection-report'], recordId: p.inspection2, token })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data.file.token).toBe(token)
    // Mia cannot put Ada's token into a cell
    const bad = await mia.req('PATCH', `/data/Inspections/rows/${p.inspection2}`, { changes: { Report: token } })
    expect(bad.status, JSON.stringify(bad.data)).toBe(422)
    const ok = await A().req('PATCH', `/data/Inspections/rows/${p.inspection2}`, { changes: { Report: token } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const att = ok.data.row.Report
    expect(String(att)).toMatch(/^att/)
    const dl = await getBytes(A(), `/attachments/${att}`)
    expect(dl.status).toBe(200)
    expect(dl.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    // a token that does not exist is refused with a clear message
    const none = await A().req('PATCH', `/data/Inspections/rows/${p.inspection2}`, { changes: { Report: 'gen_' + 'Z'.repeat(24) } })
    expect(none.status).toBe(422)
  }, 150_000)

  it('the record timeline action stores the PDF in Documents with a number from a sequence', async () => {
    await A().post('/data/NumberSequences/rows', { values: { Name: 'Inspection reports', Prefix: 'IR/{FY}/', Padding: 4, NextValue: 1, ResetRule: 'financialYear' } })
    const r = await A().post(`/print/templates/${tpl['inspection-report']}/documents`, { recordId: p.inspection1, numberSequence: 'Inspection reports' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.name).toMatch(/^IR\/.+\/0001 Inspection INSP-2026-0042\.pdf$/)
    const docs = await h.q<any>(`SELECT "Name", "regardingTable", "regardingId", "File" FROM env_default.sys_documents WHERE id = $1`, [r.data.documentId])
    expect(docs[0]).toMatchObject({ regardingTable: p.inspections, regardingId: p.inspection1 })
    expect(String(docs[0].File)).toMatch(/^att/)
    // the document's file became version 1
    const v = await h.q<any>(`SELECT "VersionNumber" FROM env_default.sys_document_versions WHERE "Document" = $1`, [r.data.documentId])
    expect(v.map((x) => Number(x.VersionNumber))).toEqual([1])
    // Bo cannot store a document about a record he cannot read
    expect((await bo.post(`/print/templates/${tpl['inspection-report']}/documents`, { recordId: p.inspection1 })).status).toBe(404)
  }, 60_000)

  it('flows: document.generate (file, record column) and an email with the PDF attached', async () => {
    const settings = { concurrency: 'parallel', timeoutMinutes: 60, retentionDays: 30, onError: 'fail' }
    const f = await A().post('/flows', {
      name: 'Daily OEE mail', settings, enabled: true, trigger: { type: 'manual', inputs: [], from: 'any' },
      steps: [
        { id: 'pdf', name: 'Pdf', kind: 'document.generate', template: 'Daily production and OEE summary' },
        { id: 'ins', name: 'Ins', kind: 'document.generate', template: 'Inspection report', record: `"${p.inspection1}"`, output: 'record', column: 'Report' },
        { id: 'mail', name: 'Mail', kind: 'email', to: '"manager@example.com"', subject: '"Daily OEE " & Steps.Pdf.Output.FileName', body: '"Attached."', attachments: 'Table({fileToken: Steps.Pdf.Output.FileToken})' },
      ],
    })
    expect(f.status, JSON.stringify(f.data)).toBe(200)
    const conn = await A().post('/connections', { name: 'Mail', connector: 'email', settings: {} })
    expect(conn.status, JSON.stringify(conn.data)).toBe(200)
    const run = await A().post(`/flows/${f.data.flow.id}/run`, {})
    expect(run.status, JSON.stringify(run.data)).toBe(200)
    await drain()
    const d = (await A().get(`/flows/runs/${run.data.runId}`)).data.run
    expect(d.status, JSON.stringify(d.steps.map((s: any) => [s.key, s.status, s.error]))).toBe('succeeded')
    const out = d.steps.find((s: any) => s.key === '/pdf').output
    expect(out.FileName).toBe('OEE 2026-11-19.pdf')
    expect(out.Pages).toBe(3)
    expect(String(d.steps.find((s: any) => s.key === '/ins').output.AttachmentId)).toMatch(/^att/)
    await smtp.waitFor(1, 20_000).catch(() => undefined)
    const m = smtp.inbox.find((x) => x.subject.startsWith('Daily OEE'))!
    expect(m, smtp.inbox.map((x) => x.subject).join(', ')).toBeTruthy()
    expect(m.to).toContain('manager@example.com')
    expect(m.attachments[0]).toMatchObject({ fileName: 'OEE 2026-11-19.pdf' })
    expect(m.attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-')
  }, 120_000)

  it('scheduled reports attach a PDF: the automatic layout and a template, computed as the recipient', async () => {
    const before = smtp.inbox.length
    const auto = await A().post('/reports', { name: 'Logs (auto)', source: { kind: 'table', tableId: p.logs, plan: { version: 2, table: 'ProductionLogs', select: ['Machine', 'Shift', 'TotalCount'] } }, schedule: { frequency: 'manual' }, recipients: { userIds: ['user_mia'], teamIds: [] }, pdf: { mode: 'auto' } })
    expect(auto.status, JSON.stringify(auto.data)).toBe(200)
    const viaTpl = await A().post('/reports', { name: 'OEE (template)', source: { kind: 'table', tableId: p.logs, plan: { version: 2, table: 'ProductionLogs' } }, schedule: { frequency: 'manual' }, recipients: { userIds: ['user_mia'], teamIds: [] }, csvRows: 0, pdf: { mode: 'template', template: tpl['daily-oee'] } })
    expect(viaTpl.status, JSON.stringify(viaTpl.data)).toBe(200)
    // a record template cannot be attached to a report
    expect((await A().post('/reports', { name: 'Bad', source: { kind: 'table', tableId: p.logs, plan: { version: 2, table: 'ProductionLogs' } }, schedule: { frequency: 'manual' }, recipients: { userIds: ['user_mia'], teamIds: [] }, pdf: { mode: 'template', template: tpl['inspection-report'] } })).status).toBe(422)
    for (const r of [auto, viaTpl]) expect((await A().post(`/reports/${r.data.id}/run`, {})).status).toBe(200)
    await drain()
    const mails = smtp.inbox.slice(before).filter((m) => m.to.includes('mia@example.com'))
    expect(mails.length).toBe(2)
    const a1 = mails.find((m) => /Logs \(auto\)/.test(m.subject))!
    expect(a1.attachments.map((x: any) => x.contentType.split(';')[0])).toEqual(['text/csv', 'application/pdf'])
    if (hasPoppler()) expect(pdfText(a1.attachments[1].content)).toMatch(/Logs \(auto\)[\s\S]*15 rows[\s\S]*CNC-07/)
    const a2 = mails.find((m) => /OEE \(template\)/.test(m.subject))!
    expect(a2.attachments.map((x: any) => x.fileName)).toEqual(['OEE 2026-11-19.pdf'])
  }, 120_000)

  it('bulk generation: a zip with one PDF per record, and one merged PDF, as a job with progress', async () => {
    const ids = [p.inspection1, p.inspection2, 'missing-id']
    const z = await A().post('/print/bulk', { template: tpl['inspection-report'], recordIds: ids, mode: 'zip' })
    expect(z.status, JSON.stringify(z.data)).toBe(200)
    await drain()
    const run = (await A().get(`/print/runs/${z.data.runId}`)).data.run
    expect(run).toMatchObject({ status: 'succeeded', progress: { done: 3, total: 3 } })
    expect(run.warnings.join(' ')).toMatch(/missing-id: The record was not found/)
    const zip = await getBytes(A(), `/print/files/${run.fileToken}?download=1`)
    expect(zip.headers.get('content-type')).toBe('application/zip')
    const names = new PizZip(zip.bytes).file(/./).map((x: { name: string }) => x.name).sort()
    expect(names).toEqual(['Inspection INSP-2026-0042.pdf', 'Inspection INSP-2026-0043.pdf'])
    const m = await A().post('/print/bulk', { template: tpl['inspection-report'], recordIds: [p.inspection1, p.inspection2], mode: 'merged' })
    await drain()
    const mr = (await A().get(`/print/runs/${m.data.runId}`)).data.run
    expect(mr.status).toBe('succeeded')
    const merged = await getBytes(A(), `/print/files/${mr.fileToken}`)
    expect(pdfPageCount(merged.bytes)).toBe(mr.pages)
    expect(mr.pages).toBeGreaterThanOrEqual(2)
    // the person is notified
    expect((await h.q(`SELECT 1 FROM ab.notifications WHERE title LIKE 'Inspection report: % documents are ready'`)).length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('Word templates: merge fields, loops and conditions with the free docxtemplater core (no PDF conversion)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Inspection {Number} of {FormatDate(InspectedOn)}</w:t></w:r></w:p>
      <w:p><w:r><w:t>{#Related.Defects}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">- {Defect} x {Qty} ({Severity})</w:t></w:r></w:p><w:p><w:r><w:t>{/Related.Defects}</w:t></w:r></w:p>
      <w:p><w:r><w:t>{#Result = “Fail”}REWORK NEEDED{/Result = “Fail”}{^Result = "Fail"}RELEASED{/Result = "Fail"}</w:t></w:r></w:p>
      <w:p><w:r><w:t>{Company.Name}</w:t></w:r></w:p></w:body></w:document>`
    const z = new PizZip()
    z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.file('word/document.xml', xml)
    const docx = z.generate({ type: 'nodebuffer' }) as Buffer
    const doc = { version: 1, page: { size: 'A4', orientation: 'portrait', margins: { top: 15, right: 15, bottom: 15, left: 15 } }, source: { kind: 'record', table: 'Inspections', related: [{ name: 'Defects', table: 'InspectionDefects', column: 'Inspection', sort: [{ column: 'Qty' }] }] }, styles: { fontSize: 10, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra' }, header: { blocks: [] }, footer: { blocks: [] }, body: [], fileName: 'Inspection {Number}' }
    const bad = await mia.post('/print/templates', { name: 'Broken word', kind: 'docx', doc, docxBase64: Buffer.from('not a zip').toString('base64') })
    expect(bad.status).toBe(422)
    const c = await mia.post('/print/templates', { name: 'Inspection (Word)', kind: 'docx', doc, docxBase64: docx.toString('base64'), docxFileName: 'inspection.docx', publish: true })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    const g = await A().post('/print/generate', { template: 'Inspection (Word)', recordId: p.inspection1 })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data.file).toMatchObject({ fileName: 'Inspection INSP-2026-0042.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const out = await getBytes(A(), `/print/files/${g.data.file.token}`)
    const text = new PizZip(out.bytes).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '')
    expect(text).toContain('Inspection INSP-2026-0042 of 19-11-2026')
    expect(text).toContain('- Thread pitch out of tolerance x 1 (Critical)')
    expect(text.indexOf('x 1 (Critical)')).toBeLessThan(text.indexOf('x 5 (Minor)'))
    expect(text).toContain('REWORK NEEDED')
    expect(text).not.toContain('RELEASED')
    expect(text).toContain('Shakti Precision Components')
  }, 60_000)

  it('designer API: drafts, publish, versions, restore, copy; non-makers see published templates only; settings are for administrators', async () => {
    const t = (await mia.post('/print/templates', { name: 'Draft only', doc: { source: { kind: 'none' }, body: [{ id: 'h', kind: 'heading', level: 1, text: 'v1' }] } })).data.template
    expect(t.status).toBe('draft')
    // Bo (not a maker) does not see drafts and cannot generate an unpublished template
    expect(((await bo.get('/print/templates')).data.items as any[]).some((x) => x.id === t.id)).toBe(false)
    expect((await bo.post('/print/generate', { template: t.id })).status).toBe(422)
    // a preview of an unsaved document (makers)
    const prev = await fetch(`${h.base}/api/v1/print/templates/${t.id}/preview`, { method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: mia.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: { source: { kind: 'none' }, body: [{ id: 'x', kind: 'text', text: 'Unsaved {1+1}' }] } }) })
    expect(prev.status).toBe(200)
    expect(prev.headers.get('x-print-pages')).toBe('1')
    expect((await bo.post(`/print/templates/${t.id}/preview`, {})).status).toBe(403)
    // invalid documents are refused with the path
    const bad = await mia.req('PUT', `/print/templates/${t.id}`, { doc: { source: { kind: 'none' }, body: [{ id: 'z', kind: 'table', rows: '', columns: [] }] } })
    expect(bad.status).toBe(422)
    expect(bad.data.error.field).toBe('body.0.rows')
    await mia.post(`/print/templates/${t.id}/publish`, {})
    await mia.req('PUT', `/print/templates/${t.id}`, { doc: { source: { kind: 'none' }, body: [{ id: 'h', kind: 'heading', level: 1, text: 'v2' }] }, publish: true })
    const vs = (await mia.get(`/print/templates/${t.id}/versions`)).data.items
    expect(vs.map((v: any) => v.version)).toEqual([2, 1])
    const back = await mia.post(`/print/templates/${t.id}/restore`, { version: 1 })
    expect(back.data.template.doc.body[0].text).toBe('v1')
    expect(back.data.template.published.body[0].text).toBe('v2')
    expect(back.data.template.dirty).toBe(true)
    // Bo sees it now (published) and gets the published document
    expect((await bo.get(`/print/templates/${t.id}`)).data.template.doc.body[0].text).toBe('v2')
    expect((await mia.req('PUT', '/print/settings', { letterhead: { companyName: 'X' } })).status).toBe(403)
  }, 60_000)

  it('solutions: print templates travel (published document, Word file), plan shows them, removal removes them', async () => {
    const sol = await A().post('/solutions', { displayName: 'Quality documents' })
    expect(sol.status, JSON.stringify(sol.data)).toBe(200)
    for (const id of [tpl['inspection-report'], (await A().get('/print/templates')).data.items.find((x: any) => x.name === 'Inspection (Word)').id]) {
      expect((await A().post(`/solutions/${sol.data.id}/components`, { kind: 'printTemplate', id })).status).toBe(200)
    }
    const yaml = (await A().get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    expect(yaml).toMatch(/printTemplates:/)
    const env = await A().post('/environments', { name: 'Print target', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    const T = new Client(h.base)
    T.cookie = A().cookie
    T.env = env.data.id
    const plan = (await T.post('/solutions/import/plan', { yaml })).data
    const items = plan.items.filter((i: any) => i.kind === 'printTemplate')
    expect(items.map((i: any) => [i.name, i.change]).sort()).toEqual([['Inspection (Word)', 'new'], ['Inspection report', 'new']])
    expect(plan.warnings.join(' ')).toMatch(/reads the table Inspections, which is not here/)
    expect((await T.post('/solutions/import', { yaml })).status).toBe(200)
    const there = (await T.get(`/print/templates/${tpl['inspection-report']}`)).data.template
    expect(there).toMatchObject({ name: 'Inspection report', version: 1, status: 'published', solutionId: sol.data.id })
    const word = (await T.get('/print/templates')).data.items.find((x: any) => x.name === 'Inspection (Word)')
    expect(word.docxFileName).toBe('inspection.docx')
    // removed from the solution: an upgrade removes it
    await A().del(`/solutions/${sol.data.id}/components/printTemplate/${tpl['inspection-report']}`)
    const yaml2 = (await A().get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    const p2 = (await T.post('/solutions/import/plan', { yaml: yaml2 })).data
    expect(p2.items.find((i: any) => i.kind === 'printTemplate' && i.id === tpl['inspection-report'])).toMatchObject({ change: 'removed' })
    expect((await T.post('/solutions/import', { yaml: yaml2, confirm: p2.token })).status).toBe(200)
    expect((await T.get(`/print/templates/${tpl['inspection-report']}`)).status).toBe(404)
  }, 180_000)

  it('locked production: templates are read-only (design routes refused); printing still works', async () => {
    await h.q(`UPDATE ab.environments SET locked = true WHERE id = 'default'`)
    h.app.services.environments.invalidate()
    try {
      expect((await A().req('PUT', `/print/templates/${tpl['table-list']}`, { description: 'x' })).status).toBe(403)
      expect((await A().post('/print/builtins', { key: 'daily-oee', name: 'Another' })).status).toBe(403)
      expect((await A().post('/print/generate', { template: tpl['table-list'] })).status).toBe(200)
    } finally {
      await h.q(`UPDATE ab.environments SET locked = false WHERE id = 'default'`)
      h.app.services.environments.invalidate()
    }
  }, 60_000)

  it('a large report: 2,500 rows over 50+ pages in a few seconds, within a memory bound', async () => {
    const lines = ['LogDate,Machine,Shift,PlannedMinutes,RunMinutes,IdealRatePerMinute,TotalCount,GoodCount']
    for (let i = 0; i < 2500; i++) lines.push(`2026-11-18,M-${String(i % 40).padStart(2, '0')},${'ABC'[i % 3]},480,${400 + (i % 50)},2.5,${900 + (i % 100)},${880 + (i % 90)}`)
    expect((await A().post('/data/ProductionLogs/import', { csv: lines.join('\n'), mode: 'append' })).status).toBe(200)
    const t = await A().post('/print/builtins', { key: 'table-list', table: 'ProductionLogs', name: 'All logs' })
    global.gc?.()
    const heap0 = process.memoryUsage().heapUsed
    const t0 = Date.now()
    const g = await A().post('/print/generate', { template: t.data.template.id })
    const ms = Date.now() - t0
    const heap = process.memoryUsage().heapUsed - heap0
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data.file.pages).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(15_000)
    expect(heap).toBeLessThan(400 * 1024 * 1024)
    process.stderr.write(`print large report: ${g.data.file.pages} pages, 2,515 rows, ${g.data.file.sizeBytes} bytes, ${ms} ms over HTTP, heap +${Math.round(heap / 1048576)} MB\n`)
    void zlib
  }, 120_000)
})
