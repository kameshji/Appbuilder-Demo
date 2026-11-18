/**
 * ConnectionManager: connector registry + cached instances per environment and connection id. Connections are
 * environment objects (ab_connections lives in the environment schema), so the cache key is "<environment>:<connection>"
 * and each instance gets a ConnectorEnv naming its environment.
 */
import { createHash } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type { ConnectionManager, ConnectionRecord, Connector, ConnectorEnv, ConnectorFactory, MetaStore } from './contracts.ts'
import type { ConnectionRef, ConnectorKind } from '../../src/platform/contracts.ts'
import { errText } from './util.ts'
import { currentEnvironment } from './env-context.ts'

export const DEFAULT_CONNECTION_ID = 'conn_default'
export const FILES_CONNECTION_ID = 'conn_files'

/** what may leave the server: never the secret */
export function toConnectionRef(c: ConnectionRecord): ConnectionRef {
  const { secret, ...rest } = c
  return { ...rest, hasSecret: c.hasSecret ?? (secret !== undefined && secret !== '') }
}

function fingerprint(c: ConnectionRecord): string {
  return createHash('sha256')
    .update(JSON.stringify([c.connector, c.settings ?? {}, c.secret ?? null]))
    .digest('hex')
}

export function createConnectionManager(getMeta: () => MetaStore, env: ConnectorEnv): ConnectionManager & { closeAll(): Promise<void> } {
  const factories = new Map<ConnectorKind, ConnectorFactory>()
  const cache = new Map<string, { fp: string; connector: Connector }>()
  const creating = new Map<string, Promise<Connector>>()

  async function closeQuietly(c: Connector): Promise<void> {
    try {
      await c.close()
    } catch (e) {
      env.log('warn', `closing a connector failed: ${errText(e)}`)
    }
  }

  async function get(connectionId: string): Promise<Connector> {
    const environment = currentEnvironment()
    const key = `${environment.id}:${connectionId}`
    const rec = await getMeta().connections.get(connectionId)
    if (!rec) throw new HttpError(404, 'not-found', `Connection "${connectionId}" does not exist.`)
    const fp = fingerprint(rec)
    const hit = cache.get(key)
    if (hit && hit.fp === fp) return hit.connector
    const pending = creating.get(key + ':' + fp)
    if (pending) return pending
    const factory = factories.get(rec.connector)
    if (!factory) throw new HttpError(503, 'unavailable', `The "${rec.connector}" connector is not available on this server.`)
    const p = (async () => {
      const connector = factory(rec, { ...env, environment })
      const old = cache.get(key)
      cache.set(key, { fp, connector })
      if (old && old.connector !== connector) await closeQuietly(old.connector)
      return connector
    })()
    creating.set(key + ':' + fp, p)
    try {
      return await p
    } finally {
      creating.delete(key + ':' + fp)
    }
  }

  return {
    get,
    async defaultId() {
      const list = await getMeta().connections.list()
      return list.find((c) => c.isDefault && c.connector === 'postgres')?.id ?? DEFAULT_CONNECTION_ID
    },
    async reset(connectionId) {
      const key = `${currentEnvironment().id}:${connectionId}`
      const hit = cache.get(key)
      cache.delete(key)
      if (hit) await closeQuietly(hit.connector)
    },
    register(kind, factory) {
      factories.set(kind, factory)
    },
    async closeAll() {
      const all = [...cache.values()]
      cache.clear()
      for (const h of all) await closeQuietly(h.connector)
    },
  }
}
