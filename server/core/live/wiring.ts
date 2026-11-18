/**
 * Turns successful write requests into realtime messages (router.onMutation): app definitions (`app:<id>`), environment
 * metadata, security and state (`env`). Row changes do not come through here: the DataService emits those (changes.ts).
 */
import type { ApiRouter, MutationEvent } from '../router.ts'
import { DESIGN_ROUTES } from '../router.ts'
import type { LiveHub } from './hub.ts'
import { emitTableChange } from './changes.ts'
import { LIVE_CLIENT_HEADER } from '../../../src/platform/live-protocol.ts'

const SECURITY = /^\/(roles|users)(\/|$)|^\/environments\/:id\/access(\/|$)/

export function wireLive(router: ApiRouter, hub: LiveHub): () => void {
  return router.onMutation((e: MutationEvent) => {
    const ctx = e.ctx
    const env = ctx.environmentId
    const user = ctx.user?.user
    const by = user ? { id: user.id, name: user.name } : { id: '', name: 'Appbuilder' }
    const h = ctx.req.headers[LIVE_CLIENT_HEADER.toLowerCase()]
    const origin = (Array.isArray(h) ? h[0] : h) || undefined
    const key = `${e.method} ${e.pattern}`
    const result = (e.result && typeof e.result === 'object' ? e.result : {}) as Record<string, unknown>

    // apps: running copies offer "Update available", the Studio warns about a newer save by someone else
    if (key === 'PUT /apps/:id') hub.emitApp(env, e.params.id, 'saved', by, { modifiedOn: typeof result.modifiedOn === 'string' ? result.modifiedOn : undefined, origin })
    else if (key === 'PATCH /apps/:id') hub.emitApp(env, e.params.id, 'renamed', by, { modifiedOn: typeof result.modifiedOn === 'string' ? result.modifiedOn : undefined, origin })
    else if (key === 'DELETE /apps/:id') hub.emitApp(env, e.params.id, 'deleted', by, { origin })

    if (key === 'PATCH /environments/:id') {
      hub.emitEnv(e.params.id, 'state', { locked: typeof result.locked === 'boolean' ? result.locked : undefined, by, origin })
      return
    }
    if (key === 'DELETE /environments/:id') {
      hub.emitEnv(e.params.id, 'deleted', { by, origin })
      return
    }
    if (SECURITY.test(e.pattern)) {
      // roles, users and access decide privileges: every client of the environment reloads its session's privileges
      hub.emitEnv(e.pattern.startsWith('/environments/') ? e.params.id : env, 'security', { by, origin })
      return
    }
    if (key === 'POST /tables/:id/assign-owner') {
      // rows changed owner (a bulk update outside the DataService)
      emitTableChange(env, e.params.id, { op: 'update', rowIds: [], changedColumns: ['owner'], actor: by.id ? by : null, origin })
      return
    }
    if (key === 'POST /solutions/import' || key === 'POST /solutions/:id/deploy') {
      hub.emitEnv(env, 'metadata', { by, origin })
      const target = (ctx.body as { target?: unknown; environment?: unknown } | undefined)
      const other = typeof target?.target === 'string' ? target.target : typeof target?.environment === 'string' ? target.environment : null
      if (other && other !== env) hub.emitEnv(other, 'metadata', { by })
      return
    }
    // apps, tables, columns, solutions, data files, linked tables: metadata changed (PUT /apps/:id only touches the app)
    if (key !== 'PUT /apps/:id' && (DESIGN_ROUTES.has(key) || key === 'POST /apps/import' || key === 'POST /connections/:id/link')) {
      hub.emitEnv(env, 'metadata', { by, origin })
    }
  })
}
