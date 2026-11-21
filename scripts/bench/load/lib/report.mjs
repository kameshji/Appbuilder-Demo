/**
 * Numbers and the Markdown report of a load test run (scripts/bench/load).
 */
import { mean, pct, r0, r1, summary } from './util.mjs'

/** every request sample of a phase (or several), by class, with error counts */
export function phaseStats(rec, phases, o = {}) {
  const want = new Set([].concat(phases))
  const by = { read: [], write: [], job: [], heavy: [], auth: [] }
  const err = { read: 0, write: 0, job: 0, heavy: 0, auth: 0 }
  for (const [k, v] of rec.byKey) {
    const parts = k.split('|')
    if (parts.length !== 4 || !want.has(parts[0])) continue
    if (o.scenario && parts[1] !== o.scenario) continue
    const cls = parts[3]
    by[cls]?.push(...v)
    err[cls] = (err[cls] ?? 0) + (rec.byKey.get(`${k}|err`)?.length ?? 0)
  }
  const slo = [...by.read, ...by.write, ...by.job, ...by.auth]
  const n = slo.length
  const errors = err.read + err.write + err.job + err.auth
  return { by, err, n, errors, errorRate: n ? errors / n : 0, read: summary(by.read), write: summary(by.write), job: summary(by.job), auth: summary(by.auth), heavy: summary(by.heavy), all: summary(slo) }
}

/** per organisation and class in a phase (the noisy-neighbour comparison) */
export function orgStats(rec, phase, org, cls) {
  return summary(rec.byOrg.get(`${phase}|${org}|${cls}`) ?? [])
}

export function scenarioRows(rec, phases) {
  const want = new Set([].concat(phases))
  const rows = new Map()
  for (const [k, v] of rec.byKey) {
    const parts = k.split('|')
    if (parts.length !== 4 || !want.has(parts[0])) continue
    const key = `${parts[1]}/${parts[2]}`
    const x = rows.get(key) ?? { scenario: parts[1], step: parts[2], cls: parts[3], ms: [], errors: 0 }
    x.ms.push(...v)
    x.errors += rec.byKey.get(`${k}|err`)?.length ?? 0
    rows.set(key, x)
  }
  return [...rows.values()].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.step.localeCompare(b.step)).map((x) => ({ ...x, s: summary(x.ms) }))
}

/** resource figures of a phase from the samplers */
export function resources(res, phases) {
  const want = new Set([].concat(phases))
  const ps = res.proc.filter((s) => want.has(s.phase))
  const installPids = new Map(res.installs.map((i) => [i.pid, i.key]))
  const perInstall = new Map(res.installs.map((i) => [i.key, { cpu: [], ws: [], priv: [] }]))
  const totals = []
  for (const s of ps) {
    let instCpu = 0
    let instWs = 0
    let pgCpu = 0
    let pgWs = 0
    let pgN = 0
    for (const [pid, p] of s.procs) {
      const key = installPids.get(pid)
      if (key) {
        const x = perInstall.get(key)
        if (p.cpuPct !== null) x.cpu.push(p.cpuPct)
        x.ws.push(p.ws)
        x.priv.push(p.priv)
        instCpu += p.cpuPct ?? 0
        instWs += p.ws
      } else if (pid === res.postmaster || p.ppid === res.postmaster) {
        pgCpu += p.cpuPct ?? 0
        pgWs += p.priv
        pgN++
      }
    }
    totals.push({ t: s.t, instCpu, instWs, pgCpu, pgWs, pgN, machine: s.machineCpuPct, harness: s.harnessCpuPct, gone: s.gone })
  }
  const pgs = res.pg.filter((s) => want.has(s.phase))
  const jobs = res.jobs.filter((s) => want.has(s.phase) && !s.error)
  const probes = new Map()
  for (const [k, list] of res.probes) probes.set(k, list.filter((x) => want.has(x.phase)).map((x) => x.ms))
  return {
    perInstall: [...perInstall.entries()].map(([k, x]) => ({ key: k, cpuMean: mean(x.cpu), cpuP95: pct(x.cpu, 0.95), cpuMax: x.cpu.length ? Math.max(...x.cpu) : null, wsMax: x.ws.length ? Math.max(...x.ws) : null, wsLast: x.ws.at(-1) ?? null, wsFirst: x.ws[0] ?? null, privMax: x.priv.length ? Math.max(...x.priv) : null, probe: summary(probes.get(k) ?? []), pgMax: Math.max(0, ...pgs.map((s) => s.byDb[k]?.total ?? 0)), pgActiveMax: Math.max(0, ...pgs.map((s) => s.byDb[k]?.active ?? 0)), jobsDueMax: Math.max(0, ...jobs.filter((j) => j.org === k).map((j) => j.due)), jobsOldestMax: Math.max(0, ...jobs.filter((j) => j.org === k).map((j) => j.oldestS)), outboxMax: Math.max(0, ...jobs.filter((j) => j.org === k).map((j) => j.outbox)) })),
    totals,
    instCpu: summary(totals.map((t) => t.instCpu)),
    pgCpu: summary(totals.map((t) => t.pgCpu)),
    machine: summary(totals.map((t) => t.machine).filter((x) => x !== null)),
    harness: summary(totals.map((t) => t.harness)),
    memMax: Math.max(0, ...totals.map((t) => t.instWs + t.pgWs)),
    instWsMax: Math.max(0, ...totals.map((t) => t.instWs)),
    pgWsMax: Math.max(0, ...totals.map((t) => t.pgWs)),
    pgConnMax: Math.max(0, ...pgs.map((s) => s.total)),
    pgActiveMax: Math.max(0, ...pgs.map((s) => s.active)),
    lockWaitSamples: pgs.filter((s) => s.lockWaits > 0).length,
    lockWaitMax: Math.max(0, ...pgs.map((s) => s.lockWaits)),
    ungrantedMax: Math.max(0, ...pgs.map((s) => s.ungranted)),
    pgSamples: pgs.length,
    poolSaturatedShare: (() => { let hit = 0; let all = 0; for (const s of pgs) for (const v of Object.values(s.byDb)) { all++; if (v.active >= res.pool) hit++ } return all ? hit / all : 0 })(),
    probeAll: summary([...probes.values()].flat()),
    probeWorstP99: Math.max(0, ...[...probes.values()].map((l) => pct(l, 0.99) ?? 0)),
    jobsDueMax: Math.max(0, ...jobs.map((j) => j.due)),
    jobsOldestMax: Math.max(0, ...jobs.map((j) => j.oldestS)),
    outboxMax: Math.max(0, ...jobs.map((j) => j.outbox)),
  }
}

