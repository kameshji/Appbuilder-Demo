/** Test helpers: a fleet on the recording fake, run through the real CLI entry (runAbfleet) or the library. */
import path from 'node:path'
import { runAbfleet } from '../abfleet.ts'
import { loadRegistry, saveRegistry, type Ctx } from '../lib/core.ts'
import { FakeSystem, realisticHandler } from '../lib/fake.ts'
import { defaultConfig, emptyRegistry, serverPaths, type FleetPaths, type Registry } from '../lib/model.ts'

export interface TestFleet {
  fake: FakeSystem
  paths: FleetPaths
  out: string[]
  run(argv: string[]): Promise<{ code: number; result: unknown; error?: string }>
  reg(): Registry
  ctx(): Ctx
}

export function testFleet(o: { handler?: Parameters<typeof realisticHandler>[0]; licence?: boolean; target?: boolean } = {}): TestFleet {
  const fake = new FakeSystem()
  fake.handler = realisticHandler(o.handler ?? { schema: 14 })
  // as after abfleet init: PUBLIC has no CONNECT on postgres and template1
  fake.publicConnect.clear()
  const paths = serverPaths('/opt/appbuilder/fleet')
  const rel = path.join(paths.releases, '0.8.0')
  fake.links.set(paths.current, rel)
  fake.files.set(path.join(rel, 'release.json'), { text: JSON.stringify({ version: '0.8.0', commit: 'aaaa', schemaVersion: 14, node: '>=22.18' }), mode: 0o644 })
  fake.files.set(path.join(paths.releases, '0.9.0', 'release.json'), { text: JSON.stringify({ version: '0.9.0', commit: 'bbbb', schemaVersion: 15, node: '>=22.18' }), mode: 0o644 })
  fake.files.set(path.join(paths.secrets, 'backup-master.key'), { text: 'a'.repeat(64) + '\n', mode: 0o600 })
  fake.files.set(path.join(paths.licenceDir, 'licence.env'), { text: 'APPBUILDER_LICENCE_DB_URL=postgres://x\n', mode: 0o640 })
  const config = defaultConfig('server', 'example.test')
  if (o.licence) config.licence.enabled = true
  if (o.target) config.backup.target = { kind: 'path', path: '/mnt/offsite' }
  const r = emptyRegistry(config, fake.clock)
  fake.files.set(paths.registry, { text: JSON.stringify(r), mode: 0o600 })
  fake.calls = []
  const out: string[] = []
  const t: TestFleet = {
    fake, paths, out,
    run: (argv) => runAbfleet(argv, { system: fake, paths, env: { ABFLEET_ACTOR: 'tester' }, stdout: (s) => out.push(s), stderr: (s) => out.push(s) }),
    reg: () => loadRegistry(fake, paths)!,
    ctx: () => {
      const reg = loadRegistry(fake, paths)!
      const c: Ctx = { sys: fake, paths, reg, out: { say: (l) => out.push(l), warn: (l) => out.push(l) }, json: false, dry: false, who: 'tester', secrets: [], save: () => saveRegistry(fake, paths, reg), clock: () => fake.now() }
      return c
    },
  }
  return t
}

/** what must be gone after a rollback or a delete */
export function leftovers(t: TestFleet): string[] {
  const left: string[] = []
  for (const u of t.fake.users) left.push(`user ${u}`)
  for (const r of t.fake.roles) left.push(`role ${r}`)
  for (const d of t.fake.dbs) if (d !== 'postgres' && d !== 'template1') left.push(`db ${d}`)
  for (const k of [...t.fake.files.keys(), ...t.fake.dirs.keys(), ...t.fake.links.keys()]) {
    if (k.startsWith(t.paths.instances + path.sep) || k.startsWith(t.paths.caddySites) || k.startsWith(t.paths.run + path.sep) || /appbuilder@o/.test(k) || /appbuilder-o[a-z2-7]{8}\.conf/.test(k)) left.push(`file ${k}`)
  }
  for (const u of t.fake.active) if (u.startsWith('appbuilder@')) left.push(`running ${u}`)
  for (const u of t.fake.enabled) if (u.startsWith('appbuilder@')) left.push(`enabled ${u}`)
  if (Object.keys(t.reg().orgs).length) left.push('registry entries')
  return left
}
