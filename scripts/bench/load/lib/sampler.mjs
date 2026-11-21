/**
 * What the load harness samples while it runs (scripts/bench/load):
 *  - CPU and resident memory of every install process, every backend of the private PostgreSQL cluster (children of its
 *    postmaster) and the harness itself; the whole machine's CPU (to see when other work saturates it). Windows: one
 *    long-lived PowerShell loop over Win32_Process (one CIM query per interval, not a process per sample); Linux: /proc.
 *  - an event-loop probe per install: a request the router answers without the database (an unknown /api/v1 route,
 *    404) every second. The server exposes no event-loop delay (no monitorEventLoopDelay in server/**): this latency is
 *    an UPPER bound of the install's loop lag (it includes parsing and the loopback round trip, ~1 ms idle).
 *  - PostgreSQL: connections by database and state, lock waits, ungranted locks, per install the job queue (depth, age
 *    of the oldest due job, running, dead) and the outbox backlog; pg_stat_database before/after.
 *  - each install's /admin/health (live sockets the server counts, its RSS) every 30 s.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { WIN } from './util.mjs'

/* ------------------------------------------------------------------ processes */

const PS_LOOP = (pidFile, ms) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $ids = @(Get-Content -LiteralPath '${pidFile.replace(/'/g, "''")}')
  $pm = ($ids | Where-Object { $_ -like 'pm=*' } | Select-Object -First 1)
  $plain = @($ids | Where-Object { $_ -match '^[0-9]+$' })
  $parts = @($plain | ForEach-Object { "ProcessId=$_" })
  if ($pm) { $parts += "ParentProcessId=$($pm.Substring(3))"; $parts += "ProcessId=$($pm.Substring(3))" }
  if ($parts.Count -gt 0) {
    $f = $parts -join ' OR '
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter $f | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$([int64]$_.KernelModeTime + [int64]$_.UserModeTime),$($_.WorkingSetSize),$($_.PrivatePageCount)" })
    [Console]::Out.WriteLine("S " + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + " " + ($rows -join ';'))
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds ${ms}
}
`

function linuxSample(pids, pmPid) {
  const out = []
  const read = (pid) => {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ')
      const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024
      return { pid: Number(pid), ppid: Number(f[1]), cpu100ns: (Number(f[11]) + Number(f[12])) * 1e5, ws: rss, priv: rss }
    } catch { return null }
  }
  for (const p of pids) { const x = read(p); if (x) out.push(x) }
  if (pmPid) {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      const x = read(d)
      if (x && (x.ppid === pmPid || x.pid === pmPid)) out.push(x)
    }
  }
  return out
}

/**
 * processSampler({ dir, intervalMs, pids: () => [{ pid, label }], postmaster }) -> { start(), stop(), samples }
 * samples: [{ t, procs: Map(pid -> { cpuPct, ws, priv }), machineCpuPct, harnessCpuPct }]
 */
export function processSampler(o) {
  const pidFile = path.join(o.dir, 'pids.txt')
  const samples = []
  let prev = null
  let prevCpus = os.cpus()
  let prevHarness = process.cpuUsage()
  let prevT = performance.now()
  let ps = null
  let timer = null
  let buf = ''
  const writePids = () => {
    const lines = o.pids().map((x) => String(x.pid))
    if (o.postmaster) lines.push(`pm=${o.postmaster}`)
    fs.writeFileSync(pidFile, lines.join('\n') + '\n')
  }
  const machine = () => {
    const now = os.cpus()
    let busy = 0
    let total = 0
    now.forEach((c, k) => {
      const a = prevCpus[k]?.times ?? c.times
      const d = (x) => c.times[x] - a[x]
      const t = d('user') + d('nice') + d('sys') + d('idle') + d('irq')
      busy += t - d('idle')
      total += t
    })
    prevCpus = now
    return total > 0 ? (busy / total) * 100 : null
  }
  const ingest = (tMs, rows) => {
    const tp = performance.now()
    const cur = new Map(rows.map((r) => [r.pid, r]))
    const procs = new Map()
    if (prev) {
      const dt = tMs - prev.t
      for (const [pid, r] of cur) {
        const p = prev.cur.get(pid)
        procs.set(pid, { ppid: r.ppid, cpuPct: p && dt > 0 ? ((r.cpu100ns - p.cpu100ns) / 1e4 / dt) * 100 : null, ws: r.ws, priv: r.priv, isNew: !p })
      }
      // backends that ended in the window: their last CPU is lost (counted, so the report can say how often)
      let gone = 0
      for (const pid of prev.cur.keys()) if (!cur.has(pid)) gone++
      const hu = process.cpuUsage(prevHarness)
      prevHarness = process.cpuUsage()
      const harnessCpuPct = ((hu.user + hu.system) / 1000 / (tp - prevT)) * 100
      prevT = tp
      samples.push({ t: tMs, procs, machineCpuPct: machine(), harnessCpuPct, gone, phase: o.phase() })
    } else machine()
    prev = { t: tMs, cur }
  }
  return {
    samples,
    start() {
      writePids()
      if (WIN) {
        const script = path.join(o.dir, 'sampler.ps1')
        fs.writeFileSync(script, PS_LOOP(pidFile, o.intervalMs))
        ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        o.track?.(ps)
        ps.stdout.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!line.startsWith('S ')) continue
            const [, t, rest] = line.split(' ')
            const rows = (rest ?? '').split(';').filter(Boolean).map((x) => { const [pid, ppid, cpu, ws, priv] = x.split(',').map(Number); return { pid, ppid, cpu100ns: cpu, ws, priv } })
            ingest(Number(t), rows)
          }
        })
      } else {
        const tick = () => { ingest(Date.now(), linuxSample(o.pids().map((x) => x.pid), o.postmaster)); timer = setTimeout(tick, o.intervalMs) }
        tick()
      }
    },
    refresh: writePids,
    stop() {
      if (timer) clearTimeout(timer)
      if (ps) { try { ps.kill() } catch { /* gone */ } }
    },
  }
}

/* ------------------------------------------------------------------ event-loop probes */

export function loopProbes(installs, o) {
  const agents = new Map(installs.map((i) => [i.key, new http.Agent({ keepAlive: true, maxSockets: 1 })]))
  const data = new Map(installs.map((i) => [i.key, []]))
  const harnessLoop = monitorEventLoopDelay({ resolution: 10 })
  let timer = null
  let stopped = false
  const one = (inst) => new Promise((resolve) => {
    const t0 = performance.now()
    const req = http.request({ host: '127.0.0.1', port: inst.port, method: 'GET', path: '/api/v1/__load_probe', headers: { host: inst.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }, agent: agents.get(inst.key), timeout: 30_000 }, (res) => {
      res.resume()
      res.on('end', () => resolve({ ms: performance.now() - t0, status: res.statusCode }))
    })
    req.on('error', () => resolve({ ms: performance.now() - t0, status: 0 }))
    req.on('timeout', () => req.destroy())
    req.end()
  })
  return {
    data, harnessLoop,
    start() {
      harnessLoop.enable()
      const tick = async () => {
        if (stopped) return
        const phase = o.phase()
        await Promise.all(installs.map(async (i) => { if (i.child?.exitCode === null) { const r = await one(i); data.get(i.key).push({ t: Date.now(), ms: r.ms, status: r.status, phase }) } }))
        timer = setTimeout(tick, o.intervalMs)
      }
      tick()
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); harnessLoop.disable(); for (const a of agents.values()) a.destroy() },
  }
}

/* ------------------------------------------------------------------ PostgreSQL */

export async function pgSampler(cluster, installs, o) {
  const main = await cluster.admin('postgres', 'ab_load_sampler')
  const perDb = new Map()
  for (const i of installs) perDb.set(i.key, await cluster.admin(i.dbName, 'ab_load_sampler'))
  const samples = []
  const jobs = []
  let t1 = null
  let t2 = null
  let stopped = false
  const maxConn = Number((await main.query('SHOW max_connections')).rows[0].max_connections)
  const dbOf = new Map(installs.map((i) => [i.dbName, i.key]))
  const conns = async () => {
    const rows = (await main.query(`SELECT datname, state, wait_event_type, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND coalesce(application_name, '') NOT LIKE 'ab\\_load\\_%' GROUP BY 1, 2, 3`)).rows
    const locks = (await main.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0].n
    const byDb = {}
    let total = 0
    let active = 0
    let lockWaits = 0
    for (const r of rows) {
      const k = dbOf.get(r.datname) ?? r.datname ?? '(none)'
      byDb[k] ??= { total: 0, active: 0, idle: 0, idleInTx: 0 }
      byDb[k].total += r.n
      if (r.state === 'active') byDb[k].active += r.n
      else if (r.state === 'idle') byDb[k].idle += r.n
      else if (String(r.state).startsWith('idle in transaction')) byDb[k].idleInTx += r.n
      total += r.n
      if (r.state === 'active') active += r.n
      if (r.wait_event_type === 'Lock') lockWaits += r.n
    }
    samples.push({ t: Date.now(), total, active, lockWaits, ungranted: locks, byDb, phase: o.phase() })
  }
  const queue = async () => {
    for (const i of installs) {
      const c = perDb.get(i.key)
      try {
        const r = (await c.query(`SELECT
            count(*) FILTER (WHERE state IN ('queued', 'failed') AND run_at <= now())::int AS due,
            count(*) FILTER (WHERE state = 'running')::int AS running,
            count(*) FILTER (WHERE state = 'dead')::int AS dead,
            COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE state IN ('queued', 'failed') AND run_at <= now())), 0)::float8 AS oldest
          FROM env_default.ab_jobs WHERE state IN ('queued', 'failed', 'running', 'dead')`)).rows[0]
        const ob = (await c.query(`SELECT count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(created_on)), 0)::float8 AS age FROM env_default.ab_outbox WHERE dispatched_on IS NULL`)).rows[0]
        jobs.push({ t: Date.now(), org: i.key, due: r.due, running: r.running, dead: r.dead, oldestS: r.oldest, outbox: ob.n, outboxAgeS: ob.age, phase: o.phase() })
      } catch (e) { jobs.push({ t: Date.now(), org: i.key, error: e.message, phase: o.phase() }) }
    }
  }
  const loopA = async () => { while (!stopped) { await conns().catch(() => {}); await new Promise((r) => { t1 = setTimeout(r, o.connMs) }) } }
  const loopB = async () => { while (!stopped) { await queue().catch(() => {}); await new Promise((r) => { t2 = setTimeout(r, o.queueMs) }) } }
  const dbStats = async () => (await main.query(`SELECT datname, xact_commit::bigint AS commits, xact_rollback::bigint AS rollbacks, deadlocks::bigint AS deadlocks, temp_files::bigint AS temp_files, temp_bytes::bigint AS temp_bytes, blks_read::bigint AS blks_read, blks_hit::bigint AS blks_hit, conflicts::bigint AS conflicts FROM pg_stat_database WHERE datname LIKE 'ab\\_load\\_%'`)).rows
  const sizes = async () => (await main.query(`SELECT datname, pg_database_size(datname)::bigint AS b FROM pg_database WHERE datname LIKE 'ab\\_load\\_%'`)).rows
  return {
    samples, jobs, maxConn, dbStats, sizes, main,
    async statements(limit = 15) {
      if (!cluster.statements) return null
      try {
        return (await main.query(`SELECT d.datname, s.calls::bigint AS calls, round(s.total_exec_time::numeric, 1)::float8 AS total_ms, round(s.mean_exec_time::numeric, 2)::float8 AS mean_ms, round(s.max_exec_time::numeric, 1)::float8 AS max_ms, s.rows::bigint AS rows, left(regexp_replace(s.query, '\\s+', ' ', 'g'), 220) AS query FROM pg_stat_statements s LEFT JOIN pg_database d ON d.oid = s.dbid WHERE d.datname LIKE 'ab\\_load\\_%' ORDER BY s.total_exec_time DESC LIMIT $1`, [limit * 8])).rows
      } catch (e) { return { error: e.message } }
    },
    async resetStatements() { if (cluster.statements) await main.query('SELECT pg_stat_statements_reset()').catch(() => {}) },
    start() { loopA(); loopB() },
    async stop() {
      stopped = true
      clearTimeout(t1); clearTimeout(t2)
      await new Promise((r) => setTimeout(r, 200))
      for (const c of perDb.values()) await c.end().catch(() => {})
      await main.end().catch(() => {})
    },
  }
}

/** the PostgreSQL log: slow statements (normalised), lock waits, deadlocks, checkpoints, temporary files, errors */
export function parsePgLog(file, dbNames, from = 0) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8').slice(from) } catch { return null }
  const norm = (s) => s.replace(/\$\d+/g, '$n').replace(/'(?:[^']|'')*'/g, "'?'").replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/"env_[a-z0-9_]+"/g, '"env_*"').replace(/\s+/g, ' ').trim().slice(0, 200)
  const slow = new Map()
  let lockWaits = 0
  let deadlocks = 0
  let checkpoints = 0
  let temp = 0
  const errors = new Map()
  const lockExamples = []
  const lines = text.split(/\r?\n/)
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]
    const db = /db=(\S*)/.exec(l)?.[1] ?? ''
    const org = dbNames.get(db) ?? db
    const d = /duration: ([\d.]+) ms\s+(?:statement|execute [^:]*): (.*)$/.exec(l)
    if (d) {
      const key = norm(d[2])
      const x = slow.get(key) ?? { n: 0, maxMs: 0, totalMs: 0, orgs: new Set() }
      x.n++
      x.totalMs += Number(d[1])
      x.maxMs = Math.max(x.maxMs, Number(d[1]))
      x.orgs.add(org)
      slow.set(key, x)
      continue
    }
    if (/still waiting for/.test(l)) { lockWaits++; if (lockExamples.length < 5) lockExamples.push(`${org}: ${l.replace(/^.*?LOG:\s+/, '').slice(0, 200)} | ${(lines[k + 2] ?? '').replace(/^.*?STATEMENT:\s+/, '').slice(0, 160)}`) }
    if (/deadlock detected/.test(l)) deadlocks++
    if (/checkpoint complete/.test(l)) checkpoints++
    if (/temporary file:/.test(l)) temp++
    const e = /(ERROR|FATAL|PANIC):\s+(.*)$/.exec(l)
    if (e) { const key = `${e[1]} ${norm(e[2])}`; errors.set(key, (errors.get(key) ?? 0) + 1) }
  }
  return {
    slow: [...slow.entries()].map(([q, x]) => ({ q, n: x.n, maxMs: Math.round(x.maxMs), meanMs: Math.round(x.totalMs / x.n), orgs: x.orgs.size })).sort((a, b) => b.n * b.meanMs - a.n * a.meanMs),
    lockWaits, deadlocks, checkpoints, temp, lockExamples,
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1]),
  }
}
