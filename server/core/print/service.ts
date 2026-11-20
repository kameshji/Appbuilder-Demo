/**
 * Print templates at run time (P2 package B; docs/dev/pdf.md): templates (draft and published, history), the
 * environment's print settings (letterhead, formats, limits), generation as a person / a flow's run-as / a service
 * account, the generation log, generated files (tokens, 24 hours, claimable by attachment cells), bulk generation as a
 * job (zip or one merged PDF) and Word (.docx) output.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { CoreServices } from '../services.ts'
import type { AttachmentRecord, UserContext } from '../contracts.ts'
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment, runInEnvironment } from '../env-context.ts'
import { JobError } from '../jobs.ts'
import { toUserDef } from '../auth.ts'
import { newLimits } from '../event-fx.ts'
import { errText, log } from '../util.ts'
import { visibleAttachment } from '../attachments.ts'
import { ZipStream } from '../export-data.ts'
import { GENERATED_TOKEN_RE, setGeneratedFileClaimer } from '../data.ts'
import {
  DEFAULT_PRINT_SETTINGS, MM, PRINT_LIMITS, docProblems, normaliseDoc, pageSizeMm,
  type GeneratedFile, type PrintRunInfo, type PrintSettings, type PrintTemplateDoc, type PrintTemplateFull, type PrintTemplateInfo, type RunAsMode, type TemplateKind,
} from '../../../src/platform/print.ts'
import type { FormatOptions } from '../../../src/platform/print-format.ts'
import { BindError, bindTemplate, type BindData, type Bound } from './bind.ts'
import { layoutDocument, PageLimitError, type Page } from './layout.ts'
import { pdfBuffer } from './pdf.ts'
import { DOCX_MIME, docxTags, fillDocx } from './docx.ts'

export const PRINT_BULK_JOB = 'print.bulk'
export const PRINT_SWEEP_JOB = 'print.sweep'
const PDF_MIME = 'application/pdf'

type Row = Record<string, unknown>
const q = (id: string) => `"${id}"`
const T = (t: string) => `${q(currentEnvironment().schema)}.${q(t)}`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const invalid = (m: string, f?: string) => new HttpError(422, 'invalid', m, f)
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
/** a jsonb value (pg parses it; a jsonb string arrives as a plain string) */
const jsonOf = <T>(v: unknown, d: T): T => (v === null || v === undefined ? d : (v as T))

export const newToken = (): string => `gen_${randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'x').slice(0, 24)}`

export interface GenerateOptions {
  /** what started it: app, api, flow:<id>, report:<id>, timeline, bulk, designer */
  source: string
  /** a client-chosen file token (GeneratePdf in apps: the formula gets it at once) */
  token?: string
  /** generate the draft (designer preview; makers only) */
  draft?: boolean
  /** the flow or report decided the identity (template run-as is not applied) */
  fixedIdentity?: boolean
  /** scheduled reports: rows given by the caller (the automatic layout) */
  presetDoc?: PrintTemplateDoc
  presetRows?: Record<string, unknown>[]
  presetName?: string
  kind?: 'single' | 'preview'
}

export interface GenerateResult extends GeneratedFile { bytes: Buffer; runId: string; pages: number; warnings: string[] }

