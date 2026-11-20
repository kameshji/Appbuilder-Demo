/**
 * HTTP API of print templates (docs/dev/data-api.md "Print templates"; P2 package B).
 *
 *   GET    /print/catalog                     blocks, functions, built-ins, limits (the designer)
 *   GET    /print/settings                    letterhead and formats      PUT (administrators, audited)
 *   GET    /print/templates[?table=]          makers: all; others: published ones
 *   POST   /print/templates                   create (makers; design)     POST /print/builtins {key, table?, name?}
 *   GET    /print/templates/:id               PUT (save the draft; publish: true publishes)   DELETE
 *   POST   /print/templates/:id/publish       GET .../versions   POST .../restore {version}   POST .../copy {name}
 *   POST   /print/templates/:id/preview       {recordId, doc?} -> the draft (or an unsaved doc) as PDF bytes (makers)
 *   GET    /print/templates/:id/pdf?recordId= the published template for a record, inline (Print() opens it)
 *   POST   /print/generate                    {template, recordId?, token?} -> GeneratedFile (GeneratePdf, GenerateDocx)
 *   POST   /print/templates/:id/documents     {recordId, numberSequence?} -> stored in the record's Documents
 *   POST   /print/bulk                        {template, recordIds, mode: zip | merged} -> {runId, jobId}
 *   GET    /print/runs[?templateId=]          the generation log (makers: all; others: their own)   GET /print/runs/:id
 *   GET    /print/files/:token[?download=1]   a generated file (its creator, or an administrator)
 */
