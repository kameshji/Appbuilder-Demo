import { describe, expect, it } from 'vitest'
import { DEFAULT_ENVIRONMENT_ID, currentEnvironment, environmentSchema, resolveEnvironment, runInEnvironment } from './env-context.ts'
import { createSecurityEngine } from './security.ts'
import { createConnectionManager } from './connections.ts'
import type { Connector, ConnectorEnv, MetaStore } from './contracts.ts'
import type { UserDef } from '../../src/platform/contracts.ts'

describe('environment context', () => {
  it('one environment for now: every request resolves to default, schema env_default', () => {
    expect(resolveEnvironment()).toBe(DEFAULT_ENVIRONMENT_ID)
    expect(currentEnvironment()).toEqual({ id: 'default', schema: 'env_default' })
    expect(environmentSchema('test_2')).toBe('env_test_2')
    for (const bad of ['', 'Default', '1x', 'a-b', 'a"b', 'x'.repeat(41)]) expect(() => environmentSchema(bad)).toThrow()
  })

  it('runInEnvironment scopes async work, also across awaits and timers', async () => {
    const seen: string[] = []
    await Promise.all([
      runInEnvironment('sales', async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(currentEnvironment().schema) }),
      runInEnvironment('default', async () => { await Promise.resolve(); seen.push(currentEnvironment().schema) }),
    ])
    expect(seen.sort()).toEqual(['env_default', 'env_sales'])
    expect(currentEnvironment().id).toBe('default')
  })

  it('the security cache is keyed by environment', async () => {
    const loads: string[] = []
    const meta = {
      roles: { list: async () => { loads.push(currentEnvironment().id); return [{ id: 'role_x', name: currentEnvironment().id, privileges: [], apps: 'all' }] } },
      tables: { list: async () => [] },
    } as unknown as MetaStore
    const sec = createSecurityEngine(() => meta)
    const user: UserDef = { id: 'u', name: 'U', email: 'u@x.test', roleIds: ['role_x'], status: 'active' }
    const roleName = async (env: string) => runInEnvironment(env, async () => (await sec.forUser(user)).roles[0]?.name)
    expect(await roleName('default')).toBe('default')
    expect(await roleName('sales')).toBe('sales')
    expect(await roleName('default')).toBe('default')
    expect(loads).toEqual(['default', 'sales'])
    // invalidate() drops the current environment's entry only; 'all' drops every one
    runInEnvironment('sales', () => sec.invalidate())
    await roleName('default')
    await roleName('sales')
    expect(loads).toEqual(['default', 'sales', 'sales'])
    sec.invalidate('all')
    await roleName('default')
    await roleName('sales')
    expect(loads).toEqual(['default', 'sales', 'sales', 'default', 'sales'])
  })

  it('connector instances are cached per environment and connection, and know their environment', async () => {
    const made: string[] = []
    const env: ConnectorEnv = { workspaceDir: '', filesDir: '', fetch, log: () => {} }
    const meta = { connections: { get: async (id: string) => ({ id, name: id, connector: 'postgres', status: 'connected', settings: {} }) } } as unknown as MetaStore
    const cm = createConnectionManager(() => meta, env)
    cm.register('postgres', (rec, e) => {
      made.push(`${e.environment?.schema}:${rec.id}`)
      return { kind: 'postgres', close: async () => {} } as unknown as Connector
    })
    const a = await runInEnvironment('default', () => cm.get('conn_default'))
    const b = await runInEnvironment('sales', () => cm.get('conn_default'))
    expect(a).not.toBe(b)
    expect(await runInEnvironment('default', () => cm.get('conn_default'))).toBe(a)
    expect(made).toEqual(['env_default:conn_default', 'env_sales:conn_default'])
    await runInEnvironment('sales', () => cm.reset('conn_default'))
    expect(await runInEnvironment('default', () => cm.get('conn_default'))).toBe(a)
    expect(await runInEnvironment('sales', () => cm.get('conn_default'))).not.toBe(b)
  })
})
