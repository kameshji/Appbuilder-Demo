#!/usr/bin/env node
/**
 * Phase 3 exit check (docs/plan/p3-spec.md) and the hosting checks that run without a Linux server
 * (docs/plan/hosting-spec.md). DEVELOPER TOOL (sandbox values only), not part of the product.
 *
 *   node scripts/exit-check/p3.mjs                       everything, one script after the other
 *   EXIT_SKIP=p2,load node scripts/exit-check/p3.mjs     leave parts out
 *   EXIT_ONLY=chat,notes node scripts/exit-check/p3.mjs  only these
 *
 * Each part is an existing script run as a child process (each creates and drops its own database); this file only
 * collects their results into one Markdown table and exits 1 when any part fails. Settings are passed through:
 * EXIT_DB_HOST, EXIT_DB_PORT, EXIT_DB_USER, EXIT_DB_PASSWORD, EXIT_MAINT_DB, PUPPETEER_CORE, CHROME_PATH (see
 * docs/dev/testing.md). OUT: a folder for the children's output (default: a folder under the temp directory).
 * Needs `npm run build` first. Never run in parallel with another exit check (ports and timings).
 *
 * What is emulated: phones are Chrome's phone emulation; WhatsApp is a mock of the provider; mail is a fake SMTP server;
 * the fleet runs as plain processes (no systemd, OS users, Caddy or TLS: the CI job `fleet` and a rented server cover
 * those); the load test here is the 3-minute smoke profile, not the pilot profile.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const E = process.env
const OUT = E.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ab-p3-'))
fs.mkdirSync(OUT, { recursive: true })

/** [key, exit check(s) of p3-spec or hosting-spec, what, script relative to the repository, extra arguments] */
const PARTS = [
  ['chat', 'P3 1-8', 'Chat: delivery, mentions, files, cards per reader, leak suite, discussions, search, retention and moderation', 'scripts/exit-check/p3-chat.mjs', []],
  ['tasks', 'P3 9', 'Tasks: reminders once across a restart, digest, sharing, phone width', 'scripts/exit-check/p3-tasks.mjs', []],
  ['notes', 'P3 9', 'Notes: sharing, mentions, conflict choice, sanitising, record timeline', 'scripts/exit-check/p3-notes.mjs', []],
  ['manufacturing', 'P3 10', 'Manufacturing pack: install, offline phone entry, NCR and maintenance flows, OEE reference, PDFs, roles, deploy, upgrade, uninstall', 'scripts/exit-check/p3-manufacturing.mjs', []],
  ['crm', 'P3 11', 'CRM pack: own and team rows, lead conversion, quote approval and PDF, pipeline reference', 'scripts/exit-check/p3-crm.mjs', []],
  ['erp', 'P3 12', 'ERP-lite pack: purchase to stock, delivery, invoice without tax, 20 parallel issues never below zero', 'scripts/exit-check/p3-erp.mjs', []],
  ['ledgers', 'P3 14', 'Accounts: ledgers and India GST on the unsigned draft (invoices, credit note, trial balance, PDFs, period lock)', 'scripts/exit-check/p3-ledgers.mjs', []],
  ['templates', 'P3 13', 'Solution template rules: nothing overwritten, plan screen, one transaction, upgrade keeping local changes', 'scripts/exit-check/p3-templates.mjs', []],
  ['misc', 'P3 15', 'Carried-forward items: drill-through to a screen, kiosk cycling, form-submitted trigger, error boundaries', 'scripts/exit-check/p3-misc.mjs', []],
  ['isolation', 'H 2', 'Hosting: cross-instance isolation suite (three installs)', 'scripts/exit-check/h-isolation.mjs', []],
  ['licence', 'H 6', 'Hosting: licence check, 72 hours of grace on a driven clock, read-only, seat counts', 'scripts/exit-check/h-licence.mjs', []],
  ['fleet', 'H 1,3,4,5,10', 'Hosting: fleet tool in local mode (create, update with a forced failure, backup and restore, delete, rotation)', 'scripts/exit-check/h-fleet.mjs', []],
  ['load', 'H 7 (smoke)', 'Hosting: load test, smoke profile (3 organisations x 10 people)', 'scripts/bench/load/run.mjs', ['--profile', 'smoke']],
  ['p2', 'P3 16', 'Regression: the Phase 2 exit check, which runs the Phase 0 and Phase 1 checks too', 'scripts/exit-check/p2.mjs', []],
]

const only = (E.EXIT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const skip = (E.EXIT_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean)
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function run(script, args, log) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(log)
    const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, env: { ...E, OUT: path.join(OUT, path.basename(log, '.log')) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const take = (b) => { out.write(b); tail = (tail + b.toString()).slice(-8000) }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (e) => { take(Buffer.from(String(e))); })
    child.on('close', (code) => { out.end(); resolve({ code: code ?? 1, tail: strip(tail) }) })
  })
}

/** the last line of a child's output that states a count of passed checks, as evidence */
function evidence(tail) {
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hit = [...lines].reverse().find((l) => /\bpassed\b|\bPASS\b|checks?\b/i.test(l) && /\d/.test(l) && !/^\|/.test(l))
  return (hit || lines[lines.length - 1] || '').replace(/\|/g, '/').slice(0, 160)
}

const gst = (() => {
  // exit check 14: the ledger and GST package stays blocked until a practising accountant signs the draft
  const f = path.join(root, 'docs', 'plan', 'gst-spec-draft.md')
  if (!fs.existsSync(f)) return { state: 'PENDING', note: 'docs/plan/gst-spec-draft.md is missing' }
  const text = fs.readFileSync(f, 'utf8')
  const signed = /Signed off by:\s*\S+/i.test(text) && /Membership (number|no\.?):\s*\d+/i.test(text)
  return signed ? { state: 'SIGNED', note: 'a sign-off block with a name and a membership number is present (its content is not judged here)' } : { state: 'PENDING', note: 'no accountant sign-off recorded; ledgers and GST (package L) are built on the unsigned draft by decision of the owner on 21 Nov 2026 and make no compliance claim' }
})()

const t0 = Date.now()
const rows = []
let failed = false
for (const [key, check, what, script, args] of PARTS) {
  if ((only.length && !only.includes(key)) || skip.includes(key)) { rows.push([check, what, 'SKIPPED', '', '']); continue }
  if (!fs.existsSync(path.join(root, script))) { rows.push([check, what, 'FAIL', 'the script is missing: ' + script, '']); failed = true; continue }
  const s = Date.now()
  process.stderr.write(`running ${key} ...\n`)
  const r = await run(script, args, path.join(OUT, key + '.log'))
  const secs = Math.round((Date.now() - s) / 1000)
  if (r.code !== 0) failed = true
  rows.push([check, what, r.code === 0 ? 'PASS' : 'FAIL', evidence(r.tail), String(secs)])
}
rows.push(['P3 14', 'GST sign-off: the review by an accountant of the draft the Accounts area is built on', gst.state, gst.note, ''])

console.log('| Check | What | Result | Evidence (last line of the script) | Seconds |')
console.log('| --- | --- | --- | --- | ---: |')
for (const r of rows) console.log('| ' + r.join(' | ') + ' |')
console.log(`\n${failed ? 'PHASE 3 EXIT CHECK FAILED' : 'PHASE 3 EXIT CHECK PASSED'} (${Math.round((Date.now() - t0) / 1000)} s; output in ${OUT})`)
console.log('Not covered here: real phones, a real WhatsApp account, a real mail provider, a real Linux server (systemd, OS users, Caddy, TLS, disk quotas), the pilot load profile, an outside security review.')
process.exit(failed ? 1 : 0)