export function createPrintService(services: CoreServices) {
  const db = () => {
    const d = services.state.db
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  let fixedTime: Date | null = null
  const now = () => fixedTime ?? new Date()

  /* ---------------------------------------------------------------- settings */

  async function settings(): Promise<PrintSettings> {
    const rows = await db().query<Row>(`SELECT k, v FROM ${T('ab_print_settings')}`)
    const m = new Map(rows.map((r) => [String(r.k), jsonOf<unknown>(r.v, null)]))
    const st = (m.get('settings') ?? {}) as Partial<PrintSettings>
    return { ...DEFAULT_PRINT_SETTINGS, ...st, letterhead: { ...DEFAULT_PRINT_SETTINGS.letterhead, ...(isObj(st.letterhead) ? st.letterhead : {}) } }
  }

  async function saveSettings(raw: unknown, who: UserContext): Promise<PrintSettings> {
    if (!who.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators change the letterhead and print settings.')
    const cur = await settings()
    const b = isObj(raw) ? raw : {}
    const lh = isObj(b.letterhead) ? b.letterhead : cur.letterhead
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)
    const logo = typeof lh.logo === 'string' && lh.logo ? lh.logo : undefined
    if (logo && (!/^data:image\/(png|jpeg);base64,/.test(logo) || logo.length > 700_000)) throw invalid('The logo is a PNG or JPEG of at most 500 KB.', 'letterhead.logo')
    const color = str(lh.color, 7)
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw invalid('Colours are written #rrggbb.', 'letterhead.color')
    const grouping = b.grouping === 'international' ? 'international' : b.grouping === 'indian' ? 'indian' : cur.grouping
    const dateFormat = str(b.dateFormat, 40) ?? cur.dateFormat
    if (!/^[dMyHhmsa\s\-/.,:'A-Za-z]{2,40}$/.test(dateFormat) || !/[dMy]/.test(dateFormat)) throw invalid('The date format uses d, M, y (for example dd-MM-yyyy).', 'dateFormat')
    const currency = str(b.currency, 3)?.toUpperCase()
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw invalid('The currency is a three-letter code such as INR.', 'currency')
    const tz = str(b.timeZone, 64)
    if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { throw invalid(`"${tz}" is not a time zone.`, 'timeZone') } }
    const lim = isObj(b.limits) ? b.limits : cur.limits ?? {}
    const clamp = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : undefined)
    const next: PrintSettings = {
      letterhead: {
        companyName: str(lh.companyName, 120) ?? '', ...(str(lh.address, 400) ? { address: str(lh.address, 400) } : {}), ...(str(lh.phone, 60) ? { phone: str(lh.phone, 60) } : {}),
        ...(str(lh.email, 120) ? { email: str(lh.email, 120) } : {}), ...(str(lh.website, 120) ? { website: str(lh.website, 120) } : {}), ...(str(lh.gstin, 30) ? { gstin: str(lh.gstin, 30) } : {}),
        ...(logo ? { logo } : {}), ...(color ? { color } : {}),
      },
      grouping, dateFormat, ...(currency ? { currency } : cur.currency ? { currency: cur.currency } : {}), ...(tz ? { timeZone: tz } : cur.timeZone ? { timeZone: cur.timeZone } : {}),
      limits: {
        ...(clamp(lim.maxPages, 1, PRINT_LIMITS.maxPages) ? { maxPages: clamp(lim.maxPages, 1, PRINT_LIMITS.maxPages) } : {}),
        ...(clamp(lim.maxRows, 1, PRINT_LIMITS.maxRows) ? { maxRows: clamp(lim.maxRows, 1, PRINT_LIMITS.maxRows) } : {}),
        ...(clamp(lim.timeoutSeconds, 5, 300) ? { timeoutSeconds: clamp(lim.timeoutSeconds, 5, 300) } : {}),
      },
    }
    await db().exec(`INSERT INTO ${T('ab_print_settings')} (k, v, modified_by, modified_on) VALUES ('settings', $1::jsonb, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, modified_by = EXCLUDED.modified_by, modified_on = EXCLUDED.modified_on`, [JSON.stringify(next), who.user.id])
    await services.meta.audit({ userId: who.user.id, action: 'print.settings', details: { companyName: next.letterhead.companyName, logo: !!next.letterhead.logo, grouping, dateFormat } }).catch(() => {})
    return next
  }

  async function formatOptions(st: PrintSettings): Promise<FormatOptions> {
    const sv = async (k: string) => (await services.collab?.settingValue(k).catch(() => null)) ?? null
    return { grouping: st.grouping, dateFormat: st.dateFormat, currency: st.currency || (await sv('DefaultCurrency')) || 'INR', timeZone: st.timeZone || (await sv('TimeZone')) || 'Asia/Kolkata' }
  }

  /* ---------------------------------------------------------------- templates */

  async function row(idOrName: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM ${T('ab_print_templates')} WHERE id = $1 OR lower(name) = lower($1) ORDER BY (id = $1) DESC LIMIT 1`, [idOrName]))[0] ?? null
  }
  const canEdit = (r: Row, who: UserContext | null) => !!who && (who.privileges.isAdmin || (who.privileges.isMaker && String(r.owner_id) === who.user.id) || (who.privileges.isMaker && !!r.built_in))
  async function info(r: Row, who: UserContext | null): Promise<PrintTemplateInfo> {
    const doc = jsonOf<PrintTemplateDoc>(r.doc, normaliseDoc({}))
    const pub = jsonOf<PrintTemplateDoc | null>(r.published, null)
    const owner = await services.meta.users.get(String(r.owner_id)).catch(() => null)
    return {
      id: String(r.id), name: String(r.name), ...(r.description ? { description: String(r.description) } : {}), kind: (r.kind === 'docx' ? 'docx' : 'pdf') as TemplateKind,
      table: r.table_name ? String(r.table_name) : null, status: Number(r.version) > 0 ? 'published' : 'draft', version: Number(r.version) || 0,
      dirty: !pub || JSON.stringify(pub) !== JSON.stringify(doc), runAs: jsonOf<RunAsMode>(r.run_as, 'caller'), ownerId: String(r.owner_id), ...(owner ? { ownerName: owner.name } : {}),
      ...(r.built_in ? { builtIn: String(r.built_in) } : {}), solutionId: r.solution_id ? String(r.solution_id) : null, modifiedOn: iso(r.modified_on)!, modifiedBy: r.modified_by ? String(r.modified_by) : null,
      ...(r.docx_name ? { docxFileName: String(r.docx_name) } : {}), canEdit: canEdit(r, who),
    }
  }
  async function full(r: Row, who: UserContext | null): Promise<PrintTemplateFull> {
    return { ...(await info(r, who)), doc: normaliseDoc(jsonOf(r.doc, {})), published: r.published ? normaliseDoc(jsonOf(r.published, {})) : null }
  }

  const tableOf = (doc: PrintTemplateDoc) => (doc.source.kind === 'record' || doc.source.kind === 'query' ? doc.source.table : null)

  async function checkDoc(raw: unknown): Promise<PrintTemplateDoc> {
    if (JSON.stringify(raw ?? null).length > PRINT_LIMITS.maxDocBytes) throw invalid(`A template is at most ${PRINT_LIMITS.maxDocBytes / 1048576} MB (images included).`, 'doc')
    const doc = normaliseDoc(raw)
    const problems = docProblems(doc)
    if (problems.length) throw Object.assign(invalid(`${problems[0].path ? problems[0].path + ': ' : ''}${problems[0].message}`, problems[0].path), { problems })
    const t = tableOf(doc)
    if (t && !(await findTable(t))) throw invalid(`There is no table "${t}" here.`, 'source.table')
    return doc
  }

  async function findTable(n: string): Promise<TableDef | undefined> {
    const all = await services.meta.tables.list()
    return all.find((t) => t.id === n || t.name === n) ?? all.find((t) => t.name.toLowerCase() === n.toLowerCase())
  }

  async function checkRunAs(raw: unknown, who: UserContext, prev: RunAsMode): Promise<RunAsMode> {
    if (raw === undefined) return prev
    if (raw === 'caller' || raw === null) return 'caller'
    if (isObj(raw) && typeof raw.serviceAccount === 'string') {
      if (!who.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators can make a template run as a service account.')
      const sa = await services.meta.users.get(raw.serviceAccount)
      if (!sa || toUserDef(sa).kind !== 'service' || sa.status === 'disabled') throw invalid('Choose an active service account.', 'runAs')
      return { serviceAccount: sa.id }
    }
    throw invalid('runAs is "caller" or {serviceAccount}.', 'runAs')
  }

  async function audit(who: UserContext | null, action: string, details: unknown) {
    try {
      await services.meta.audit({ userId: who?.user.id ?? null, action, details })
    } catch (e) {
      log('warn', `audit failed (${action}): ${errText(e)}`)
    }
  }

  async function create(raw: unknown, who: UserContext): Promise<PrintTemplateFull> {
    const b = isObj(raw) ? raw : {}
    const name = String(b.name ?? '').trim().slice(0, 120)
    if (!name) throw invalid('A template needs a name.', 'name')
    if (await row(name)) throw new HttpError(409, 'conflict', `A template named "${name}" already exists.`, 'name')
    const kind: TemplateKind = b.kind === 'docx' ? 'docx' : 'pdf'
    const doc = await checkDoc(b.doc ?? {})
    const runAs = await checkRunAs(b.runAs, who, 'caller')
    let docx: Buffer | null = null
    let docxName: string | null = null
    if (kind === 'docx') ({ docx, docxName } = checkDocx(b))
    const id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(b.id) && !(await row(b.id)) ? b.id : `ptpl_${randomBytes(8).toString('hex')}`
    await db().exec(
      `INSERT INTO ${T('ab_print_templates')} (id, name, description, kind, table_name, doc, run_as, docx, docx_name, built_in, owner_id, created_by, created_on, modified_by, modified_on)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $11, now(), $11, now())`,
      [id, name, typeof b.description === 'string' ? b.description.slice(0, 1000) : null, kind, tableOf(doc), JSON.stringify(doc), JSON.stringify(runAs), docx, docxName, typeof b.builtIn === 'string' ? b.builtIn : null, who.user.id],
    )
    await audit(who, 'print.template.create', { id, name, kind })
    if (typeof runAs === 'object') await audit(who, 'print.run_as_service', { id, serviceAccount: runAs.serviceAccount })
    if (b.publish === true) await publish(id, who, 'created')
    return full((await row(id))!, who)
  }

  function checkDocx(b: Record<string, unknown>): { docx: Buffer; docxName: string } {
    if (typeof b.docxBase64 !== 'string' || !b.docxBase64) throw invalid('Upload the Word template (.docx).', 'docx')
    const docx = Buffer.from(b.docxBase64, 'base64')
    if (docx.length > PRINT_LIMITS.docxMaxMB * 1048576) throw invalid(`A Word template is at most ${PRINT_LIMITS.docxMaxMB} MB.`, 'docx')
    try {
      docxTags(docx)
    } catch (e) {
      throw invalid((e as Error).message, 'docx')
    }
    return { docx, docxName: String(b.docxFileName ?? 'template.docx').replace(/[\\/]/g, '_').slice(0, 150) }
  }

  async function update(id: string, raw: unknown, who: UserContext): Promise<PrintTemplateFull> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    if (!canEdit(r, who)) throw new HttpError(403, 'denied', 'Only the owner, makers (built-in templates) and administrators can change this template.')
    const prevRunAs = jsonOf<RunAsMode>(r.run_as, 'caller')
    if (typeof prevRunAs === 'object' && !who.privileges.isAdmin) throw new HttpError(403, 'denied', 'This template runs as a service account: only an administrator can change it.')
    const b = isObj(raw) ? raw : {}
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 120) : String(r.name)
    if (!name) throw invalid('A template needs a name.', 'name')
    const other = await row(name)
    if (other && String(other.id) !== String(r.id)) throw new HttpError(409, 'conflict', `A template named "${name}" already exists.`, 'name')
    const doc = b.doc !== undefined ? await checkDoc(b.doc) : normaliseDoc(jsonOf(r.doc, {}))
    const runAs = await checkRunAs(b.runAs, who, prevRunAs)
    let docx = r.docx as Buffer | null
    let docxName = r.docx_name as string | null
    if (r.kind === 'docx' && b.docxBase64 !== undefined) ({ docx, docxName } = checkDocx(b))
    await db().exec(
      `UPDATE ${T('ab_print_templates')} SET name = $2, description = $3, table_name = $4, doc = $5::jsonb, run_as = $6::jsonb, docx = $7, docx_name = $8, modified_by = $9, modified_on = now() WHERE id = $1`,
      [r.id, name, b.description !== undefined ? (String(b.description).slice(0, 1000) || null) : r.description, tableOf(doc), JSON.stringify(doc), JSON.stringify(runAs), docx, docxName, who.user.id],
    )
    await audit(who, 'print.template.update', { id: r.id, name })
    if (JSON.stringify(runAs) !== JSON.stringify(prevRunAs) && typeof runAs === 'object') await audit(who, 'print.run_as_service', { id: r.id, serviceAccount: runAs.serviceAccount })
    if (b.publish === true) await publish(String(r.id), who, typeof b.note === 'string' ? b.note : null)
    return full((await row(String(r.id)))!, who)
  }

  async function publish(id: string, who: UserContext, note: string | null): Promise<PrintTemplateFull> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    if (!canEdit(r, who)) throw new HttpError(403, 'denied', 'You may not publish this template.')
    const doc = await checkDoc(jsonOf(r.doc, {}))
    const v = Number(r.version) + 1
    await db().tx(async (tx) => {
      await tx.exec(`INSERT INTO ${T('ab_print_template_versions')} (template_id, version, doc, docx, saved_by, saved_on, note) VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6)`, [r.id, v, JSON.stringify(doc), r.docx ?? null, who.user.id, note ? note.slice(0, 300) : null])
      await tx.exec(`UPDATE ${T('ab_print_templates')} SET published = $2::jsonb, version = $3, modified_by = $4, modified_on = now() WHERE id = $1`, [r.id, JSON.stringify(doc), v, who.user.id])
    })
    await audit(who, 'print.template.publish', { id: r.id, name: r.name, version: v })
    return full((await row(String(r.id)))!, who)
  }

  async function versions(id: string): Promise<{ version: number; savedBy: string | null; savedOn: string; note: string | null }[]> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    const rows = await db().query<Row>(`SELECT version, saved_by, saved_on, note FROM ${T('ab_print_template_versions')} WHERE template_id = $1 ORDER BY version DESC LIMIT 100`, [r.id])
    return rows.map((x) => ({ version: Number(x.version), savedBy: x.saved_by ? String(x.saved_by) : null, savedOn: iso(x.saved_on)!, note: x.note ? String(x.note) : null }))
  }

  /** an old version back into the draft (publish it to use it) */
  async function restore(id: string, version: number, who: UserContext): Promise<PrintTemplateFull> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    if (!canEdit(r, who)) throw new HttpError(403, 'denied', 'You may not change this template.')
    const v = (await db().query<Row>(`SELECT doc, docx FROM ${T('ab_print_template_versions')} WHERE template_id = $1 AND version = $2`, [r.id, version]))[0]
    if (!v) throw new HttpError(404, 'not-found', `There is no version ${version}.`)
    await db().exec(`UPDATE ${T('ab_print_templates')} SET doc = $2::jsonb, docx = COALESCE($3, docx), modified_by = $4, modified_on = now() WHERE id = $1`, [r.id, JSON.stringify(jsonOf(v.doc, {})), v.docx ?? null, who.user.id])
    await audit(who, 'print.template.restore', { id: r.id, version })
    return full((await row(String(r.id)))!, who)
  }

  async function copy(id: string, name: string, who: UserContext): Promise<PrintTemplateFull> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    return create({ name, description: r.description, kind: r.kind, doc: jsonOf(r.doc, {}), ...(r.docx ? { docxBase64: (r.docx as Buffer).toString('base64'), docxFileName: r.docx_name } : {}) }, who)
  }

  async function remove(id: string, who: UserContext): Promise<void> {
    const r = await row(id)
    if (!r) throw new HttpError(404, 'not-found', 'Template not found.')
    if (!canEdit(r, who)) throw new HttpError(403, 'denied', 'You may not delete this template.')
    await db().exec(`DELETE FROM ${T('ab_print_template_versions')} WHERE template_id = $1`, [r.id])
    await db().exec(`DELETE FROM ${T('ab_print_templates')} WHERE id = $1`, [r.id])
    await audit(who, 'print.template.delete', { id: r.id, name: r.name })
  }

  /* ---------------------------------------------------------------- identities */

  async function contextOf(userId: string): Promise<UserContext | null> {
    const u = await services.meta.users.get(userId)
    if (!u || u.status === 'disabled') return null
    const ok = (await services.environments.accessible(toUserDef(u))).some((e) => e.id === currentEnvironment().id)
    return ok ? services.security.forUser(toUserDef(u)) : null
  }

  function bindData(who: UserContext, tables: TableDef[], st: PrintSettings): BindData {
    const timeout = (st.limits?.timeoutSeconds ?? PRINT_LIMITS.timeoutSeconds) * 1000
    return {
      tables,
      visible: (t) => who.visibleDef(t),
      query: (t, plan) => services.data.queryV2(who, t, plan) as Promise<{ rows: Record<string, unknown>[]; nextCursor?: string | null }>,
      async attachment(id) {
        const a = await services.meta.attachments.get(id)
        if (!a || !(await visibleAttachment(services, who, a))) return null
        if (a.sizeBytes > (st.limits?.maxImageMB ?? PRINT_LIMITS.maxImageMB) * 1048576) return { bytes: Buffer.alloc(0), fileName: a.fileName }
        const chunks: Buffer[] = []
        for await (const c of services.attachments.open(a.storageKey) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
        return { bytes: Buffer.concat(chunks), fileName: a.fileName }
      },
      evalEnv: { tables, identity: who, data: services.data, limits: newLimits(timeout, st.limits?.maxRows ?? PRINT_LIMITS.maxRows, 100) },
      user: { id: who.user.id, name: who.user.name, email: who.user.email },
    }
  }

  /* ---------------------------------------------------------------- files */

  async function putFile(token: string, o: { bytes: Buffer; fileName: string; mime: string; pages?: number; runId: string; createdBy: string | null }): Promise<GeneratedFile> {
    const stored = await services.attachments.put(o.bytes)
    const expires = new Date(Date.now() + PRINT_LIMITS.fileTokenHours * 3600_000)
    await db().exec(
      `INSERT INTO ${T('ab_print_files')} (token, storage_key, file_name, mime, size_bytes, sha256, pages, state, run_id, created_by, created_on, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8, $9, now(), $10)
       ON CONFLICT (token) DO UPDATE SET storage_key = EXCLUDED.storage_key, file_name = EXCLUDED.file_name, mime = EXCLUDED.mime, size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, pages = EXCLUDED.pages, state = 'ready', error = NULL, run_id = EXCLUDED.run_id`,
      [token, stored.storageKey, o.fileName, o.mime, stored.sizeBytes, stored.sha256, o.pages ?? null, o.runId, o.createdBy, expires],
    )
    return { token, fileName: o.fileName, mime: o.mime, sizeBytes: stored.sizeBytes, url: fileUrl(token), ...(o.pages ? { pages: o.pages } : {}), runId: o.runId }
  }
  const fileUrl = (token: string) => `/api/v1/print/files/${token}?env=${encodeURIComponent(currentEnvironment().id)}`

  async function pendingFile(token: string, createdBy: string | null, fileName: string) {
    if (!GENERATED_TOKEN_RE.test(token)) throw invalid('The file token is malformed.', 'token')
    const cur = (await db().query<Row>(`SELECT created_by, state FROM ${T('ab_print_files')} WHERE token = $1`, [token]))[0]
    if (cur && String(cur.created_by ?? '') !== String(createdBy ?? '')) throw new HttpError(409, 'conflict', 'This file token belongs to someone else.')
    if (cur?.state === 'ready') return 'ready' as const
    await db().exec(
      `INSERT INTO ${T('ab_print_files')} (token, file_name, mime, state, created_by, created_on, expires_on) VALUES ($1, $2, $3, 'pending', $4, now(), now() + interval '1 day') ON CONFLICT (token) DO NOTHING`,
      [token, fileName, PDF_MIME, createdBy],
    )
    return 'pending' as const
  }

  async function fileRow(token: string): Promise<Row | null> {
    return (await db().query<Row>(`SELECT * FROM ${T('ab_print_files')} WHERE token = $1`, [token]))[0] ?? null
  }

  /** waits (at most 90 s) while a token is being generated */
  async function readyFile(token: string): Promise<Row> {
    const end = Date.now() + 90_000
    for (;;) {
      const f = await fileRow(token)
      if (f?.state === 'ready') return f
      if (f?.state === 'failed') throw invalid(`The generated file failed: ${String(f.error ?? 'unknown error')}`)
      if (Date.now() > end) throw invalid(f ? 'The file is still being generated; try again in a moment.' : 'There is no generated file with this token (they are kept 24 hours).')
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  async function fileBytes(f: Row): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const c of services.attachments.open(String(f.storage_key)) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }

  /** a generated file for someone: the creator, or an administrator */
  async function fileFor(token: string, who: UserContext | null): Promise<{ row: Row; bytes: Buffer }> {
    const f = await readyFile(token)
    if (who && !who.privileges.isAdmin && String(f.created_by ?? '') !== who.user.id) throw new HttpError(404, 'not-found', 'There is no generated file with this token.')
    return { row: f, bytes: await fileBytes(f) }
  }

  /** data.ts calls this for a gen_ token written into a file or image column (Patch(..., {File: GeneratePdf(...)})) */
  setGeneratedFileClaimer(async (ctx, def, col: ColumnDef, rowId, token) => {
    const f = await readyFile(token).catch((e: Error) => { throw new HttpError(422, 'invalid', `${col.displayName || col.name}: ${e.message}`, col.name) })
    if (!ctx.privileges.isAdmin && String(f.created_by ?? '') !== ctx.user.id) throw new HttpError(422, 'invalid', `${col.displayName || col.name}: there is no generated file with this token.`, col.name)
    if (col.type === 'image' && !String(f.mime).startsWith('image/')) throw new HttpError(422, 'invalid', `${col.displayName || col.name} holds images; a ${String(f.file_name)} cannot go there.`, col.name)
    // a copy for the cell (the token stays usable until it expires)
    const stored = await services.attachments.put(await fileBytes(f))
    const rec: AttachmentRecord = {
      id: services.uid('att'), tableId: def.id, column: col.name, rowId, fileName: String(f.file_name), mime: String(f.mime),
      sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, createdBy: ctx.user.id, createdOn: services.now(),
    }
    await services.meta.attachments.insert(rec)
    if (def.id === 'sys_documents') {
      // a document's file becomes a version once the document row exists (it is being inserted right now)
      const link = () => { if (!laterLinks.delete(rec.id)) return Promise.resolve(); return services.collab?.attachmentAdded(rec).catch((e) => services.collab?.log('attachment link', e)) ?? Promise.resolve() }
      laterLinks.set(rec.id, link)
      const env = currentEnvironment().id
      setTimeout(() => {
        void runInEnvironment(env, async () => { if (await waitRow(def, rowId)) await link() }).catch(() => {})
      }, 300).unref?.()
    } else await services.collab?.attachmentAdded(rec).catch((e) => services.collab?.log('attachment link', e))
    return rec.id
  })
  const laterLinks = new Map<string, () => Promise<unknown>>()
  /** true once the row exists; false when it never came (a failed insert) or the server is shutting down */
  async function waitRow(def: TableDef, rowId: string): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      try {
        if (!services.ready()) return false
        if (await services.data.internals.findRow(def, rowId)) return true
      } catch {
        return false
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  /* ---------------------------------------------------------------- generation */

  async function template(idOrName: string): Promise<Row> {
    const r = await row(idOrName)
    if (!r) throw new HttpError(404, 'not-found', `There is no print template "${idOrName.slice(0, 80)}".`)
    return r
  }

  /** the identity a generation reads as: the template's service account, else the caller (flows and reports decide themselves) */
  async function identityFor(r: Row, caller: UserContext, o: GenerateOptions): Promise<{ who: UserContext; label: string }> {
    const runAs = jsonOf<RunAsMode>(r.run_as, 'caller')
    if (o.fixedIdentity || runAs === 'caller' || o.draft) return { who: caller, label: o.fixedIdentity ? `${caller.user.name} (${o.source})` : caller.user.name }
    const sa = await contextOf(runAs.serviceAccount)
    if (!sa) throw new HttpError(422, 'invalid', 'The service account of this template is missing, disabled or has no access to this environment.')
    await audit(caller, 'print.generate_as_service', { template: r.id, serviceAccount: runAs.serviceAccount })
    return { who: sa, label: `service account ${sa.user.name} for ${caller.user.name}` }
  }

  async function renderPdf(doc: PrintTemplateDoc, bound: Bound, st: PrintSettings, author: string, createdOn: Date): Promise<{ bytes: Buffer; pages: Page[] }> {
    const [w, h] = pageSizeMm(doc.page)
    const m = doc.page.margins
    const pages = layoutDocument({
      pageW: w * MM, pageH: h * MM, margins: { top: m.top * MM, right: m.right * MM, bottom: m.bottom * MM, left: m.left * MM },
      style: { fontSize: doc.styles.fontSize, color: doc.styles.color, accent: doc.styles.accent, headingColor: doc.styles.headingColor, tableStyle: doc.styles.tableStyle, lineHeight: doc.styles.lineHeight ?? 1.3 },
      body: bound.body, header: bound.header, footer: bound.footer,
      images: new Map([...bound.images].map(([k, v]) => [k, { width: v.width, height: v.height }])), maxPages: st.limits?.maxPages ?? PRINT_LIMITS.maxPages,
    })
    const bytes = await pdfBuffer({ pageW: w * MM, pageH: h * MM, pages, images: new Map([...bound.images].map(([k, v]) => [k, v.bytes])), meta: { title: bound.title, author, subject: bound.subject, keywords: bound.keywords, createdOn } })
    return { bytes, pages }
  }

  function withTimeout<X>(p: Promise<X>, seconds: number): Promise<X> {
    let t: NodeJS.Timeout | undefined
    return Promise.race([p, new Promise<X>((_, rej) => { t = setTimeout(() => rej(new HttpError(422, 'invalid', `Generating the document took longer than ${seconds} s (the limit of this server); print fewer rows.`)), seconds * 1000) })]).finally(() => clearTimeout(t))
  }

  async function startRun(o: { r: Row | null; name: string; version: number; kind: string; userId: string | null; runAs: string; recordIds: string[]; source: string }): Promise<string> {
    const id = `prun_${randomBytes(10).toString('hex')}`
    await db().exec(
      `INSERT INTO ${T('ab_print_runs')} (id, template_id, template_name, version, kind, status, user_id, run_as, record_ids, source, started_on) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8::jsonb, $9, now())`,
      [id, o.r ? String(o.r.id) : 'auto', o.name, o.version, o.kind, o.userId, o.runAs, JSON.stringify(o.recordIds.slice(0, 2000)), o.source.slice(0, 200)],
    )
    return id
  }
  async function endRun(id: string, o: { status: 'succeeded' | 'failed'; pages?: number; bytes?: number; ms: number; warnings?: string[]; error?: string; token?: string | null }) {
    await db().exec(`UPDATE ${T('ab_print_runs')} SET status = $2, pages = $3, bytes = $4, ms = $5, warnings = $6::jsonb, error = $7, file_token = $8, finished_on = now() WHERE id = $1`,
      [id, o.status, o.pages ?? 0, o.bytes ?? 0, o.ms, JSON.stringify((o.warnings ?? []).slice(0, 200)), o.error ? o.error.slice(0, 1000) : null, o.token ?? null])
  }

  /** one document for one record (or for the template's query/formula source) */
  async function generate(idOrName: string | null, recordId: string | undefined, caller: UserContext, o: GenerateOptions): Promise<GenerateResult> {
    const r = idOrName ? await template(idOrName) : null
    if (o.draft && r && !canEdit(r, caller) && !caller.privileges.isMaker) throw new HttpError(403, 'denied', 'Only makers preview drafts.')
    const kind = (r?.kind === 'docx' ? 'docx' : 'pdf') as TemplateKind
    const docRaw = o.presetDoc ?? (r ? (o.draft ? r.doc : r.published) : null)
    if (!docRaw) throw new HttpError(422, 'invalid', `The template "${String(r?.name)}" is not published yet; publish it in Print templates.`)
    const doc = normaliseDoc(jsonOf(docRaw, {}))
    const name = o.presetName ?? String(r?.name ?? 'Report')
    const { who, label } = r ? await identityFor(r, caller, o) : { who: caller, label: caller.user.name }
    const st = await settings()
    const started = Date.now()
    const version = o.draft ? 0 : Number(r?.version ?? 0)
    const runId = await startRun({ r, name, version, kind: o.kind ?? (o.draft ? 'preview' : 'single'), userId: caller.user.id, runAs: label, recordIds: recordId ? [recordId] : [], source: o.source })
    const token = o.token ?? newToken()
    if (o.token) await pendingFile(o.token, caller.user.id, name)
    try {
      const out = await withTimeout((async () => {
        const tables = await services.meta.tables.list()
        const fmt = await formatOptions(st)
        const createdOn = now()
        const data = bindData(who, tables, st)
        const bound = await bindTemplate({
          doc, recordId, fmt, letterhead: st.letterhead, now: createdOn, templateName: name, maxRows: st.limits?.maxRows ?? PRINT_LIMITS.maxRows, maxImageBytes: (st.limits?.maxImageMB ?? PRINT_LIMITS.maxImageMB) * 1048576,
          ...(o.presetRows ? { presetRows: o.presetRows } : {}),
        }, data)
        if (kind === 'docx') {
          const warnings = [...bound.warnings]
          const tpl = (o.draft ? r!.docx : (await db().query<Row>(`SELECT docx FROM ${T('ab_print_template_versions')} WHERE template_id = $1 AND version = $2`, [r!.id, version]))[0]?.docx ?? r!.docx) as Buffer | null
          if (!tpl) throw new HttpError(422, 'invalid', 'The Word file of this template is missing.')
          const bytes = fillDocx(Buffer.from(tpl), bound.scope, bound.engine, bound.fmt, (m) => warnings.push(m))
          return { bytes, pages: 0, warnings, fileName: `${bound.fileName}.docx`, mime: DOCX_MIME }
        }
        const pdf = await renderPdf(doc, bound, st, who.user.name, createdOn)
        return { bytes: pdf.bytes, pages: pdf.pages.length, warnings: bound.warnings, fileName: `${bound.fileName}.pdf`, mime: PDF_MIME }
      })(), st.limits?.timeoutSeconds ?? PRINT_LIMITS.timeoutSeconds)
      const file = await putFile(token, { bytes: out.bytes, fileName: out.fileName, mime: out.mime, pages: out.pages, runId, createdBy: caller.user.id })
      await endRun(runId, { status: 'succeeded', pages: out.pages, bytes: out.bytes.length, ms: Date.now() - started, warnings: out.warnings, token })
      return { ...file, bytes: out.bytes, runId, pages: out.pages, warnings: out.warnings }
    } catch (e) {
      const he = e instanceof HttpError ? e : e instanceof BindError ? new HttpError(e.status, e.status === 404 ? 'not-found' : 'invalid', e.message) : e instanceof PageLimitError ? new HttpError(422, 'invalid', e.message) : null
      const msg = he?.message ?? errText(e)
      await endRun(runId, { status: 'failed', ms: Date.now() - started, error: msg }).catch(() => {})
      if (o.token) await db().exec(`UPDATE ${T('ab_print_files')} SET state = 'failed', error = $2 WHERE token = $1 AND state = 'pending'`, [o.token, msg.slice(0, 500)]).catch(() => {})
      if (he) throw he
      log('error', `print: ${errText(e)}`)
      throw new HttpError(500, 'storage', `The document could not be generated: ${msg}`)
    }
  }

  /* ---------------------------------------------------------------- the record's Documents */

  /** generates and stores the PDF in the record's Documents (number from a sequence when given) */
  async function toDocuments(idOrName: string, recordId: string, caller: UserContext, o: { numberSequence?: string; source: string; fixedIdentity?: boolean; folder?: string }): Promise<{ documentId: string; attachmentId: string; name: string; file: GenerateResult }> {
    const r = await template(idOrName)
    const doc = normaliseDoc(jsonOf(r.published ?? r.doc, {}))
    if (doc.source.kind !== 'record') throw invalid('Only templates with a record source can be stored with a record.')
    const t = await findTable(doc.source.table)
    if (!t) throw invalid(`There is no table "${doc.source.table}".`)
    const docs = await findTable('sys_documents')
    if (!docs) throw invalid('Documents are not available in this environment.')
    const file = await generate(idOrName, recordId, caller, { source: o.source, fixedIdentity: o.fixedIdentity })
    let name = file.fileName
    if (o.numberSequence) {
      const n = await services.collab.nextNumber(o.numberSequence)
      name = `${n} ${file.fileName}`
    }
    const created = await services.data.insert(caller, docs, {
      Name: name.slice(0, 250), FolderPath: o.folder ?? `/${String(r.name).replace(/[\\/]/g, '-')}`, regardingTable: t.id, regardingId: recordId.length === 36 ? recordId.toLowerCase() : recordId, File: file.token,
    }) as Record<string, unknown>
    const attachmentId = String(created.File ?? '')
    await laterLinks.get(attachmentId)?.()
    await audit(caller, 'print.document', { template: r.id, recordId, documentId: created.id, name })
    return { documentId: String(created.id), attachmentId, name, file }
  }

  /* ---------------------------------------------------------------- bulk */

  async function startBulk(idOrName: string, recordIds: string[], mode: 'zip' | 'merged', caller: UserContext, source = 'bulk'): Promise<{ runId: string; jobId: string }> {
    const r = await template(idOrName)
    if (!r.published) throw invalid('Publish the template before generating many documents.')
    const ids = [...new Set(recordIds.map(String).filter(Boolean))]
    if (!ids.length) throw invalid('Choose at least one record.', 'recordIds')
    if (ids.length > PRINT_LIMITS.bulkMaxRecords) throw invalid(`At most ${PRINT_LIMITS.bulkMaxRecords} records at a time.`, 'recordIds')
    if (mode === 'merged' && r.kind === 'docx') throw invalid('Word documents cannot be merged; choose a zip file.', 'mode')
    const runId = await startRun({ r, name: String(r.name), version: Number(r.version), kind: 'bulk', userId: caller.user.id, runAs: caller.user.name, recordIds: ids, source })
    await db().exec(`UPDATE ${T('ab_print_runs')} SET progress = $2::jsonb WHERE id = $1`, [runId, JSON.stringify({ done: 0, total: ids.length })])
    const job = await services.kernel.jobs.enqueue(PRINT_BULK_JOB, { runId, templateId: String(r.id), recordIds: ids, mode, userId: caller.user.id }, { createdBy: caller.user.id, correlationId: `print:${runId}` })
    await audit(caller, 'print.bulk', { template: r.id, records: ids.length, mode })
    return { runId, jobId: job.id }
  }

  async function runBulk(p: { runId: string; templateId: string; recordIds: string[]; mode: 'zip' | 'merged'; userId: string }): Promise<unknown> {
    const caller = await contextOf(p.userId)
    if (!caller) throw new JobError('The person who started this is disabled or has no access any more.', { retry: false })
    const run = (await db().query<Row>(`SELECT * FROM ${T('ab_print_runs')} WHERE id = $1`, [p.runId]))[0]
    if (!run) throw new JobError('The run no longer exists.', { retry: false })
    if (run.status !== 'running') return { skipped: 'already finished' }
    const started = Date.now()
    const warnings: string[] = []
    const r = await template(p.templateId)
    const st = await settings()
    const progress = async (done: number) => db().exec(`UPDATE ${T('ab_print_runs')} SET progress = $2::jsonb WHERE id = $1`, [p.runId, JSON.stringify({ done, total: p.recordIds.length })])
    try {
      let bytes: Buffer
      let fileName: string
      let pageCount = 0
      if (p.mode === 'merged') {
        const doc = normaliseDoc(jsonOf(r.published, {}))
        const { who } = await identityFor(r, caller, { source: 'bulk' })
        const tables = await services.meta.tables.list()
        const fmt = await formatOptions(st)
        const allPages: Page[] = []
        const imgs = new Map<string, Buffer>()
        for (const [i, id] of p.recordIds.entries()) {
          try {
            const bound = await bindTemplate({ doc, recordId: id, fmt, letterhead: st.letterhead, now: now(), templateName: String(r.name), maxRows: st.limits?.maxRows ?? PRINT_LIMITS.maxRows, maxImageBytes: PRINT_LIMITS.maxImageMB * 1048576 }, bindData(who, tables, st))
            const [w, h] = pageSizeMm(doc.page)
            const m = doc.page.margins
            const pages = layoutDocument({
              pageW: w * MM, pageH: h * MM, margins: { top: m.top * MM, right: m.right * MM, bottom: m.bottom * MM, left: m.left * MM },
              style: { fontSize: doc.styles.fontSize, color: doc.styles.color, accent: doc.styles.accent, headingColor: doc.styles.headingColor, tableStyle: doc.styles.tableStyle, lineHeight: doc.styles.lineHeight ?? 1.3 },
              body: bound.body, header: bound.header, footer: bound.footer, images: new Map([...bound.images].map(([k, v]) => [k, { width: v.width, height: v.height }])), maxPages: PRINT_LIMITS.maxPages,
            })
            allPages.push(...pages)
            for (const [k, v] of bound.images) imgs.set(k, v.bytes)
            warnings.push(...bound.warnings.map((x) => `${id}: ${x}`))
            if (allPages.length > PRINT_LIMITS.maxPages * 4) throw new PageLimitError('The merged document is too long; use a zip file instead.')
          } catch (e) {
            if (e instanceof PageLimitError) throw e
            warnings.push(`${id}: ${(e as Error).message}`)
          }
          if (i % 10 === 9) await progress(i + 1)
        }
        if (!allPages.length) throw new Error('No record could be printed.')
        const [w, h] = pageSizeMm(doc.page)
        bytes = await pdfBuffer({ pageW: w * MM, pageH: h * MM, pages: allPages, images: imgs, meta: { title: String(r.name), author: caller.user.name, createdOn: now() } })
        pageCount = allPages.length
        fileName = `${String(r.name)} (${p.recordIds.length}).pdf`
      } else {
        const zip = new ZipStream()
        const chunks: Buffer[] = []
        const names = new Set<string>()
        let ok = 0
        for (const [i, id] of p.recordIds.entries()) {
          try {
            const g = await generate(p.templateId, id, caller, { source: `bulk:${p.runId}` })
            let n = g.fileName
            for (let k = 2; names.has(n.toLowerCase()); k++) n = g.fileName.replace(/(\.[a-z]+)$/i, ` (${k})$1`)
            names.add(n.toLowerCase())
            for await (const c of zip.entry(n, (async function* () { yield g.bytes })())) chunks.push(c)
            pageCount += g.pages
            ok++
            warnings.push(...g.warnings.map((x) => `${id}: ${x}`))
          } catch (e) {
            warnings.push(`${id}: ${(e as Error).message}`)
          }
          if (i % 5 === 4 || i === p.recordIds.length - 1) await progress(i + 1)
        }
        if (!ok) throw new Error(`No record could be printed. ${warnings[0] ?? ''}`)
        for (const c of zip.finish()) chunks.push(c)
        bytes = Buffer.concat(chunks)
        fileName = `${String(r.name)} (${ok}).zip`
      }
      const token = newToken()
      await putFile(token, { bytes, fileName, mime: p.mode === 'merged' ? PDF_MIME : 'application/zip', pages: pageCount, runId: p.runId, createdBy: caller.user.id })
      await progress(p.recordIds.length)
      await endRun(p.runId, { status: 'succeeded', pages: pageCount, bytes: bytes.length, ms: Date.now() - started, warnings, token })
      await services.notifications?.notify({ userIds: [caller.user.id] }, { kind: 'system', title: `${String(r.name)}: ${p.recordIds.length} documents are ready`, body: fileName, link: '#printtemplates', environmentId: currentEnvironment().id, source: `print:${p.runId}` } as never).catch(() => {})
      return { token, pages: pageCount }
    } catch (e) {
      await endRun(p.runId, { status: 'failed', ms: Date.now() - started, warnings, error: errText(e) })
      throw new JobError(errText(e), { retry: false })
    }
  }

  services.kernel.jobs.register<{ runId: string; templateId: string; recordIds: string[]; mode: 'zip' | 'merged'; userId: string }>({
    type: PRINT_BULK_JOB,
    description: 'Generates documents from a print template for many records (one zip file, or one merged PDF).',
    parse(raw) {
      if (!isObj(raw) || typeof raw.runId !== 'string' || typeof raw.templateId !== 'string' || !Array.isArray(raw.recordIds) || typeof raw.userId !== 'string') throw new JobError('malformed print job', { retry: false })
      return { runId: raw.runId, templateId: raw.templateId, recordIds: raw.recordIds.map(String), mode: raw.mode === 'merged' ? 'merged' : 'zip', userId: raw.userId }
    },
    maxAttempts: 1,
    concurrency: 1,
    timeoutMs: 30 * 60_000,
    handler: (p) => runBulk(p),
  })

  services.kernel.jobs.register<Record<string, never>>({
    type: PRINT_SWEEP_JOB,
    schedule: 'custom',
    description: 'Removes generated documents (print templates) older than 24 hours that no record kept.',
    concurrency: 1,
    parse: () => ({}),
    async handler() {
      const gone = await db().query<Row>(`DELETE FROM ${T('ab_print_files')} WHERE expires_on < now() RETURNING storage_key`)
      for (const g of gone) if (g.storage_key) await services.attachments.remove(String(g.storage_key)).catch(() => {})
      await db().exec(`DELETE FROM ${T('ab_print_runs')} WHERE started_on < now() - interval '90 days'`)
      return { removed: gone.length }
    },
  })

  /* ---------------------------------------------------------------- runs */

  async function runs(o: { templateId?: string; userId?: string; limit?: number }): Promise<PrintRunInfo[]> {
    const rows = await db().query<Row>(
      `SELECT * FROM ${T('ab_print_runs')} WHERE ($1::text IS NULL OR template_id = $1) AND ($2::text IS NULL OR user_id = $2) ORDER BY started_on DESC LIMIT $3`,
      [o.templateId ?? null, o.userId ?? null, Math.min(200, o.limit ?? 50)],
    )
    return rows.map(runInfo)
  }
  const runInfo = (x: Row): PrintRunInfo => ({
    id: String(x.id), templateId: String(x.template_id), templateName: String(x.template_name), version: Number(x.version), kind: x.kind as PrintRunInfo['kind'], status: x.status as PrintRunInfo['status'],
    userId: x.user_id ? String(x.user_id) : null, runAs: String(x.run_as), recordIds: jsonOf<string[]>(x.record_ids, []), pages: Number(x.pages), bytes: Number(x.bytes), ms: Number(x.ms),
    warnings: jsonOf<string[]>(x.warnings, []), error: x.error ? String(x.error) : null, ...(x.progress ? { progress: jsonOf(x.progress, { done: 0, total: 0 }) } : {}), fileToken: x.file_token ? String(x.file_token) : null,
    startedOn: iso(x.started_on)!, finishedOn: iso(x.finished_on), source: String(x.source),
  })
  async function run(id: string): Promise<PrintRunInfo | null> {
    const x = (await db().query<Row>(`SELECT * FROM ${T('ab_print_runs')} WHERE id = $1`, [id]))[0]
    return x ? runInfo(x) : null
  }

  async function list(who: UserContext, o: { table?: string } = {}): Promise<PrintTemplateInfo[]> {
    const rows = await db().query<Row>(`SELECT * FROM ${T('ab_print_templates')} ORDER BY lower(name)`)
    const out: PrintTemplateInfo[] = []
    for (const r of rows) {
      // people who are not makers see published templates only (the ones they can print)
      if (!who.privileges.isMaker && !who.privileges.isAdmin && !r.published) continue
      if (o.table && String(r.table_name ?? '').toLowerCase() !== o.table.toLowerCase()) {
        const t = await findTable(o.table)
        if (!t || String(r.table_name ?? '').toLowerCase() !== t.name.toLowerCase()) continue
      }
      out.push(await info(r, who))
    }
    return out
  }

  return {
    settings, saveSettings, formatOptions, list, get: async (id: string, who: UserContext | null) => { const r = await row(id); return r ? full(r, who) : null },
    create, update, publish, versions, restore, copy, remove, generate, toDocuments, startBulk, runBulk, runs, run, fileFor, readyFile, fileRow, fileBytes, pendingFile, findTable,
    setFixedTime(d: Date | null) { fixedTime = d },
    /** the table of a template's record or query source (flows: output to a file column of the record) */
    async tableOfTemplate(idOrName: string): Promise<TableDef> {
      const r = await template(idOrName)
      const d = normaliseDoc(jsonOf(r.published ?? r.doc, {}))
      const t = d.source.kind === 'record' || d.source.kind === 'query' ? await findTable(d.source.table) : undefined
      if (!t) throw invalid('The template has no record source, so the document cannot be put into a record.')
      return t
    },
    /** solutions (alm.ts): the raw row */
    raw: row,
    tokenHash: (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12),
  }
}

export type PrintService = ReturnType<typeof createPrintService>
