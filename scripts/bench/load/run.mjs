#!/usr/bin/env node
/**
 * Load test of the hosted fleet (package H-L; docs/plan/hosting-spec.md exit check 7; docs/dev/load-testing.md).
 * DEVELOPER AND OPERATOR TOOL, not part of the product. No dependencies beyond the server's own (pg, ws).
 *
 *   node scripts/bench/load/run.mjs                      the smoke profile (3 organisations x 10 people, under 3 minutes)
 *   node scripts/bench/load/run.mjs --profile pilot      the target: 20 x 50, 150 concurrent, 200 sockets, 50 req/s 30 min, 100 req/s 5 min
 *   node scripts/bench/load/run.mjs --profile ramp       steps of load until a service level breaks (the knee, the first bottleneck)
 *
 * Overrides: --orgs N --users N --active N (concurrent people per organisation) --sockets N (per organisation)
 *   --seed-days N --steady-s N --peak-s N --noisy-s N --rate X (steady req/s) --peak-rate X --repeat N (measure the
 *   phases N times on the same fleet) --parallel N (installs provisioned at once) --fsync off --pg-port 5400-5409
 *   --base-port 5410-5499 --ramp 50,100,200 --ramp-step-s N --keep (leave the fleet folder and logs) --crm (also the CRM pack)
 *   --server-ram-gb N (the server the memory share is computed for; default 32, DC-12) --out <file.md>
 *
 * What it starts: a PRIVATE PostgreSQL cluster (.sandbox/pg binaries, data under .sandbox/load/run-*, port 5401 by
 * default), N installs of this tree as processes (ports 5411+), and nothing else. Everything is stopped and removed at
 * the end, also on failure and on Ctrl-C. The report: .sandbox/load/reports/<profile>-<time>.md and .json (kept).
 * Exit code: 0 when the profile's thresholds pass, 1 when they fail, 2 when the run could not complete.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { MIX, PROFILES } from './profiles.mjs'
import { cleanStale, startCluster } from './lib/cluster.mjs'
import { createInstall, dropAll, installHandlers, liveChildren, onCleanup, pool, stopInstall } from './lib/fleet.mjs'
import { agentFor, openLive, recorder } from './lib/client.mjs'
import { composition, seedOrg } from './lib/seed.mjs'
import { backgroundJob, ELIGIBLE, heavyWork, SCENARIOS } from './lib/scenarios.mjs'
import { liveTracker } from './lib/track.mjs'
import { loopProbes, parsePgLog, pgSampler, processSampler } from './lib/sampler.mjs'
import { markdown, orgStats, phaseStats, resources, scenarioRows, verdict } from './lib/report.mjs'
import { folderBytes, log, MB, noisePng, pct, r1, rng, root, sleep, WIN } from './lib/util.mjs'

/* ------------------------------------------------------------------ configuration */

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => { const k = argv.indexOf(`--${n}`); return k >= 0 && argv[k + 1] !== undefined && !argv[k + 1].startsWith('--') ? argv[k + 1] : d }
const profileName = opt('profile', 'smoke')
if (!PROFILES[profileName]) { console.error(`profiles: ${Object.keys(PROFILES).join(', ')}`); process.exit(2) }
const cfg = structuredClone(PROFILES[profileName])
const num = (n, k) => { const v = opt(n); if (v !== undefined) cfg[k] = Number(v) }
num('orgs', 'orgs'); num('users', 'users'); num('active', 'activePerOrg'); num('sockets', 'socketsPerOrg'); num('seed-days', 'seedDays')
num('repeat', 'repeat'); num('parallel', 'parallel'); num('pg-port', 'pgPort'); num('base-port', 'basePort'); num('ramp-step-s', 'rampStepS')
num('server-ram-gb', 'serverRamGB'); num('chat-history', 'chatHistory'); num('heavy-import', 'heavyImportRows'); num('heavy-pdf', 'heavyPdfRecords')
if (opt('fsync') === 'off') cfg.fsync = false
if (flag('crm')) cfg.crm = true
if (opt('ramp')) cfg.rampRates = opt('ramp').split(',').map(Number)
const setPhase = (name, k, v) => { const ph = cfg.phases.find((p) => p.name === name); if (ph && v !== undefined) ph[k] = Number(v) }
setPhase('steady', 's', opt('steady-s')); setPhase('peak', 's', opt('peak-s')); setPhase('noisy', 's', opt('noisy-s'))
setPhase('steady', 'rate', opt('rate')); setPhase('noisy', 'rate', opt('rate')); setPhase('burst', 'rate', opt('rate')); setPhase('peak', 'rate', opt('peak-rate'))
if (opt('steady-s') && cfg.phases.find((p) => p.name === 'steady')?.background) cfg.phases.find((p) => p.name === 'steady').background = Math.min(cfg.phases.find((p) => p.name === 'steady').background, Math.max(20, Math.round(Number(opt('steady-s')) / 3)))
if (cfg.basePort < 5410 || cfg.basePort + cfg.orgs - 1 > 5499) { console.error('installs must fit in ports 5410-5499'); process.exit(2) }
if (cfg.pgPort < 5400 || cfg.pgPort > 5409) { console.error('the private cluster port must be 5400-5409'); process.exit(2) }
const KEEP = flag('keep')

const base = path.join(root, '.sandbox', 'load')
const reportsDir = path.join(base, 'reports')
fs.mkdirSync(reportsDir, { recursive: true })
const stale = cleanStale(base)
if (stale.length) log(`stopped ${stale.length} cluster(s) left by an earlier killed run of this harness`)
const runId = `${Date.now().toString(36)}`
const runDir = path.join(base, `run-${runId}`)
fs.mkdirSync(runDir, { recursive: true })
const startedAt = new Date().toISOString()

/* ------------------------------------------------------------------ the machine */

