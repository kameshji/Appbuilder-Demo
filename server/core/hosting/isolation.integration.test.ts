/**
 * H-B: the cross-instance isolation suite (hosting exit check 2) as an integration test. The suite itself is
 * scripts/fleet/testing/isolation.mjs (also run by `node scripts/exit-check/h-isolation.mjs`): three real installs of
 * this tree as separate processes, each with its own database and role (set up as the fleet tool will), folder,
 * secret key and locked public URL, behind a host-routing proxy; A attacks B by every route of the threat model.
 *
 * Runs when it has a PostgreSQL it may change: APPBUILDER_HB_ADMIN_DB=postgres://<superuser>:<pw>@host:port/postgres
 * (CI: the "isolation" job), or a private cluster from APPBUILDER_HB_PG_BIN / .sandbox/pg/pgsql/bin. Otherwise skipped
 * with the reason printed. On Linux the installs listen on Unix sockets (as hosted installs do); on Windows on TCP
 * 127.0.0.1 (the socket variant is skipped there, with the reason printed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const bin = process.env.APPBUILDER_HB_PG_BIN || path.join(root, '.sandbox', 'pg', 'pgsql', 'bin')
const enabled = !!process.env.APPBUILDER_HB_ADMIN_DB || fs.existsSync(path.join(bin, process.platform === 'win32' ? 'initdb.exe' : 'initdb'))
if (!enabled) process.stderr.write('[server/core/hosting isolation] skipped: set APPBUILDER_HB_ADMIN_DB (a PostgreSQL superuser URL of a cluster the suite may change) or APPBUILDER_HB_PG_BIN (initdb and pg_ctl)\n')
if (enabled && process.platform === 'win32') process.stderr.write('[server/core/hosting isolation] Unix socket listeners are skipped on Windows (the installs listen on TCP 127.0.0.1); CI on Linux runs them\n')

interface Result { area: string; check: string; ok: boolean; detail: string; skipped?: boolean; control?: boolean }
interface Run { results: Result[]; notes: string[] }

const AREAS = ['Routing and host names', 'Sessions, cookies, live socket', 'Tokens, links and keys', 'Database roles', 'Outbound from A', 'Files and folders', 'Read-only state', 'Logs']

describe.skipIf(!enabled)('cross-instance isolation (H-B, three installs)', () => {
  let run: Run | null = null
  let failure: unknown = null
  beforeAll(async () => {
    const file = pathToFileURL(path.join(root, 'scripts', 'fleet', 'testing', 'isolation.mjs')).href
    const mod = (await import(file)) as { runIsolation(o: { log(m: string): void }): Promise<Run>; report(r: Run): string }
    try {
      run = await mod.runIsolation({ log: () => {} })
      process.stderr.write(`${mod.report(run)}\n`)
    } catch (e) {
      failure = e
    }
  }, 900_000)
  afterAll(() => {
    run = null
  })

  it('the fleet starts', () => {
    expect(failure, String((failure as Error | null)?.stack ?? failure)).toBeNull()
    expect(run!.results.length).toBeGreaterThan(80)
  })

  it('every negative control is detected (the suite sees the mistakes it is meant to catch)', () => {
    const controls = run!.results.filter((r) => r.control)
    expect(controls.length).toBeGreaterThanOrEqual(2)
    expect(controls.filter((r) => !r.ok).map((r) => `${r.check}: ${r.detail}`)).toEqual([])
  })

  for (const area of AREAS) {
    it(`${area}: every attempt refused, nothing of B in an answer or a log`, () => {
      const mine = run!.results.filter((r) => r.area === area)
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.filter((r) => !r.ok && !r.skipped).map((r) => `${r.check}: ${r.detail}`)).toEqual([])
    })
  }
})