import type { ApiRouter } from '../router.ts'
import type { CoreServices } from '../services.ts'
import type { Ctx, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { BLOCK_CATALOGUE, PRINT_LIMITS, docProblems, emptyDoc, normaliseDoc } from '../../../src/platform/print.ts'
import { PRINT_FUNCTIONS } from './bind.ts'
import { BUILTINS, builtinDoc } from './builtins.ts'
import type { PrintService } from './service.ts'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const disposition = (kind: 'inline' | 'attachment', name: string) => `${kind}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

function fileResponse(bytes: Buffer, mime: string, name: string, download: boolean, extra: Record<string, string> = {}) {
  return {
    raw: true as const,
    headers: {
      'Content-Type': mime, 'Content-Length': String(bytes.length), 'Content-Disposition': disposition(download ? 'attachment' : 'inline', name),
      // our own PDFs (no scripts: the engine writes none) open in the browser's viewer, which a sandboxed document blocks;
      // anything else is sandboxed
      'Content-Security-Policy': mime === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extra,
    },
    body: bytes,
  }
}

export function printRoutes(router: ApiRouter, services: CoreServices, print: () => PrintService): void {
  const me = (ctx: Ctx): UserContext => ctx.user!
  const body = (ctx: Ctx) => (isObj(ctx.body) ? ctx.body : {})

  router.add('GET', '/print/catalog', async () => ({
    blocks: BLOCK_CATALOGUE, functions: PRINT_FUNCTIONS, builtins: BUILTINS, limits: PRINT_LIMITS, empty: emptyDoc(),
  }), { auth: 'user' })

  router.add('GET', '/print/settings', async () => ({ settings: await print().settings() }), { auth: 'user' })
  router.add('PUT', '/print/settings', async (ctx) => ({ settings: await print().saveSettings(ctx.body, me(ctx)) }), { auth: 'admin', maxBodyMB: 2 })

  router.add('GET', '/print/templates', async (ctx) => ({ items: await print().list(me(ctx), { table: ctx.query.get('table') ?? undefined }) }), { auth: 'user' })
  router.add('POST', '/print/templates', async (ctx) => ({ template: await print().create(ctx.body, me(ctx)) }), { auth: 'maker', design: true, maxBodyMB: 16 })
  router.add('POST', '/print/builtins', async (ctx) => {
    const b = body(ctx)
    const info = BUILTINS.find((x) => x.key === b.key)
    if (!info) throw new HttpError(422, 'invalid', 'Choose a built-in template.', 'key')
    const t = typeof b.table === 'string' && b.table ? await print().findTable(b.table) : undefined
    if (info.needsTable && !t) throw new HttpError(422, 'invalid', 'Choose the table.', 'table')
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : info.needsTable ? `${info.name}: ${t!.displayName || t!.name}` : info.name
    return { template: await print().create({ name, description: info.description, doc: builtinDoc(info.key, t), builtIn: info.key, publish: b.publish !== false }, me(ctx)) }
  }, { auth: 'maker', design: true })

  router.add('GET', '/print/templates/:id', async (ctx) => {
    const t = await print().get(ctx.params.id, me(ctx))
    if (!t) throw new HttpError(404, 'not-found', 'Template not found.')
    const u = me(ctx)
    if (!u.privileges.isMaker && !u.privileges.isAdmin) {
      if (!t.published) throw new HttpError(404, 'not-found', 'Template not found.')
      return { template: { ...t, doc: t.published } }
    }
    return { template: t }
  }, { auth: 'user' })
  router.add('PUT', '/print/templates/:id', async (ctx) => ({ template: await print().update(ctx.params.id, ctx.body, me(ctx)) }), { auth: 'maker', design: true, maxBodyMB: 16 })
  router.add('DELETE', '/print/templates/:id', async (ctx) => { await print().remove(ctx.params.id, me(ctx)); return { ok: true } }, { auth: 'maker', design: true })
  router.add('POST', '/print/templates/:id/publish', async (ctx) => ({ template: await print().publish(ctx.params.id, me(ctx), typeof body(ctx).note === 'string' ? String(body(ctx).note) : null) }), { auth: 'maker', design: true })
  router.add('GET', '/print/templates/:id/versions', async (ctx) => ({ items: await print().versions(ctx.params.id) }), { auth: 'maker' })
  router.add('POST', '/print/templates/:id/restore', async (ctx) => ({ template: await print().restore(ctx.params.id, Number(body(ctx).version), me(ctx)) }), { auth: 'maker', design: true })
  router.add('POST', '/print/templates/:id/copy', async (ctx) => {
    const name = String(body(ctx).name ?? '').trim()
    if (!name) throw new HttpError(422, 'invalid', 'Name the copy.', 'name')
    return { template: await print().copy(ctx.params.id, name, me(ctx)) }
  }, { auth: 'maker', design: true })

  router.add('POST', '/print/templates/:id/preview', async (ctx) => {
    const b = body(ctx)
    const t = await print().get(ctx.params.id, me(ctx))
    if (!t) throw new HttpError(404, 'not-found', 'Template not found.')
    const g = await print().generate(ctx.params.id, typeof b.recordId === 'string' && b.recordId ? b.recordId : undefined, me(ctx), {
      source: 'designer', draft: true, kind: 'preview', ...(isObj(b.doc) ? { presetDoc: (await checkPreviewDoc(b.doc)) } : {}),
    })
    return fileResponse(g.bytes, g.mime, g.fileName, false, { 'X-Print-Pages': String(g.pages), 'X-Print-Warnings': encodeURIComponent(JSON.stringify(g.warnings.slice(0, 30))), 'X-Print-Run': g.runId, 'X-Print-Token': g.token })
  }, { auth: 'maker', maxBodyMB: 16 })
  const checkPreviewDoc = async (doc: Record<string, unknown>) => {
    const d = normaliseDoc(doc)
    const p = docProblems(d)
    if (p.length) throw new HttpError(422, 'invalid', `${p[0].path ? p[0].path + ': ' : ''}${p[0].message}`, p[0].path)
    return d
  }

  router.add('GET', '/print/templates/:id/pdf', async (ctx) => {
    const g = await print().generate(ctx.params.id, ctx.query.get('recordId') ?? undefined, me(ctx), { source: ctx.query.get('source') === 'app' ? 'app' : 'api' })
    return fileResponse(g.bytes, g.mime, g.fileName, ctx.query.get('download') === '1', { 'X-Print-Token': g.token })
  }, { auth: 'user' })

  router.add('POST', '/print/generate', async (ctx) => {
    const b = body(ctx)
    const tpl = String(b.template ?? '')
    if (!tpl) throw new HttpError(422, 'invalid', 'Name the template.', 'template')
    const g = await print().generate(tpl, typeof b.recordId === 'string' && b.recordId ? b.recordId : undefined, me(ctx), {
      source: b.source === 'app' ? 'app' : 'api', ...(typeof b.token === 'string' ? { token: b.token } : {}),
    })
    const { bytes: _b, ...file } = g
    void _b
    return { file }
  }, { auth: 'user' })

  router.add('POST', '/print/templates/:id/documents', async (ctx) => {
    const b = body(ctx)
    if (typeof b.recordId !== 'string' || !b.recordId) throw new HttpError(422, 'invalid', 'Choose the record.', 'recordId')
    const r = await print().toDocuments(ctx.params.id, b.recordId, me(ctx), { source: 'timeline', ...(typeof b.numberSequence === 'string' && b.numberSequence ? { numberSequence: b.numberSequence } : {}) })
    const { bytes: _b, ...file } = r.file
    void _b
    return { documentId: r.documentId, attachmentId: r.attachmentId, name: r.name, file }
  }, { auth: 'user' })

  router.add('POST', '/print/bulk', async (ctx) => {
    const b = body(ctx)
    if (!Array.isArray(b.recordIds)) throw new HttpError(422, 'invalid', 'recordIds must be a list.', 'recordIds')
    return print().startBulk(String(b.template ?? ''), b.recordIds.map(String), b.mode === 'merged' ? 'merged' : 'zip', me(ctx))
  }, { auth: 'user' })

  router.add('GET', '/print/runs', async (ctx) => {
    const u = me(ctx)
    const all = u.privileges.isMaker || u.privileges.isAdmin
    return { items: await print().runs({ templateId: ctx.query.get('templateId') ?? undefined, ...(all ? {} : { userId: u.user.id }) }) }
  }, { auth: 'user' })
  router.add('GET', '/print/runs/:id', async (ctx) => {
    const u = me(ctx)
    const r = await print().run(ctx.params.id)
    if (!r || (!u.privileges.isMaker && !u.privileges.isAdmin && r.userId !== u.user.id)) throw new HttpError(404, 'not-found', 'Run not found.')
    return { run: r }
  }, { auth: 'user' })

  router.add('GET', '/print/files/:token', async (ctx) => {
    const f = await print().fileFor(ctx.params.token, me(ctx))
    return fileResponse(f.bytes, String(f.row.mime), String(f.row.file_name), ctx.query.get('download') === '1')
  }, { auth: 'user' })

  void services
}