function machineInfo() {
  const cpus = os.cpus()
  let disk = 'unknown disk'
  let osName = `${os.type()} ${os.release()}`
  try {
    if (WIN) {
      const o = execFileSync('powershell.exe', ['-NoProfile', '-Command', "$d = Get-Partition -DriveLetter C | Get-Disk; $p = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq $d.Number }; \"$($p.MediaType) $($p.BusType) $($p.FriendlyName) $([math]::Round($d.Size/1GB)) GB\"; (Get-CimInstance Win32_OperatingSystem).Caption"], { encoding: 'utf8', timeout: 30_000 }).trim().split(/\r?\n/)
      disk = o[0]?.trim() || disk
      osName = `${o[1]?.trim() ?? osName} (${os.release()})`
    } else {
      osName = fs.existsSync('/etc/os-release') ? (/PRETTY_NAME="([^"]+)"/.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] ?? osName) : osName
      disk = execFileSync('sh', ['-c', `lsblk -d -o NAME,ROTA,SIZE,MODEL | head -5 | tr '\\n' ';'`], { encoding: 'utf8' }).trim()
    }
  } catch { /* best effort */ }
  const free = (() => { try { return execFileSync(WIN ? 'powershell.exe' : 'sh', WIN ? ['-NoProfile', '-Command', `(Get-PSDrive C).Free`] : ['-c', `df -B1 --output=avail "${root}" | tail -1`], { encoding: 'utf8' }).trim() } catch { return '' } })()
  return { cpu: cpus[0]?.model?.trim(), cores: cpus.length, ramGB: Math.round(os.totalmem() / 2 ** 30), freeRamGB: Math.round(os.freemem() / 2 ** 30), disk, diskFreeGB: free ? Math.round(Number(free) / 2 ** 30) : null, os: osName, node: process.version, loadAtStart: null }
}

/* ------------------------------------------------------------------ state and cleanup */

const state = { cluster: null, installs: [], orgs: [], sockets: [], samplers: [], stopped: false }
async function stopAll() {
  if (state.stopped) return
  state.stopped = true
  for (const s of state.sockets) { try { s.ws.terminate() } catch { /* gone */ } }
  for (const s of state.samplers) { try { await s.stop() } catch { /* gone */ } }
  for (const a of ctx.agents.values()) a.destroy()
  await Promise.all(state.installs.map((i) => stopInstall(i).catch(() => {})))
  if (state.cluster) {
    await dropAll(state.cluster).catch(() => {})
    state.cluster.stop()
  }
  if (!KEEP) {
    for (let k = 0; k < 10; k++) {
      try { fs.rmSync(runDir, { recursive: true, force: true }); break } catch { await sleep(1000) }
    }
  }
}
installHandlers(stopAll)
onCleanup(() => { try { state.cluster?.stop() } catch { /* best effort */ } })

const rec = recorder()
const live = liveTracker()
const ctx = {
  rec, live, cfg, agents: new Map(), photo: null, phoneUa: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 (load test)',
  integrity: { created: [], replays: 0, replayMismatch: [], breakdowns: 0, failedInspections: 0, ncrSent: 0, approved: 0, tasks: [], burst: 0 },
  dash: { total: 0, cached: 0, failed: new Map() },
  cluster: null,
}
const g = rng(cfg.seed)
let shed = 0
let skipped = 0
let inflight = 0
const harnessErrors = new Map()

/* ------------------------------------------------------------------ the scheduler */

const mixEntries = Object.entries(MIX).map(([k, v]) => [k, v.weight])
const reqPerAction = Object.values(MIX).reduce((s, v) => s + v.weight * v.reqs, 0) / Object.values(MIX).reduce((s, v) => s + v.weight, 0)

function launch(scenario, orgPick) {
  const tries = orgPick ? [orgPick] : [g.pick(state.orgs), g.pick(state.orgs), g.pick(state.orgs)]
  const roles = ELIGIBLE[scenario]
  for (const org of tries) {
    const cand = org.active.filter((p) => !p.busy && (!roles || roles.includes(p.user.role)))
    if (!cand.length) continue
    if (inflight >= cfg.maxInflight) { shed++; return false }
    const p = g.pick(cand)
    p.busy = true
    inflight++
    SCENARIOS[scenario](p, org, ctx, g)
      .catch((e) => { const k = `${scenario}: ${String(e?.message ?? e).slice(0, 160)}`; harnessErrors.set(k, (harnessErrors.get(k) ?? 0) + 1) })
      .finally(() => { p.busy = false; inflight-- })
    return true
  }
  skipped++
  return false
}

const phaseLog = []
async function runPhase(ph, label) {
  const name = label ?? ph.name
  rec.setPhase(name)
  live.phase = name
  const t0 = performance.now()
  const n0 = rec.counts.requests
  const actRate = ph.rate / reqPerAction
  log(`phase ${name}: ${ph.s} s at ${ph.rate} req/s (${r1(actRate)} actions/s)${ph.heavy ? ', heavy tenant' : ''}${ph.burst ? ', shift change' : ''}${ph.idle ? ', no users' : ''}`)
  const end = t0 + ph.s * 1000
  const extra = []
  if (ph.heavy && cfg.heavy && state.orgs[0]) extra.push(heavyWork(state.orgs[0], ctx, cfg, log).then((w) => { noisyWork.push(...w) }))
  if (ph.burst) {
    // shift change: every operator of every organisation logs the shift within the window
    for (const org of state.orgs) {
      for (const p of org.people.filter((x) => x.user.role === 'Operator')) {
        const at = g.next() * ph.burst * 1000
        extra.push((async () => { await sleep(at); ctx.integrity.burst++; await SCENARIOS.phone_log(p, org, ctx, g, { scenario: 'shift_change' }).catch(() => {}) })())
      }
    }
  }
  if (ph.background) {
    state.orgs.forEach((org, k) => {
      extra.push((async () => {
        let t = (k / state.orgs.length) * ph.background * 1000
        let n = 0
        while (performance.now() - t0 + t < ph.s * 1000) {
          await sleep(t)
          await backgroundJob(org, n % 2 === 0 ? 'report' : 'daily_pdf')
          n++
          t = ph.background * 1000
        }
      })())
    })
  }
  let next = performance.now()
  while (performance.now() < end) {
    if (actRate <= 0) { await sleep(Math.min(250, end - performance.now())); continue }
    const nowp = performance.now()
    while (next <= nowp) {
      launch(g.weighted(mixEntries))
      next += g.exp(1000 / actRate)
    }
    await sleep(Math.max(1, Math.min(20, next - performance.now())))
  }
  // heavy work and the shift change finish inside their phase (the noisy window lasts as long as the heavy work)
  await Promise.all(extra)
  const secs = (performance.now() - t0) / 1000
  const reqs = rec.counts.requests - n0
  phaseLog.push({ name, s: secs, rate: ph.rate, achieved: reqs / secs, heavy: !!ph.heavy, burst: ph.burst, idle: !!ph.idle })
  log(`phase ${name} done: ${reqs} requests in ${r1(secs)} s (${r1(reqs / secs)}/s), ${inflight} in flight, shed ${shed}, skipped ${skipped}`)
}
const noisyWork = []

