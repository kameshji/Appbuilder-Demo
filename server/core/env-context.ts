/**
 * The environment a piece of work runs in. The router resolves it per request (resolveEnvironment) and runs the
 * handler inside runInEnvironment(); services.meta, the security cache, the connection cache and the default connector
 * read currentEnvironment(). Work outside a request (boot, timers, tests) runs in the default environment.
 *
 * Today every install has one environment, "default" in schema env_default. Package E (docs/plan/p0-spec.md) adds
 * create/switch/delete: it changes resolveEnvironment() and environmentSchema(), nothing else needs to.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import { HttpError } from './contracts.ts'
import type { EnvironmentRef } from './contracts.ts'

export const DEFAULT_ENVIRONMENT_ID = 'default'
/** schema of the install-wide objects (users, sessions, settings, environments, licence) */
export const INSTALL_SCHEMA = 'ab'

const ENV_ID = /^[a-z][a-z0-9_]{0,39}$/

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

/** the environment a request works in. One environment for now; package E reads a header / the session here. */
export function resolveEnvironment(_req?: IncomingMessage): string {
  return DEFAULT_ENVIRONMENT_ID
}

export function currentEnvironment(): EnvironmentRef {
  return store.getStore() ?? DEFAULT_REF
}

export function runInEnvironment<T>(id: string, fn: () => T): T {
  const ref = id === DEFAULT_ENVIRONMENT_ID ? DEFAULT_REF : environmentRef(id)
  return store.run(ref, fn)
}
