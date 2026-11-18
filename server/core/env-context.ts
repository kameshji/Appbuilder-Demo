/**
 * The environment a piece of work runs in. The router reads the environment the request names (requestedEnvironment:
 * the X-Appbuilder-Environment header, or ?env= on GET), the session resolver checks it against the user's access
 * (environments.ts resolveFor) and the router runs the handler inside runInEnvironment(); services.meta, the security
 * cache, the connection cache, the default connector and the workspace folders read currentEnvironment(). Work outside
 * a request (boot, timers, tests) runs in the default environment unless it calls runInEnvironment itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import { HttpError } from './contracts.ts'
import type { EnvironmentRef } from './contracts.ts'
import { ENVIRONMENT_HEADER, ENVIRONMENT_QUERY } from '../../src/platform/http.ts'

export const DEFAULT_ENVIRONMENT_ID = 'default'
/** schema of the install-wide objects (users, sessions, settings, environments, access, install audit, licence) */
export const INSTALL_SCHEMA = 'ab'

/** environment ids: lowercase slug, also the schema suffix */
export const ENV_ID = /^[a-z][a-z0-9_]{0,39}$/

/** env_<id>; the id is validated, so the schema name is always a safe identifier */
export function environmentSchema(id: string): string {
  if (!ENV_ID.test(id)) throw new HttpError(422, 'invalid', 'Invalid environment id.')
  return `env_${id}`
}

export function environmentRef(id: string): EnvironmentRef {
  return { id, schema: environmentSchema(id) }
}

const DEFAULT_REF: EnvironmentRef = Object.freeze(environmentRef(DEFAULT_ENVIRONMENT_ID))
const store = new AsyncLocalStorage<EnvironmentRef>()

/**
 * The environment a request names: the header, or ?env= on GET/HEAD (links such as <img src> cannot send headers).
 * null when it names none. A malformed id, or header and query naming different ones, is a 400.
 */
export function requestedEnvironment(req: IncomingMessage, url?: URL): string | null {
  const raw = req.headers[ENVIRONMENT_HEADER.toLowerCase()]
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null
  const method = (req.method ?? 'GET').toUpperCase()
  const query = url && (method === 'GET' || method === 'HEAD') ? url.searchParams.get(ENVIRONMENT_QUERY)?.trim() || null : null
  if (header && query && header !== query) throw new HttpError(400, 'invalid', 'The request names two different environments.')
  const id = header ?? query
  if (id === null) return null
  if (!ENV_ID.test(id)) throw new HttpError(400, 'invalid', `"${id.slice(0, 50)}" is not an environment id.`)
  return id
}

/** @deprecated kept for callers outside a request: the requested environment or the default (no access check) */
export function resolveEnvironment(req?: IncomingMessage): string {
  return (req ? requestedEnvironment(req) : null) ?? DEFAULT_ENVIRONMENT_ID
}

export function currentEnvironment(): EnvironmentRef {
  return store.getStore() ?? DEFAULT_REF
}

export function runInEnvironment<T>(id: string, fn: () => T): T {
  const ref = id === DEFAULT_ENVIRONMENT_ID ? DEFAULT_REF : environmentRef(id)
  return store.run(ref, fn)
}
