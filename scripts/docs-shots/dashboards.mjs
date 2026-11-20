/**
 * Headless check of dashboards built by clicking (P2-C). DEVELOPER TOOL, not part of the product.
 *
 * Server part (BASE, an administrator ADMIN on a running server whose database already holds the plant tables, e.g. the
 * one scripts/exit-check/p2-dashboard.mjs prepared): Dashboards > Create from template, open it, Edit: make a tile
 * wider, move one, remove one, rename, Save; reload: the layout persisted; the date range and the shift filter reload the
 * tiles; the administrator sees no "based on the rows you can see" note. Demo part (dist/index.html from file://, no
 * server): Create from template makes SAMPLE tables in the browser and every tile draws. Screenshots to docs/images/.
 *   BASE=http://localhost:5201 node scripts/docs-shots/dashboards.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const BASE = (process.env.BASE || 'http://localhost:5201').replace(/\/$/, '')
const OUT = process.env.OUT || path.join(root, 'docs', 'images')
const ADMIN = { email: 'admin@example.test', password: 'Example-Only-Pass-2026' }
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
fs.mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] })
const errors = []
const allReady = (n) => {
  const t = [...document.querySelectorAll('[data-testid^="tile-"][data-state]')]
  return t.length >= n && t.every((x) => x.getAttribute('data-state') === 'ready')
}
try {
  /* ------------------------------------------------------------------ server */
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type=email]')
  await page.type('input[type=email]', ADMIN.email)
  await page.type('input[type=password]', ADMIN.password)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + '/#u-dashboards', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-from-template"]')
  await page.click('[data-testid="dashboard-from-template"]')
  await page.waitForFunction(() => /[?&]d=/.test(location.hash), { timeout: 20000 })
  const id = await page.evaluate(() => /[?&]d=([A-Za-z0-9_-]+)/.exec(location.hash)[1])
  await page.waitForFunction(allReady, { timeout: 30000 }, 7)
  ok(true, 'Create from template opens a seven-tile dashboard with every tile drawn')
  ok(!(await page.$('[data-testid="tile-oee-filtered"]')), 'an administrator reads every row: no "based on the rows you can see" note')
  await page.screenshot({ path: path.join(OUT, 'p2-dashboard-admin.png') })
  // edit the layout by clicking
  await page.click('[data-testid="dashboard-edit"]')
  await page.click('[data-testid="tile-oee-wider"]')
  await page.click('[data-testid="tile-pareto-down"]')
  await page.click('[data-testid="tile-avail-remove"]')
  const title = await page.$('[data-testid="dashboard-title-input"]')
  await title.click()
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await title.type('Plant 1 overview')
  await page.click('[data-testid="dashboard-save"]')
  await page.waitForSelector('[data-testid="dashboard-title"]')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(allReady, { timeout: 30000 }, 6)
  const saved = await page.evaluate(async (d) => (await (await fetch(`/api/v1/dashboards/${d}`, { headers: { 'X-Appbuilder': '1' } })).json()).def, id)
  ok(saved.title === 'Plant 1 overview' && saved.tiles.length === 6, 'title and the removed tile persisted')
  ok(saved.tiles.find((t) => t.id === 'oee').layout.w === 4 && saved.tiles.find((t) => t.id === 'pareto').layout.y === 4, 'the wider OEE tile and the moved Pareto tile persisted')
  // range and filter reload the tiles
  const before = await page.$eval('[data-testid="tile-good-viz-svg"]', (e) => e.getAttribute('aria-label'))
  await page.select('[data-testid="dashboard-range"]', 'thisFiscalYear')
  await page.waitForFunction((b) => document.querySelector('[data-testid="tile-good-viz-svg"]')?.getAttribute('aria-label') !== b, { timeout: 15000 }, before)
  ok(true, 'changing the date range to "This fiscal year" reloads the KPI')
  const fy = await page.$eval('[data-testid="dashboard-range-label"]', (e) => e.textContent)
  ok(/^2026-04-01 to 2027-03-31$/.test(fy), `fiscal year label (April start): ${fy}`)
  const b2 = await page.$eval('[data-testid="tile-good-viz-svg"]', (e) => e.getAttribute('aria-label'))
  await page.select('[data-testid="dashboard-filter-shift"]', 'B')
  await page.waitForFunction((b) => document.querySelector('[data-testid="tile-good-viz-svg"]')?.getAttribute('aria-label') !== b, { timeout: 15000 }, b2)
  ok(true, 'the Shift filter reloads the tiles')
  await page.evaluate(async (d) => { await fetch(`/api/v1/dashboards/${d}`, { method: 'DELETE', headers: { 'X-Appbuilder': '1' } }) }, id)

  // the Visual UI component in a canvas app: a Pareto from a table formula, OnSelect with the clicked row
  const appId = await page.evaluate(async () => {
    const h = { 'X-Appbuilder': '1', 'Content-Type': 'application/json' }
    const app = await (await fetch('/api/v1/apps', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Visual check', width: 1280, height: 800 }) })).json()
    const full = await (await fetch(`/api/v1/apps/${app.id}`, { headers: h })).json()
    const def = full.definition
    const box = (x, y, w, hh) => ({ X: `=${x}`, Y: `=${y}`, Width: `=${w}`, Height: `=${hh}` })
    def.screens[0].children.push(
      { id: 'n_vis_1', name: 'Defects', type: 'Visual', children: [], props: { ...box(40, 40, 640, 360), Kind: '="Pareto"', Items: '=Table({Defect: "Burr", N: 40}, {Defect: "Crack", N: 25}, {Defect: "Dent", N: 10}, {Defect: "Scratch", N: 5})', CategoryField: '="Defect"', ValueFields: '="N"', OnSelect: '=Set(varPick, Defects.Selected.Defect)' } },
      { id: 'n_vis_2', name: 'Picked', type: 'Label', children: [], props: { ...box(40, 420, 640, 40), Text: '="Picked: " & varPick' } },
    )
    await fetch(`/api/v1/apps/${app.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ definition: def }) })
    return app.id
  })
  await page.goto(`${BASE}/#run-${appId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('svg[role="img"] rect[style*="cursor"]', { timeout: 20000 })
  const label = await page.$eval('svg[role="img"]', (e) => e.getAttribute('aria-label'))
  ok(/Pareto chart/.test(label) && /highest N 40 at Burr/.test(label), `the Visual draws a Pareto with an accessible summary (${label})`)
  await page.click('svg[role="img"] rect[style*="cursor"]')
  await page.waitForFunction(() => document.body.innerText.includes('Picked: Burr'), { timeout: 10000 })
  ok(true, 'clicking a bar runs OnSelect with the clicked row (Picked: Burr)')
  await page.evaluate(async (a) => { await fetch(`/api/v1/apps/${a}`, { method: 'DELETE', headers: { 'X-Appbuilder': '1' } }) }, appId)
  await page.close()

  /* ------------------------------------------------------------------ demo mode (no server) */
  const demo = await browser.newPage()
  demo.on('pageerror', (e) => errors.push(String(e)))
  await demo.setViewport({ width: 1280, height: 900 })
  await demo.goto(pathToFileURL(path.join(root, 'dist', 'index.html')).href + '#u-dashboards', { waitUntil: 'domcontentloaded' })
  await demo.waitForSelector('[data-testid="dashboard-from-template"]', { timeout: 30000 })
  await demo.click('[data-testid="dashboard-from-template"]')
  await demo.waitForFunction(() => /[?&]d=/.test(location.hash), { timeout: 30000 })
  await demo.waitForFunction(allReady, { timeout: 30000 }, 7)
  const empties = await demo.$$eval('[data-testid$="-viz-empty"]', (x) => x.length)
  ok(empties === 0, 'demo mode: SAMPLE tables are created in the browser and every tile draws from them')
  await demo.screenshot({ path: path.join(OUT, 'p2-dashboard-demo.png') })
} finally {
  await browser.close()
}
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
