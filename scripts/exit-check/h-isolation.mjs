#!/usr/bin/env node
/**
 * Hosting exit check 2: the cross-instance isolation suite (docs/plan/hosting-spec.md; package H-B). DEVELOPER AND CI
 * TOOL, not part of the product. Starts three installs of this tree with their own databases, roles, folders and keys
 * behind a host-routing proxy, attacks B from A by every route of the spec's threat model, and prints a Markdown table.
 * Exit code 1 when any check fails (a refusal missing, or anything of B readable from A), 2 when the fleet cannot start.
 *
 *   node scripts/exit-check/h-isolation.mjs
 *
 * PostgreSQL (scripts/fleet/testing/fleet.mjs): APPBUILDER_HB_ADMIN_DB=postgres://<superuser>:<pw>@host:port/postgres
 * for a cluster the suite may change (CI), else a private cluster from APPBUILDER_HB_PG_BIN (default
 * .sandbox/pg/pgsql/bin) on 127.0.0.1:5319. Ports 5300-5319. Everything it creates (ab_hb_* databases and roles,
 * .sandbox/hb/run-*) is removed afterwards; HB_KEEP=1 keeps the folders and logs. Output: the table, also written to
 * .sandbox/hb/h-isolation.md.
 *
 * What this cannot show on one machine without systemd, per-install OS users and Caddy (a Linux server, later package):
 * the file permissions between installs (here every install runs as the same OS user, so A's process COULD read B's
 * folder), systemd CPU, memory and task limits, disk quotas, Caddy's real TLS, its admin API and its rate limits, the
 * licence service. See docs/dev/testing.md "Isolation suite".
 */
import fs from 'node:fs'
import path from 'node:path'
import { report, runIsolation } from '../fleet/testing/isolation.mjs'
import { root } from '../fleet/testing/fleet.mjs'

const t0 = Date.now()
const log = (m) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}\n`)
let r
try {
  r = await runIsolation({ log })
} catch (e) {
  process.stderr.write(`The isolation suite could not run: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(2)
}
const md = report(r)
console.log(md)
try {
  fs.mkdirSync(path.join(root, '.sandbox', 'hb'), { recursive: true })
  fs.writeFileSync(path.join(root, '.sandbox', 'hb', 'h-isolation.md'), md + '\n')
} catch { /* the table is on standard output anyway */ }
process.exit(r.results.some((x) => !x.ok && !x.skipped) ? 1 : 0)