/* ------------------------------------------------------------------ live sockets */

async function openSockets(org) {
  const people = [...org.active]
  const extras = org.people.filter((p) => p.user.role !== 'Operator')
  for (let k = 0; people.length < cfg.socketsPerOrg && extras.length; k++) people.push(extras[k % extras.length])
  const out = []
  for (const p of people.slice(0, cfg.socketsPerOrg)) {
    const s = await openLive(p, { onTable: live.onTable, onChat: live.onChat, onUser: live.onUser, onResync: live.onResync, onClose: (sock, code) => { sock.closedPerf = performance.now(); live.onClose(sock, code) } })
    if (!s.hello) { harnessErrors.set(`socket ${org.inst.key}: no hello (${s.closed?.code ?? 'timeout'})`, 1); continue }
    live.register(s, org)
    const subs = await Promise.all([s.sub(`user:${p.user.id}`), s.sub(`chat:${org.channel}`), s.sub(`table:${org.ids.ProductionLog}`, 'default')])
    s.userSub = subs[0].t === 'subscribed'
    s.chatSub = subs[1].t === 'subscribed'
    s.tableSub = subs[2].t === 'subscribed'
    if (!s.chatSub || !s.tableSub) harnessErrors.set(`subscribe ${org.inst.key} ${p.user.role}: chat ${subs[1].code ?? subs[1].t}, table ${subs[2].code ?? subs[2].t}`, (harnessErrors.get(`subscribe ${org.inst.key} ${p.user.role}`) ?? 0) + 1)
    out.push(s)
    state.sockets.push(s)
  }
  return out
}
function closeSockets() {
  for (const s of state.sockets) { try { s.ws.close(1000) } catch { /* gone */ } s.closedPerf = performance.now() }
  state.sockets = []
}

/* ------------------------------------------------------------------ main */

