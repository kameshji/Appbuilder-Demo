/**
 * Backups API (src/platform/backup.ts has the shapes and the route list; docs/dev/data-api.md "Backups").
 * Install administrators only. Downloads need a recent sign-in (requireRecentAuth of the identity package).
 */
import fs from 'node:fs'
import { HttpError } from '../contracts.ts'
import type { Ctx, RawResponse, Router, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { RestoreRequest, TableRestoreRequest } from '../../../src/platform/backup.ts'

function admin(ctx: Ctx): UserContext {
  const u = ctx.user
  if (!u) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
  if (!u.privileges.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can manage backups.')
  return u
}

const body = (ctx: Ctx): Record<string, unknown> => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {})
const passOf = (b: Record<string, unknown>): string | null => (typeof b.passphrase === 'string' && b.passphrase ? b.passphrase : null)

/**
 * Re-authentication before a download. The identity package (I) provides requireRecentAuth(ctx) in
 * server/core/identity/index.ts; when it is not there (an older build), downloads only need an install administrator.
 * TODO(package I): drop the fallback once requireRecentAuth is part of every build.
 */
async function recentAuth(ctx: Ctx): Promise<void> {
  let fn: ((c: Ctx) => void) | undefined
  try {
    fn = ((await import('../identity/index.ts')) as { requireRecentAuth?: (c: Ctx) => void }).requireRecentAuth
  } catch {
    fn = undefined
  }
  if (typeof fn === 'function') fn(ctx)
}

export function backupRoutes(router: Router, services: CoreServices): void {
  const b = () => services.backup
  const opts = { auth: 'user' as const, noEnvironment: true }

  router.add('GET', '/api/v1/backups', async (ctx) => {
    admin(ctx)
    const [items, health, ops] = await Promise.all([b().list(), b().health(), b().recentOps()])
    return { items, health, ops }
  }, opts)

  router.add('POST', '/api/v1/backups', async (ctx) => b().backupNow(admin(ctx), body(ctx)), opts)

  router.add('GET', '/api/v1/backups/health', async (ctx) => {
    admin(ctx)
    return b().health()
  }, opts)

  router.add('GET', '/api/v1/backups/settings', async (ctx) => {
    admin(ctx)
    await b().loadConfig()
    return b().settings()
  }, opts)

  router.add('PUT', '/api/v1/backups/settings', async (ctx) => b().saveSettings(body(ctx), admin(ctx)), opts)

  router.add('POST', '/api/v1/backups/restore-test', async (ctx) => {
    const u = admin(ctx)
    void b().restoreTest(u.user.id).catch(() => {})
    // the operation row exists as soon as the test starts
    await new Promise((r) => setTimeout(r, 50))
    const ops = await b().recentOps()
    return ops.find((o) => o.kind === 'restore-test') ?? { ok: true }
  }, opts)

  router.add('GET', '/api/v1/backups/ops/:id', async (ctx) => {
    admin(ctx)
    return b().getOp(ctx.params.id)
  }, opts)

  router.add('POST', '/api/v1/backups/upload', async (ctx) => {
    const u = admin(ctx)
    return b().upload(ctx.req as unknown as Parameters<CoreServices['backup']['upload']>[0], ctx.query.get('name') ?? 'uploaded.abbak', u)
  }, { ...opts, raw: true, streamBody: true, maxBodyMB: 1024 * 1024 })

  router.add('GET', '/api/v1/backups/:id', async (ctx) => {
    admin(ctx)
    return b().info(ctx.params.id)
  }, opts)

  router.add('PATCH', '/api/v1/backups/:id', async (ctx) => b().update(ctx.params.id, body(ctx), admin(ctx)), opts)

  router.add('DELETE', '/api/v1/backups/:id', async (ctx) => {
    await b().remove(ctx.params.id, admin(ctx))
    return { ok: true }
  }, opts)

  router.add('POST', '/api/v1/backups/:id/verify', async (ctx) => b().verify(ctx.params.id, passOf(body(ctx)), admin(ctx)), opts)

  router.add('POST', '/api/v1/backups/:id/contents', async (ctx) => {
    admin(ctx)
    return b().contents(ctx.params.id, passOf(body(ctx)))
  }, opts)

  router.add('POST', '/api/v1/backups/:id/browse', async (ctx) => {
    admin(ctx)
    return b().browse(ctx.params.id, body(ctx))
  }, opts)

  router.add('POST', '/api/v1/backups/:id/restore', async (ctx) => b().restoreEnvironment(ctx.params.id, body(ctx) as unknown as RestoreRequest, admin(ctx)), opts)

  router.add('POST', '/api/v1/backups/:id/restore-tables/plan', async (ctx) => {
    admin(ctx)
    return b().planTables(ctx.params.id, body(ctx) as unknown as TableRestoreRequest, ctx.environmentId)
  }, { auth: 'user' })

  router.add('POST', '/api/v1/backups/:id/restore-tables', async (ctx) => b().restoreTables(ctx.params.id, body(ctx) as unknown as TableRestoreRequest & { confirm?: string }, admin(ctx), ctx.environmentId), { auth: 'user' })

  /** a one-minute, one-use ticket for a browser download (the download itself is a plain link) */
  router.add('POST', '/api/v1/backups/:id/download-ticket', async (ctx) => {
    const u = admin(ctx)
    await recentAuth(ctx)
    await b().info(ctx.params.id)
    return { ticket: b().issueTicket(ctx.params.id, u.user.id), url: `/api/v1/backups/${encodeURIComponent(ctx.params.id)}/download` }
  }, opts)

  router.add('GET', '/api/v1/backups/:id/download', async (ctx): Promise<RawResponse> => {
    const u = admin(ctx)
    const t = ctx.query.get('ticket')
    if (!t || !b().useTicket(t, ctx.params.id, u.user.id)) await recentAuth(ctx)
    const f = await b().downloadFile(ctx.params.id, u)
    return {
      raw: true,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(f.size),
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'Cache-Control': 'no-store',
      },
      body: fs.createReadStream(f.file, { highWaterMark: 1024 * 1024 }),
    }
  }, opts)
}
