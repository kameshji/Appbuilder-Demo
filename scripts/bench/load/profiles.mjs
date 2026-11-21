/**
 * Profiles and the scenario mix of the load test (scripts/bench/load). Every value can be overridden on the command
 * line (`--orgs 5 --users 20 --steady-s 300 ...`, see run.mjs). The reasoning behind the defaults is in
 * docs/dev/load-testing.md.
 */

/**
 * The day of a small manufacturer, as actions per 100 (weights) and the requests one action makes (nominal, used to
 * turn a target request rate into an action rate). Operators log production on phones all shift long; supervisors and
 * the plant manager watch lists and dashboards; quality inspects with photos and handles NCRs; chat is the plant's
 * radio; tasks and the bell are glanced at; a few people sign in again (new device, new morning).
 */
export const MIX = {
  open_app: { weight: 20, reqs: 2 },
  next_page: { weight: 8, reqs: 1 },
  record_view: { weight: 12, reqs: 2 },
  phone_log: { weight: 18, reqs: 1.25 },
  downtime: { weight: 4, reqs: 1 },
  inspection: { weight: 5, reqs: 2.1 },
  ncr_send: { weight: 1.5, reqs: 2 },
  ncr_approve: { weight: 1.5, reqs: 1.5 },
  dashboard: { weight: 7, reqs: 1 },
  print: { weight: 2, reqs: 2 },
  chat: { weight: 10, reqs: 1 },
  task: { weight: 3, reqs: 1 },
  inbox: { weight: 6, reqs: 2 },
  sign_in: { weight: 2, reqs: 2 },
}

/** exit check 7 of docs/plan/hosting-spec.md */
export const EXIT7 = {
  readP95: 300, writeP95: 500, p99: 1000, errorRate: 0.001, liveP95: 500, loopP99: 100, memoryShare: 0.75, pgConnections: 250, idleCpuPctOfOneCore: 10,
}

const base = {
  seed: 20261121,
  pgPort: 5401,
  basePort: 5411,
  parallel: 3,
  heapMB: 1024,
  fsync: true,
  sharedBuffers: "'1GB'",
  slowMs: 250,
  machines: 8,
  inspectionsPerDay: 4,
  openNcrs: 6,
  tasksPerPerson: 15,
  importChunk: 400,
  heavySeedFactor: 1,
  replayP: 0.15,
  photoP: 0.1,
  maxInflight: 256,
  sampleMs: 5000,
  probeMs: 1000,
  pgConnMs: 5000,
  pgQueueMs: 15_000,
  healthMs: 30_000,
  crm: false,
  repeat: 1,
  // the server this would run on, for the memory share of exit check 7 (DC-12)
  serverRamGB: 32,
  serverVcpu: 8,
}

export const PROFILES = {
  /** under 3 minutes, safe for CI and a developer PC: 3 organisations x 10 people, every scenario, a small heavy tenant */
  smoke: {
    ...base,
    orgs: 3, users: 10, activePerOrg: 6, socketsPerOrg: 7, seedDays: 10, chatHistory: 30, parallel: 3, tasksPerPerson: 5, inspectionsPerDay: 3,
    heavy: true, heavyImportRows: 400, heavyPdfRecords: 30,
    phases: [
      { name: 'warmup', s: 8, rate: 5 },
      { name: 'steady', s: 35, rate: 7.5, background: 15 },
      { name: 'noisy', s: 15, rate: 7.5, heavy: true },
      { name: 'burst', s: 12, rate: 7.5, burst: 12 },
      { name: 'peak', s: 12, rate: 15 },
      { name: 'drain', s: 5, rate: 0 },
      { name: 'idle', s: 12, rate: 0, idle: true },
    ],
    thresholds: { ...EXIT7, readP95: 600, writeP95: 1000, p99: 2500, errorRate: 0.01, liveP95: 1000, loopP99: 250 },
  },
  /** the target (DC-11): 20 organisations x 50 people, 150 concurrent, 200 sockets, 50 requests/s for 30 minutes, then 100/s for 5 */
  pilot: {
    ...base,
    orgs: 20, users: 50, activePerOrg: 8, socketsPerOrg: 10, seedDays: 180, chatHistory: 300, parallel: 3,
    heavy: true, heavyImportRows: 10_000, heavyPdfRecords: 500,
    phases: [
      { name: 'warmup', s: 60, rate: 25 },
      { name: 'steady', s: 1800, rate: 50, background: 300 },
      { name: 'noisy', s: 180, rate: 50, heavy: true },
      { name: 'burst', s: 60, rate: 50, burst: 60 },
      { name: 'peak', s: 300, rate: 100 },
      { name: 'drain', s: 30, rate: 0 },
      { name: 'idle', s: 60, rate: 0, idle: true },
    ],
    thresholds: { ...EXIT7 },
  },
  /** more load step by step until a service level breaks: the knee and the first bottleneck */
  ramp: {
    ...base,
    orgs: 20, users: 50, activePerOrg: 25, socketsPerOrg: 10, seedDays: 60, chatHistory: 100, parallel: 3,
    heavy: false, heavyImportRows: 0, heavyPdfRecords: 0,
    rampRates: [50, 100, 150, 200, 300, 400, 600, 800],
    rampStepS: 90,
    phases: [{ name: 'warmup', s: 45, rate: 25 }],
    thresholds: { ...EXIT7 },
  },
}