let exitCode = 2
let R = null
try {
  const machine = machineInfo()
  log(`profile ${profileName}: ${cfg.orgs} organisations x ${cfg.users} people; machine ${machine.cpu}, ${machine.cores} CPUs, ${machine.ramGB} GB (${machine.freeRamGB} GB free), ${machine.disk}`)
  // an estimate of what the fleet needs before anything starts: refuse a run this machine cannot hold
  const needGB = cfg.orgs * 0.35 + 2
  if (machine.freeRamGB < needGB) throw new Error(`about ${r1(needGB)} GB of free memory are needed for ${cfg.orgs} installs; ${machine.freeRamGB} GB are free. Run fewer (--orgs).`)
  ctx.photo = await noisePng(220, 220, 7)

  log(`starting the private PostgreSQL on 127.0.0.1:${cfg.pgPort} (data under ${path.relative(root, runDir)})`)
  state.cluster = await startCluster({ port: cfg.pgPort, runDir, fsync: cfg.fsync, sharedBuffers: cfg.sharedBuffers, slowMs: cfg.slowMs, maxConnections: 300 })
  ctx.cluster = state.cluster
  {
    const c = await state.cluster.admin()
    try {
      for (const d of ['postgres', 'template1']) await c.query(`REVOKE CONNECT ON DATABASE "${d}" FROM PUBLIC`)
      if (state.cluster.statements) await c.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
    } finally { await c.end() }
  }
  log(`PostgreSQL ${state.cluster.version}, pid ${state.cluster.pid}, fsync ${cfg.fsync ? 'on' : 'off'}, pg_stat_statements ${state.cluster.statements ? 'on' : 'not available'}`)

  log(`provisioning ${cfg.orgs} installs, ${cfg.parallel} at a time`)
  const tp = performance.now()
  const installs = await pool(Array.from({ length: cfg.orgs }, (_, i) => i), cfg.parallel, (i) => createInstall({ cluster: state.cluster, runDir, basePort: cfg.basePort, heapMB: cfg.heapMB }, i, log).then((inst) => { state.installs.push(inst); return inst }))
  state.installs = installs
  for (const i of installs) ctx.agents.set(i.key, agentFor({ maxSockets: 48 }))
  const provisionS = (performance.now() - tp) / 1000
  log(`provisioned in ${r1(provisionS)} s`)

  log('seeding the organisations (pack, people, history, chat, report, flows on)')
  const ts = performance.now()
  state.orgs = await pool(installs, cfg.parallel, (inst) => seedOrg(ctx, inst, cfg, log))
  const seedS = (performance.now() - ts) / 1000
  log(`seeded in ${r1(seedS)} s`)

  // who is active (concurrent people): one of each role, the rest operators
  for (const org of state.orgs) {
    const by = (r) => org.people.filter((p) => p.user.role === r)
    // two inspectors when there are two: an NCR's approver is never the inspector who raised it nor its sender
    const pick = [by('PlantManager')[0], by('Supervisor')[0], by('Quality')[0], by('Maintenance')[0], by('Quality')[1]].filter(Boolean)
    for (const p of [...by('Operator'), ...by('Supervisor').slice(1), ...by('Quality').slice(1), ...by('Maintenance').slice(1), org.admin]) if (pick.length < cfg.activePerOrg && !pick.includes(p)) pick.push(p)
    org.active = pick.slice(0, cfg.activePerOrg)
  }

  log(`opening ${cfg.socketsPerOrg * cfg.orgs} live sockets`)
  for (const org of state.orgs) await openSockets(org)
  const socketsOpen = state.sockets.length

  // samplers
  const pidsOf = () => state.installs.filter((i) => i.child?.exitCode === null).map((i) => ({ pid: i.child.pid, label: i.key }))
  const procS = processSampler({ dir: runDir, intervalMs: cfg.sampleMs, pids: pidsOf, postmaster: state.cluster.pid, phase: () => rec.phase })
  procS.start()
  state.samplers.push(procS)
  const probes = loopProbes(state.installs, { intervalMs: cfg.probeMs, phase: () => rec.phase })
  probes.start()
  state.samplers.push(probes)
  const pgs = await pgSampler(state.cluster, state.installs, { connMs: cfg.pgConnMs, queueMs: cfg.pgQueueMs, phase: () => rec.phase })
  pgs.start()
  state.samplers.push(pgs)
  const health = []
  let healthStop = false
  const healthLoop = (async () => {
    while (!healthStop) {
      for (const org of state.orgs) {
        const r = await org.admin.req('GET', '/admin/health', { record: false, timeout: 30_000 })
        const h = r.json()
        if (h) health.push({ t: Date.now(), org: org.inst.key, sockets: h.live?.connections, users: h.live?.users, rss: h.process?.rssBytes, jobs: h.jobs, phase: rec.phase })
      }
      for (let k = 0; k < cfg.healthMs / 500 && !healthStop; k++) await sleep(500)
    }
  })()
  state.samplers.push({ stop: async () => { healthStop = true; await healthLoop } })

  const disk0 = { db: await pgs.sizes(), data: folderBytes(state.cluster.data), installs: folderBytes(path.join(runDir, 'installs')) }
  const stats0 = await pgs.dbStats()
  const pgLogStart = fs.statSync(state.cluster.logFile).size
  await pgs.resetStatements()
  const tRun = Date.now()

  // the phases (measured several times on the same fleet with --repeat)
  const measured = []
  const reps = cfg.repeat
  for (let r = 1; r <= reps; r++) {
    for (const ph of cfg.phases) {
      const label = reps > 1 ? `${ph.name}#${r}` : ph.name
      if (ph.idle) closeSockets()
      await runPhase(ph, label)
      if (ph.name !== 'warmup' && ph.name !== 'drain') measured.push(label)
    }
    if (r < reps) { log('reopening the live sockets for the next repetition'); for (const org of state.orgs) await openSockets(org) }
  }

  // the ramp: steps until a service level breaks
  let ramp = null
  if (cfg.rampRates) {
    ramp = { steps: [] }
    for (const rate of cfg.rampRates) {
      const label = `ramp-${rate}`
      await runPhase({ name: label, s: cfg.rampStepS, rate }, label)
      measured.push(label)
      const v = verdict({ proc: procS.samples, installs: state.installs, postmaster: state.cluster.pid, pg: pgs.samples, jobs: pgs.jobs, probes: probes.data, serverRamGB: cfg.serverRamGB, pool: 6 }, rec, live, [label], cfg.thresholds)
      // the knee is where people would notice: latency, errors, live delivery. The event-loop probe is shown but does
      // not stop the ramp (one print on one install moves its p99 over 100 ms at any load: see the probe-spike observation)
      const broken = v.rows.filter((x) => !x.pass && /^(read|write|p99|errors|live)/.test(x.name)).map((x) => x.name.replace(/ \(.*\)/, ''))
      ramp.steps.push({ rate, achieved: phaseLog.at(-1).achieved, st: v.st, rs: v.rs, pass: !broken.length, broken })
      log(`ramp ${rate}/s: read p95 ${r1(v.st.read.p95)}, write p95 ${r1(v.st.write.p95)}, p99 ${r1(v.st.all.p99)}, errors ${r1(v.st.errorRate * 100)} %, probe p99 ${r1(v.rs.probeWorstP99)} ms, machine CPU ${r1(v.rs.machine.mean)} %${broken.length ? ` -> broken: ${broken.join(', ')}` : ''}`)
      if (broken.length) break
    }
  }
  await runPhase({ name: 'grace', s: profileName === 'smoke' ? 8 : 15, rate: 0 }, 'grace')
  const tEnd = Date.now()

  // after the run: integrity, PostgreSQL, disk
  log('checking integrity and collecting the PostgreSQL figures')
  const accounted = live.account(ctx.integrity.created.map((x) => x.id))
  const integrity = []
  let dupRows = 0
  let flowRuns = {}
  let remindersSent = 0
  let remindersDue = 0
  let jobsDead = 0
  let ncrsRaised = 0
  let mrsRaised = 0
  for (const org of state.orgs) {
    const c = await state.cluster.admin(org.inst.dbName, 'ab_load_check')
    try {
      const src = (await c.query(`SELECT source FROM env_default.ab_tables WHERE id = $1`, [org.ids.ProductionLog])).rows[0].source
      const ids = ctx.integrity.created.filter((x) => x.org === org.inst.key).map((x) => x.id)
      const got = (await c.query(`SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM env_default."${src}" WHERE id::text = ANY($1::text[])`, [ids])).rows[0]
      if (got.n !== ids.length) integrity.push({ name: `${org.inst.key}: phone rows answered 200 but missing`, value: `**${ids.length - got.n}** of ${ids.length}` })
      // same machine, same time, same values twice (a duplicate send would look like this)
      dupRows += (await c.query(`SELECT count(*)::int AS n FROM (SELECT "Machine", "LoggedOn", "Good", "Scrap", count(*) AS k FROM env_default."${src}" WHERE "createdOn" >= to_timestamp($1 / 1000.0) AND coalesce("Notes", '') <> 'bulk' GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) x`, [tRun])).rows[0].n
      for (const r of (await c.query(`SELECT state, count(*)::int AS n FROM env_default.ab_flow_runs WHERE created_on >= to_timestamp($1 / 1000.0) GROUP BY 1`, [tRun])).rows) flowRuns[r.state] = (flowRuns[r.state] ?? 0) + r.n
      const tids = ctx.integrity.tasks.filter((x) => x.org === org.inst.key && x.id && x.remind < tEnd - 75_000).map((x) => x.id)
      if (tids.length) {
        const asrc = (await c.query(`SELECT source FROM env_default.ab_tables WHERE name = 'Activities'`)).rows[0]?.source
        if (asrc) {
          remindersDue += tids.length
          remindersSent += (await c.query(`SELECT count(*)::int AS n FROM env_default."${asrc}" WHERE id::text = ANY($1::text[]) AND "ReminderSentOn" IS NOT NULL`, [tids])).rows[0].n
        }
      }
      jobsDead += (await c.query(`SELECT count(*)::int AS n FROM env_default.ab_jobs WHERE state = 'dead' AND modified_on >= to_timestamp($1 / 1000.0)`, [tRun])).rows[0].n
      const nsrc = (await c.query(`SELECT source FROM env_default.ab_tables WHERE id = $1`, [org.ids.NCRs])).rows[0].source
      ncrsRaised += (await c.query(`SELECT count(*)::int AS n FROM env_default."${nsrc}" WHERE "createdOn" >= to_timestamp($1 / 1000.0)`, [tRun])).rows[0].n
      const msrc = (await c.query(`SELECT source FROM env_default.ab_tables WHERE id = $1`, [org.ids.MaintenanceRequests])).rows[0].source
      mrsRaised += (await c.query(`SELECT count(*)::int AS n FROM env_default."${msrc}" WHERE "createdOn" >= to_timestamp($1 / 1000.0)`, [tRun])).rows[0].n
      org.failedFlows = (await c.query(`SELECT flow_name, count(*)::int AS n, max(left(error::text, 160)) AS e FROM env_default.ab_flow_runs WHERE state = 'failed' AND created_on >= to_timestamp($1 / 1000.0) GROUP BY 1`, [tRun]).catch(() => ({ rows: [] }))).rows
      org.deadJobTypes = (await c.query(`SELECT type, count(*)::int AS n, max(left(error::text, 200)) AS e FROM env_default.ab_jobs WHERE state IN ('dead', 'failed') AND modified_on >= to_timestamp($1 / 1000.0) GROUP BY 1`, [tRun])).rows
    } finally { await c.end() }
  }
  const deadTypes = new Map()
  for (const org of state.orgs) for (const d of org.deadJobTypes ?? []) { const x = deadTypes.get(d.type) ?? { n: 0, e: d.e }; x.n += d.n; deadTypes.set(d.type, x) }
  integrity.push(
    { name: 'phone rows created (200) / replays with the same Idempotency-Key / replays answered with another row', value: `${ctx.integrity.created.length} / ${ctx.integrity.replays} / ${ctx.integrity.replayMismatch.length}` },
    { name: 'the same production entry stored twice (machine, time, quantities)', value: dupRows ? `**${dupRows}**` : '0' },
    { name: 'shift-change entries sent', value: ctx.integrity.burst },
    { name: 'failed inspections -> NCRs created by the flow during the run', value: `${ctx.integrity.failedInspections} -> ${ncrsRaised}` },
    { name: 'breakdowns -> maintenance requests created by the flow', value: `${ctx.integrity.breakdowns} -> ${mrsRaised}` },
    { name: 'NCRs sent for approval / approvals answered', value: `${ctx.integrity.ncrSent} / ${ctx.integrity.approved}` },
    { name: 'flow runs started during the run, by state', value: JSON.stringify(flowRuns) },
    { name: 'failed flow runs, by flow', value: (() => { const m = new Map(); for (const o of state.orgs) for (const f of o.failedFlows ?? []) { const x = m.get(f.flow_name) ?? { n: 0, e: f.e }; x.n += f.n; m.set(f.flow_name, x) } return m.size ? [...m.entries()].map(([k, x]) => `${k} ${x.n} (${String(x.e ?? '').replace(/\|/g, '/').slice(0, 120)})`).join('; ') : 'none' })() },
    { name: 'jobs dead or failed during the run, by type', value: deadTypes.size ? [...deadTypes.entries()].map(([k, x]) => `${k} ${x.n} (${String(x.e ?? '').replace(/\|/g, '/').slice(0, 120)})`).join('; ') : 'none' },
    { name: 'harness-side errors (scenario code, not the server)', value: harnessErrors.size ? [...harnessErrors.entries()].slice(0, 8).map(([k, n]) => `${n} x ${k}`).join('; ').replace(/\|/g, '/') : 'none' },
    { name: 'installs that exited during the run', value: state.installs.filter((i) => i.exited).map((i) => `${i.key} (${JSON.stringify(i.exited)})`).join(', ') || 'none' },
  )
  const reminders = `${remindersSent} of ${remindersDue} due reminders stamped as sent; ${live.reminders.length} task notifications pushed to open sockets`

  const stats1 = await pgs.dbStats()
  const delta = { commits: 0, rollbacks: 0, deadlocks: 0, temp_bytes: 0, hit: 0 }
  let hit = 0
  let read = 0
  for (const s of stats1) {
    const a = stats0.find((x) => x.datname === s.datname) ?? { commits: 0, rollbacks: 0, deadlocks: 0, temp_bytes: 0, blks_hit: 0, blks_read: 0 }
    delta.commits += Number(s.commits) - Number(a.commits)
    delta.rollbacks += Number(s.rollbacks) - Number(a.rollbacks)
    delta.deadlocks += Number(s.deadlocks) - Number(a.deadlocks)
    delta.temp_bytes += Number(s.temp_bytes) - Number(a.temp_bytes)
    hit += Number(s.blks_hit) - Number(a.blks_hit)
    read += Number(s.blks_read) - Number(a.blks_read)
  }
  delta.hit = hit + read ? hit / (hit + read) : 1
  const statements = await pgs.statements()
  const disk1 = { db: await pgs.sizes(), data: folderBytes(state.cluster.data), installs: folderBytes(path.join(runDir, 'installs')) }
  const sumDb = (l) => l.reduce((s, x) => s + Number(x.b), 0)
  for (const s of state.samplers) await s.stop()
  state.samplers = []
  const pgLog = parsePgLog(state.cluster.logFile, new Map(state.installs.map((i) => [i.dbName, i.key])), pgLogStart)

  // the figures
  const res = { proc: procS.samples, installs: state.installs, postmaster: state.cluster.pid, pg: pgs.samples, jobs: pgs.jobs, probes: probes.data, serverRamGB: cfg.serverRamGB, pool: 6 }
  const idlePhases = measured.filter((x) => x.startsWith('idle'))
  const verdicts = []
  const exitPhases = (base) => measured.filter((x) => x.split('#')[0] === base)
  for (const pair of [['steady', 'steady (50 req/s target)'], ['peak', 'peak'], ['noisy', 'heavy tenant window'], ['burst', 'shift change']]) {
    const ph = exitPhases(pair[0])
    if (ph.length) {
      for (const one of ph) {
        const v = verdict(res, rec, live, [one], cfg.thresholds, { idle: idlePhases.length ? [idlePhases[0]] : null })
        verdicts.push({ label: `${one} - ${pair[1]}`, ...v })
      }
    }
  }
  if (ramp) {
    const firstBad = ramp.steps.find((x) => !x.pass)
    const lastOk = [...ramp.steps].reverse().find((x) => x.pass)
    ramp.knee = firstBad ? `between ${lastOk ? `${lastOk.rate} req/s (held: achieved ${r1(lastOk.achieved)})` : 'the first step'} and ${firstBad.rate} req/s (${firstBad.broken.join(', ')})` : `not reached up to ${ramp.steps.at(-1)?.rate} req/s`
    const s = firstBad ?? ramp.steps.at(-1)
    if (s) {
      const hottest = [...s.rs.perInstall].sort((a, b) => (b.cpuMax ?? 0) - (a.cpuMax ?? 0))[0]
      const reasons = []
      if ((s.rs.machine.mean ?? 0) > 85) reasons.push(`the machine itself (CPU ${r1(s.rs.machine.mean)} % busy across all ${os.cpus().length} logical CPUs, other work included)`)
      if ((hottest?.cpuMax ?? 0) > 85) reasons.push(`one install's single event loop (${hottest.key}: ${r1(hottest.cpuMax)} % of one core at peak, probe p99 ${r1(hottest.probe.p99)} ms)`)
      if (s.rs.poolSaturatedShare > 0.2) reasons.push(`the database pool of 6 (${r1(s.rs.poolSaturatedShare * 100)} % of samples with every pooled connection active)`)
      if ((s.rs.pgCpu.mean ?? 0) > 300) reasons.push(`PostgreSQL CPU (${r1(s.rs.pgCpu.mean)} % of one core)`)
      if (s.rs.lockWaitMax > 3) reasons.push(`lock waits (up to ${s.rs.lockWaitMax} backends waiting)`)
      if ((s.rs.harness.mean ?? 0) > 80) reasons.push(`the load generator itself (${r1(s.rs.harness.mean)} % of one core): the numbers above this step are client-bound`)
      ramp.bottleneck = reasons.length ? reasons.join('; ') : `none of the watched resources was saturated at ${s.rate} req/s (installs at most ${r1(hottest?.cpuMax)} % of a core, PostgreSQL ${r1(s.rs.pgCpu.mean)} %, machine ${r1(s.rs.machine.mean)} %): latency rose from queueing across many small resources`
    }
  }
  const byPhase = phaseLog.filter((x) => x.name !== 'grace').map((x) => ({ ...x, st: phaseStats(rec, [x.name]), rs: resources(res, [x.name]), harnessLoopP99: null }))
  const allRs = resources(res, measured)
  // 30 s timeline
  const timeline = []
  {
    const tot = resources(res, [...new Set(procS.samples.map((s) => s.phase))]).totals
    const t0 = tot[0]?.t ?? Date.now()
    const bucket = new Map()
    for (const x of tot) {
      const k = Math.floor((x.t - t0) / 30_000)
      const b = bucket.get(k) ?? { n: 0, instCpu: 0, pgCpu: 0, machine: 0, instWs: 0, pgWs: 0, phase: procS.samples.find((s) => s.t === x.t)?.phase }
      b.n++
      b.instCpu += x.instCpu; b.pgCpu += x.pgCpu; b.machine += x.machine ?? 0
      b.instWs = Math.max(b.instWs, x.instWs); b.pgWs = Math.max(b.pgWs, x.pgWs)
      bucket.set(k, b)
    }
    for (const [k, b] of [...bucket.entries()].sort((a, c) => a[0] - c[0])) {
      const pgc = pgs.samples.filter((s) => s.t >= t0 + k * 30_000 && s.t < t0 + (k + 1) * 30_000)
      timeline.push({ t: k * 30, phase: b.phase, instCpu: b.instCpu / b.n, pgCpu: b.pgCpu / b.n, machine: b.machine / b.n, instWs: b.instWs, pgWs: b.pgWs, pgConn: pgc.length ? Math.max(...pgc.map((s) => s.total)) : null })
    }
    if (timeline.length > 120) { const step = Math.ceil(timeline.length / 120); for (let k = timeline.length - 1; k >= 0; k--) if (k % step) timeline.splice(k, 1) }
  }
  // noisy neighbour
  let noisy = null
  const noisyPh = exitPhases('noisy')[0]
  const steadyPh = exitPhases('steady')[0]
  if (noisyPh && steadyPh && state.orgs.length > 1) {
    const others = state.orgs.slice(1).map((o) => o.inst.key)
    const pool95 = (ph, cls) => pct(others.flatMap((k) => rec.byOrg.get(`${ph}|${k}|${cls}`) ?? []), 0.95)
    const rows = ['read', 'write'].map((cls) => { const b = pool95(steadyPh, cls); const n = pool95(noisyPh, cls); return { label: `${cls} (${others.length} other installs pooled)`, base: b, noisy: n, ok: n !== null && b !== null && n - b <= Math.max(0.25 * b, 100) } })
    for (const k of others.slice(0, 3)) { const b = orgStats(rec, steadyPh, k, 'read').p95; const n = orgStats(rec, noisyPh, k, 'read').p95; rows.push({ label: `read, ${k}`, base: b, noisy: n, ok: n !== null && b !== null && n - b <= Math.max(0.25 * b, 100) }) }
    const nr = resources(res, [noisyPh]).perInstall.find((x) => x.key === state.orgs[0].inst.key)
    noisy = { work: noisyWork, others: rows, heavyCpuMax: nr?.cpuMax, heavyRssMax: nr?.wsMax, heavyProbeP99: nr?.probe.p99 }
  }
  const comp = composition(cfg.users).reduce((m, c) => { m[c.role] = (m[c.role] ?? 0) + 1; return m }, { Admin: 1 })
  const seedCounts = state.orgs[1]?.counts ?? state.orgs[0].counts
  const activeTotal = cfg.activePerOrg * cfg.orgs
  const steadyRate = cfg.phases.find((p) => p.name === 'steady')?.rate ?? cfg.rampRates?.[0] ?? 1
  const thinkS = activeTotal / (steadyRate / reqPerAction)
  const machineBusy = allRs.machine.mean
  const hl = probes.harnessLoop
  const harnessLoopP99 = hl.count ? hl.percentile(99) / 1e6 : null
  const observations = []
  const worst = [...allRs.perInstall].sort((a, b) => (b.cpuMax ?? 0) - (a.cpuMax ?? 0))[0]
  observations.push(`Machine CPU during the measured phases: mean ${r1(machineBusy)} %, p95 ${r1(allRs.machine.p95)} % of all ${os.cpus().length} logical CPUs (other work on this PC included); installs together mean ${r1(allRs.instCpu.mean)} % of one core, PostgreSQL ${r1(allRs.pgCpu.mean)} % (lower bound: backends that end between samples lose their last interval; ${procS.samples.reduce((s, x) => s + x.gone, 0)} such ends), the harness ${r1(allRs.harness.mean)} % of one core with event-loop delay p99 ${r1(harnessLoopP99)} ms.`)
  if (worst) observations.push(`Busiest install: ${worst.key} at ${r1(worst.cpuMax)} % of one core at peak (5 s samples), probe p99 ${r1(worst.probe.p99)} ms; the median install's CPU mean was ${r1(pct(allRs.perInstall.map((x) => x.cpuMean ?? 0), 0.5))} %.`)
  observations.push(`Memory: installs ${MB(allRs.instWsMax)} MB together at most (${r1(allRs.instWsMax / Math.max(1, cfg.orgs) / 2 ** 20)} MB per install on average), PostgreSQL private memory ${MB(allRs.pgWsMax)} MB at most (shared_buffers ${String(cfg.sharedBuffers).replace(/'/g, '')} is shared memory, counted once by the OS but not in these private figures).`)
  observations.push(`PostgreSQL connections peaked at ${allRs.pgConnMax} of max_connections ${pgs.maxConn}; ${r1(allRs.poolSaturatedShare * 100)} % of per-install samples had every pooled connection active.`)
  {
    // probe spikes: one install alone (its own work: a PDF, an import) or several at once (a machine-wide stall)
    const bySec = new Map()
    for (const [k, l] of probes.data) for (const x of l) if (x.ms > 50 && measured.includes(x.phase)) { const sec = Math.round(x.t / 1000); const a = bySec.get(sec) ?? new Set(); a.add(k); bySec.set(sec, a) }
    const near = (sec) => { const u = new Set(); for (let d = -1; d <= 1; d++) for (const k of bySec.get(sec + d) ?? []) u.add(k); return u.size }
    const secs = [...bySec.keys()]
    const shared = secs.filter((x) => near(x) >= 3).length
    observations.push(`Event-loop probe spikes over 50 ms: ${secs.length} seconds with one; in ${shared} of them 3 or more installs spiked within the same 3 seconds (a machine-wide stall: CPU or disk of the shared PC), in ${secs.length - shared} only one or two (an install's own work).`)
  }
  if (machineBusy > 70) observations.push(`The machine was busy (${r1(machineBusy)} % mean): latencies here include waiting for CPU behind other work and are NOT capacity figures.`)
  const caveats = [
    `Developer PC shared with other heavy work (two other agents were running); ${cfg.fsync ? 'the private PostgreSQL cluster ran with fsync ON (unlike the shared sandbox, which runs fsync off)' : 'the private PostgreSQL cluster ran with fsync OFF'}; Windows, not the Linux target; no Caddy (the harness sends the proxy headers itself), no TLS, no systemd limits. These are comparisons, NOT capacity figures for a server.`,
    'All installs, PostgreSQL and the load generator share one machine: the generator\'s own CPU and event-loop delay are reported; client-side delay inflates every latency equally.',
    'Event-loop lag is not exposed by the server; the probe (an unknown /api/v1 route answered without the database, every second) is an upper bound of the loop delay at 1 s resolution.',
    'Email is not exercised: hosted installs refuse loopback SMTP (APPBUILDER_OUTBOUND_PRIVATE=deny) and the fleet relay does not exist yet; notification emails and the daily OEE email step fail or are skipped, their PDF generation runs.',
    `PostgreSQL CPU is a lower bound on Windows (per-process times of the postmaster's children, sampled every ${cfg.sampleMs / 1000} s).`,
    'People are simulated by an open arrival process (Poisson) at the target request rate over a fixed set of concurrent people, one action at a time each; real people are burstier (shift starts, breaks), modelled only by the shift-change phase.',
    'The seeded history is generated (believable sizes and shapes, not real plant data); query plans on a real install with years of data may differ.',
  ]
  R = {
    profile: profileName, startedAt, caveat: caveats[0], cfg, machine, pgVersion: state.cluster.version, pgSettings: state.cluster.settings, pool: 6,
    composition: Object.entries(comp).map(([k, v]) => `${k} ${v}`).join(', '), socketsOpen, mix: MIX,
    seedSummary: `${seedCounts.ProductionLog} production rows, ${seedCounts.Downtime} stoppages, ${seedCounts.Inspections} inspections, ${seedCounts.NCRs} NCRs, ${seedCounts.MaintenanceRequests} maintenance requests, ${seedCounts.Activities} tasks, ${seedCounts.chat} chat messages over ${cfg.seedDays} days, ${cfg.machines} machines + 4 SAMPLE (organisation 1 as the heavy tenant${cfg.heavySeedFactor > 1 ? ` with ${cfg.heavySeedFactor}x the history` : ''}); provisioning ${r1(provisionS)} s, seeding ${r1(seedS)} s`,
    thinkTime: `derived from the rate: ${activeTotal} concurrent people at ${steadyRate} req/s (${r1(reqPerAction)} requests per action) act every ${r1(thinkS)} s on average (exponential gaps); the burst adds every operator of every organisation within ${cfg.phases.find((p) => p.burst)?.burst ?? '-'} s`,
    shed, skipped, phases: cfg.phases, verdicts, byPhase: byPhase.map((x) => ({ ...x, harnessLoopP99 })), scenarios: scenarioRows(rec, measured), dash: { total: ctx.dash.total, cached: ctx.dash.cached, failed: [...ctx.dash.failed.entries()].map(([k, n]) => `${n} x ${k}`) },
    live: accounted, reminders, perInstall: allRs.perInstall, timeline, pgConnMax: allRs.pgConnMax, pgMaxConn: pgs.maxConn, poolSaturated: allRs.poolSaturatedShare, lockWaitMax: allRs.lockWaitMax, lockWaitSamples: allRs.lockWaitSamples,
    pgLog, dbDelta: delta, statements: Array.isArray(statements) ? foldStatements(statements) : null, noisy, integrity,
    errors: [...rec.errors.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, x]) => ({ k, n: x.n, phases: [...x.phases].join(', '), orgs: x.orgs.size })),
    disk: [
      { what: 'install databases (sum of pg_database_size)', start: `${MB(sumDb(disk0.db))} MB`, end: `${MB(sumDb(disk1.db))} MB` },
      { what: 'PostgreSQL data folder (incl. WAL)', start: `${MB(disk0.data)} MB`, end: `${MB(disk1.data)} MB` },
      { what: 'install folders (workspace, attachments, logs)', start: `${MB(disk0.installs)} MB`, end: `${MB(disk1.installs)} MB` },
    ],
    ramp, observations, caveats, probeSeries: probes.data, health: health.slice(-cfg.orgs * 2), runSeconds: (tEnd - tRun) / 1000,
  }
  R.thresholdsPass = verdicts.filter((v) => !/heavy tenant|shift change/.test(v.label)).every((v) => v.pass) && accounted.table.lost === 0 && accounted.chat.lost === 0 && accounted.chat.duplicates === 0 && accounted.table.duplicates === 0 && !dupRows
  exitCode = R.thresholdsPass || ramp ? 0 : 1
} catch (e) {
  log(`the run could not complete: ${e?.stack ?? e}`)
  for (const i of state.installs) if (i.exited || i.child?.exitCode !== null) log(`  ${i.key} output: ${String(i.output).slice(-1500)}`)
  exitCode = 2
} finally {
  log('stopping the fleet and the private PostgreSQL')
  await stopAll()
  const left = liveChildren()
  if (left.length) log(`WARNING: ${left.length} child process(es) still running: ${left.map((c) => c.pid).join(', ')}`)
  log(`run folder ${KEEP ? 'kept' : 'removed'}: ${path.relative(root, runDir)}${fs.existsSync(runDir) ? ` (${MB(folderBytes(runDir))} MB)` : ''}`)
}