/** exit check 7 for one or more phases */
export function verdict(res, rec, live, phases, th, o = {}) {
  const st = phaseStats(rec, phases)
  const rs = resources(res, phases)
  const liveLat = [].concat(phases).flatMap((p) => live.tableLatByPhase.get(p) ?? [])
  const chatLat = [].concat(phases).flatMap((p) => live.chatLatByPhase.get(p) ?? [])
  const liveAll = summary([...liveLat, ...chatLat])
  const row = (name, value, limit, pass, unit = 'ms', note = '') => ({ name, value, limit, pass, unit, note })
  const rows = [
    row('read p95', r0(st.read.p95), th.readP95, st.read.p95 !== null && st.read.p95 <= th.readP95),
    row('write p95', r0(st.write.p95), th.writeP95, st.write.p95 !== null && st.write.p95 <= th.writeP95),
    row('p99 (reads, writes, prints, sign-ins)', r0(st.all.p99), th.p99, st.all.p99 !== null && st.all.p99 <= th.p99),
    row('errors', r1(st.errorRate * 100), r1(th.errorRate * 100), st.errorRate < th.errorRate, '%', `${st.errors} of ${st.n}`),
    row('live push p95 (table ticks and chat)', r0(liveAll.p95), th.liveP95, liveAll.p95 !== null && liveAll.p95 <= th.liveP95, 'ms', `${liveAll.n} deliveries`),
    row('event loop lag p99, worst install (probe: upper bound)', r0(rs.probeWorstP99), th.loopP99, rs.probeWorstP99 <= th.loopP99),
    row(`memory (installs + PostgreSQL) of a ${res.serverRamGB} GB server`, r1(rs.memMax / 2 ** 30), r1(res.serverRamGB * th.memoryShare), rs.memMax / 2 ** 30 <= res.serverRamGB * th.memoryShare, 'GB', `${r1((rs.memMax / 2 ** 30 / res.serverRamGB) * 100)} %`),
    row('PostgreSQL connections (peak)', rs.pgConnMax, th.pgConnections, rs.pgConnMax <= th.pgConnections, ''),
  ]
  if (o.idle) {
    const id = resources(res, o.idle)
    rows.push(row('idle fleet CPU (installs, no users)', r1(id.instCpu.mean), th.idleCpuPctOfOneCore, (id.instCpu.mean ?? 0) <= th.idleCpuPctOfOneCore, '% of one core', `PostgreSQL ${r1(id.pgCpu.mean)} % (lower bound)`))
  }
  return { rows, pass: rows.every((r) => r.pass), st, rs, liveAll }
}