function foldStatements(list) {
  const m = new Map()
  for (const s of list) {
    const k = s.query.replace(/"env_[a-z0-9_]+"/g, '"env_*"').replace(/\$\d+/g, '$n')
    const x = m.get(k) ?? { query: k, calls: 0, total_ms: 0, max_ms: 0 }
    x.calls += Number(s.calls)
    x.total_ms += Number(s.total_ms)
    x.max_ms = Math.max(x.max_ms, Number(s.max_ms))
    m.set(k, x)
  }
  return [...m.values()].map((x) => ({ ...x, mean_ms: x.total_ms / Math.max(1, x.calls) })).sort((a, b) => b.total_ms - a.total_ms)
}

if (R) {
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const md = markdown(R)
  const out = opt('out') ?? path.join(reportsDir, `${profileName}-${stamp}.md`)
  fs.writeFileSync(out, md + '\n')
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify({ ...R, probeSeries: Object.fromEntries([...(R.probeSeries ?? new Map())].map(([k, l]) => [k, l.filter((x) => x.ms > 50)])), scenarios: R.scenarios.map((x) => ({ ...x, ms: undefined })), verdicts: R.verdicts.map((v) => ({ label: v.label, pass: v.pass, rows: v.rows })), byPhase: R.byPhase.map((x) => ({ name: x.name, s: x.s, rate: x.rate, achieved: x.achieved, st: { n: x.st.n, errors: x.st.errors, read: x.st.read, write: x.st.write, job: x.st.job, all: x.st.all }, machine: x.rs.machine, instCpu: x.rs.instCpu, pgCpu: x.rs.pgCpu })), ramp: R.ramp ? { ...R.ramp, steps: R.ramp.steps.map((x) => ({ rate: x.rate, achieved: x.achieved, pass: x.pass, broken: x.broken, read: x.st.read, write: x.st.write, all: x.st.all, errorRate: x.st.errorRate, probeWorstP99: x.rs.probeWorstP99, machine: x.rs.machine, pgCpu: x.rs.pgCpu, poolSaturated: x.rs.poolSaturatedShare, perInstallCpuMax: x.rs.perInstall.map((i) => i.cpuMax) })) } : null }, null, 1))
  for (const v of R.verdicts) log(`exit check 7 (${v.label}): ${v.pass ? 'PASS' : 'FAIL'} ${v.rows.map((r) => `${r.name.split(' (')[0]} ${r.value}${r.unit === 'ms' ? ' ms' : r.unit === '%' ? ' %' : ''}${r.pass ? '' : '!'}`).join(', ')}`)
  log(`live: table p95 ${r1(R.live.table.latency.p95)} ms, lost ${R.live.table.lost}/${R.live.table.expected}; chat p95 ${r1(R.live.chat.latency.p95)} ms, lost ${R.live.chat.lost}/${R.live.chat.expected}, duplicates ${R.live.chat.duplicates}`)
  log(`report: ${out}`)
  log(`profile thresholds: ${R.thresholdsPass ? 'PASS' : 'FAIL'}`)
}
process.exit(exitCode)