const f = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '-' : d ? Number(x).toFixed(d) : String(Math.round(x)))
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map((h, k) => (k === 0 ? '---' : '---:')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')

export function markdown(R) {
  const L = []
  const p = (s = '') => L.push(s)
  p(`# Load test: profile \`${R.profile}\` (${R.startedAt.slice(0, 16).replace('T', ' ')} UTC)`)
  p()
  p(`**Caveat for every number below:** ${R.caveat}`)
  p()
  p('## Machine and configuration')
  p()
  p(table(['What', 'Value'], [
    ['Machine', `${R.machine.cpu}, ${R.machine.cores} logical CPUs, ${R.machine.ramGB} GB RAM, ${R.machine.disk}, ${R.machine.os}`],
    ['Node / PostgreSQL', `${R.machine.node} / ${R.pgVersion} (private cluster on 127.0.0.1:${R.cfg.pgPort})`],
    ['PostgreSQL settings', Object.entries(R.pgSettings).filter(([k]) => !/log_|unix_socket|listen|port|track_io/.test(k)).map(([k, v]) => `${k}=${String(v).replace(/'/g, '')}`).join(', ')],
    ['Installs', `${R.cfg.orgs} (one process + database + role each, hosted settings: pool ${R.pool}, job polling 5 s, heap limit ${R.cfg.heapMB} MB), ports ${R.cfg.basePort}-${R.cfg.basePort + R.cfg.orgs - 1}`],
    ['People', `${R.cfg.users} per organisation (${R.composition}); ${R.cfg.activePerOrg} active at once per organisation (${R.cfg.activePerOrg * R.cfg.orgs} in all); ${R.socketsOpen} live sockets`],
    ['Data per organisation (seeded)', R.seedSummary],
    ['Mix (actions per 100) and requests per action', Object.entries(R.mix).map(([k, v]) => `${k} ${v.weight} (${v.reqs})`).join(', ')],
    ['Think time', R.thinkTime],
    ['Harness caps', `at most ${R.cfg.maxInflight} actions in flight; a person does one action at a time; ${R.shed} actions shed, ${R.skipped} skipped (no idle person); provisioning ${R.cfg.parallel} installs at a time`],
    ['Phases', R.phases.map((x) => `${x.name} ${x.s} s at ${x.rate}/s${x.heavy ? ' + heavy tenant' : ''}${x.burst ? ' + shift change' : ''}${x.idle ? ' (no users, sockets closed)' : ''}`).join('; ')],
  ]))
  p()
  for (const v of R.verdicts) {
    p(`## Exit check 7 (${v.label}): **${v.pass ? 'PASS' : 'FAIL'}** as measured here`)
    p()
    p(table(['Criterion', 'Measured', 'Limit', 'Result', 'Note'], v.rows.map((r) => [r.name, `${r.value ?? '-'} ${r.unit}`, `${r.limit} ${r.unit}`, r.pass ? 'pass' : '**FAIL**', r.note])))
    p()
  }
  p('## Throughput and latency by phase')
  p()
  p(table(['Phase', 'Seconds', 'Target req/s', 'Achieved req/s', 'Requests', 'Errors', 'Read p50/p95/p99', 'Write p50/p95/p99', 'Print/job p95', 'Machine CPU mean', 'Harness loop p99'], R.byPhase.map((x) => [x.name, f(x.s), f(x.rate, 1), f(x.achieved, 1), x.st.n, `${x.st.errors} (${f(x.st.errorRate * 100, 2)} %)`, `${f(x.st.read.p50)} / ${f(x.st.read.p95)} / ${f(x.st.read.p99)}`, `${f(x.st.write.p50)} / ${f(x.st.write.p95)} / ${f(x.st.write.p99)}`, f(x.st.job.p95), `${f(x.rs.machine.mean)} %`, `${f(x.harnessLoopP99)} ms`])))
  p()
  p('## Scenarios (measured phases)')
  p()
  p(table(['Scenario / step', 'Class', 'n', 'p50', 'p95', 'p99', 'max', 'Errors'], R.scenarios.map((x) => [`${x.scenario} / ${x.step}`, x.cls, x.s.n, f(x.s.p50), f(x.s.p95), f(x.s.p99), f(x.s.max), x.errors ? `**${x.errors}** (${f((x.errors / x.s.n) * 100, 2)} %)` : '0'])))
  p()
  p(`Dashboard tiles: ${R.dash.total} results, ${R.dash.cached} served from the 20 s cache (${f((R.dash.cached / Math.max(1, R.dash.total)) * 100, 1)} %; writes to a tile's table drop its cache entries, so with phones writing all day most views are cold).${R.dash.failed.length ? ` Tiles that failed: ${R.dash.failed.slice(0, 6).join('; ')}` : ''}`)
  p()
  p('## Live delivery')
  p()
  const lv = R.live
  p(table(['What', 'Value'], [
    ['Sockets open at the start / closed by the server during the run', `${R.socketsOpen} / ${JSON.stringify(lv.closes)}`],
    ['Table tick latency (phone write sent -> row id on a subscriber socket) p50 / p95 / p99 / max', `${f(lv.table.latency.p50)} / ${f(lv.table.latency.p95)} / ${f(lv.table.latency.p99)} / ${f(lv.table.latency.max)} ms (${lv.table.latency.n} deliveries)`],
    ['Table ticks lost / duplicated', `${lv.table.lost} of ${lv.table.expected} expected / ${lv.table.duplicates}; ${lv.table.nullTicks} "table changed" ticks without row ids`],
    ['Chat push latency (send -> every member socket) p50 / p95 / p99 / max', `${f(lv.chat.latency.p50)} / ${f(lv.chat.latency.p95)} / ${f(lv.chat.latency.p99)} / ${f(lv.chat.latency.max)} ms (${lv.chat.latency.n} deliveries of ${lv.chat.sent} messages)`],
    ['Chat pushes lost / duplicated', `${lv.chat.lost} of ${lv.chat.expected} expected / ${lv.chat.duplicates}${lv.chat.senderOwnSocketsWithout ? ` (the sender's own sockets did not get ${lv.chat.senderOwnSocketsWithout} of their own messages: by design or not, listed separately)` : ''}`],
    ['Resyncs asked by the server', lv.resyncs],
    ['Task reminders', R.reminders],
  ]))
  if (lv.table.examples.length || lv.chat.examples.length) { p(); p(`Examples of lost pushes: ${JSON.stringify([...lv.table.examples, ...lv.chat.examples]).slice(0, 600)}`) }
  p()
  p('## Per install (measured phases)')
  p()
  p(table(['Install', 'CPU mean / p95 / max (% of one core)', 'RSS first / max / last (MB)', 'Probe p50 / p99 / max (ms)', 'DB conns max (active max)', 'Jobs due max / oldest (s)', 'Outbox max'], R.perInstall.map((x) => [x.key, `${f(x.cpuMean, 1)} / ${f(x.cpuP95, 1)} / ${f(x.cpuMax, 1)}`, `${f(x.wsFirst / 2 ** 20)} / ${f(x.wsMax / 2 ** 20)} / ${f(x.wsLast / 2 ** 20)}`, `${f(x.probe.p50, 1)} / ${f(x.probe.p99, 1)} / ${f(x.probe.max)}`, `${x.pgMax} (${x.pgActiveMax})`, `${x.jobsDueMax} / ${f(x.jobsOldestMax)}`, x.outboxMax])))
  p()
  p('## Totals over time (30 s buckets)')
  p()
  p(table(['t (s)', 'Phase', 'Installs CPU % (sum)', 'PostgreSQL CPU % (lower bound)', 'Machine CPU %', 'Installs RSS (MB)', 'PostgreSQL private (MB)', 'PG connections'], R.timeline.map((x) => [f(x.t), x.phase, f(x.instCpu), f(x.pgCpu), f(x.machine), f(x.instWs / 2 ** 20), f(x.pgWs / 2 ** 20), f(x.pgConn)])))
  p()
  p('## PostgreSQL')
  p()
  p(table(['What', 'Value'], [
    ['Connections peak (limit max_connections)', `${R.pgConnMax} (${R.pgMaxConn}); per install at most ${Math.max(0, ...R.perInstall.map((x) => x.pgMax))} (database CONNECTION LIMIT 12, pool ${R.pool} + LISTEN)`],
    ['Share of samples with an install using its whole pool (active backends >= pool)', `${f(R.poolSaturated * 100, 1)} %`],
    ['Lock waits (sampled: backends waiting on a lock) max / samples with any', `${R.lockWaitMax} / ${R.lockWaitSamples}`],
    ['Lock waits over deadlock_timeout (1 s, from the log) / deadlocks', `${R.pgLog?.lockWaits ?? '-'} / ${R.pgLog?.deadlocks ?? '-'} (pg_stat_database: ${R.dbDelta.deadlocks})`],
    ['Commits / rollbacks during the measured phases', `${R.dbDelta.commits} / ${R.dbDelta.rollbacks}`],
    ['Temporary files (log) / bytes (pg_stat_database)', `${R.pgLog?.temp ?? '-'} / ${R.dbDelta.temp_bytes}`],
    ['Checkpoints', R.pgLog?.checkpoints ?? '-'],
    ['Cache hit ratio', `${f(R.dbDelta.hit * 100, 2)} %`],
  ]))
  p()
  if (R.pgLog?.slow?.length) {
    p(`Slow statements (over ${R.cfg.slowMs} ms, from the log; literals folded):`)
    p()
    p(table(['Statement', 'n', 'mean ms', 'max ms', 'installs'], R.pgLog.slow.slice(0, 12).map((x) => [`\`${x.q.replace(/\|/g, '/').slice(0, 150)}\``, x.n, x.meanMs, x.maxMs, x.orgs])))
    p()
  } else { p(`No statement took longer than ${R.cfg.slowMs} ms.`); p() }
  if (R.pgLog?.lockExamples?.length) { p(`Lock waits: ${R.pgLog.lockExamples.map((x) => `\`${x.replace(/\|/g, '/')}\``).join('; ')}`); p() }
  if (Array.isArray(R.statements) && R.statements.length) {
    p('Top statements by total time (pg_stat_statements, measured phases, all installs folded):')
    p()
    p(table(['Statement', 'calls', 'total ms', 'mean ms', 'max ms'], R.statements.slice(0, 12).map((x) => [`\`${x.query.replace(/\|/g, '/').slice(0, 140)}\``, x.calls, f(x.total_ms), f(x.mean_ms, 2), f(x.max_ms)])))
    p()
  }
  if (R.pgLog?.errors?.length) { p(`PostgreSQL errors in the log: ${R.pgLog.errors.slice(0, 8).map(([k, n]) => `${n} x \`${k.replace(/\|/g, '/').slice(0, 140)}\``).join('; ')}`); p() }
  if (R.noisy) {
    p('## Noisy neighbour (the heavy tenant)')
    p()
    p(table(['Heavy work', 'ms', 'status', 'detail'], R.noisy.work.map((x) => [x.what, x.ms, x.status, x.detail])))
    p()
    p(table(['Other installs', 'steady p95 (ms)', 'noisy p95 (ms)', 'change', 'within max(25 %, 100 ms)'], R.noisy.others.map((x) => [x.label, f(x.base), f(x.noisy), x.base ? `${f(((x.noisy - x.base) / x.base) * 100)} %` : '-', x.ok ? 'yes' : '**no**'])))
    p()
    p(`Heavy install itself: CPU max ${f(R.noisy.heavyCpuMax)} % of one core, RSS max ${f(R.noisy.heavyRssMax / 2 ** 20)} MB, probe p99 ${f(R.noisy.heavyProbeP99)} ms.`)
    p()
  }
  p('## Integrity')
  p()
  p(table(['Check', 'Result'], R.integrity.map((x) => [x.name, x.value])))
  p()
  p('## Errors (grouped)')
  p()
  if (R.errors.length) p(table(['n', 'Status, scenario/step: message', 'Phases', 'Installs'], R.errors.slice(0, 25).map((x) => [x.n, `\`${x.k.replace(/\|/g, '/')}\``, x.phases, x.orgs])))
  else p('None.')
  p()
  p('## Disk')
  p()
  p(table(['What', 'Start', 'End'], R.disk.map((x) => [x.what, x.start, x.end])))
  p()
  if (R.ramp) {
    p('## Ramp')
    p()
    p(table(['Target req/s', 'Achieved', 'read p95', 'write p95', 'p99', 'errors %', 'probe p99 worst', 'max install CPU %', 'PG CPU %', 'machine CPU %', 'pool saturated', 'SLO'], R.ramp.steps.map((x) => [x.rate, f(x.achieved, 1), f(x.st.read.p95), f(x.st.write.p95), f(x.st.all.p99), f(x.st.errorRate * 100, 2), f(x.rs.probeWorstP99), f(Math.max(0, ...x.rs.perInstall.map((i) => i.cpuMax ?? 0))), f(x.rs.pgCpu.mean), f(x.rs.machine.mean), `${f(x.rs.poolSaturatedShare * 100, 1)} %`, x.pass ? 'ok' : `**broken: ${x.broken.join(', ')}**`])))
    p()
    p(`Knee: ${R.ramp.knee}. First bottleneck: ${R.ramp.bottleneck}.`)
    p()
  }
  p('## Observations')
  p()
  for (const x of R.observations) p(`- ${x}`)
  p()
  p('## Caveats')
  p()
  for (const x of R.caveats) p(`- ${x}`)
  p()
  return L.join('\n')
}
