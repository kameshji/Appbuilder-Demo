/**
 * Headless check of the visual tile query editor (P2-C, Phase 2 wave 1). DEVELOPER TOOL, not part of the product.
 *
 * Demo part (always; a built index.html from file://, no server): Create from template, Edit, open "Edit tile" on the
 * Good quantity KPI and apply it unchanged (the stored tile is identical), then "Add tile" built by clicking only: table,
 * kind, title, a sum measure, a count with a condition, a calculation, a group column, sort, top 3 + Others; the live
 * preview draws; a problem (comparison without a date column) is shown in words and blocks Apply; Apply + Save; after a
 * reload the stored query is the one clicked together. Then the editor in dark theme and at tablet width (820 px; no
 * sideways scrolling). Server part (when BASE is set, an administrator ADMIN_EMAIL / ADMIN_PASSWORD): the same add-tile
 * flow against POST /dashboards/query, stored through PATCH /dashboards/:id. Screenshots to OUT.
 *
 *   PUPPETEER_CORE=<dir>/node_modules/puppeteer-core CHROME_PATH=<chrome> HTML=dist/index.html OUT=<dir> node scripts/exit-check/p2-tile-editor.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || path.join(root, 'node_modules', 'puppeteer-core')
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const HTML = path.resolve(process.env.HTML || path.join(root, 'dist', 'index.html'))
const OUT = process.env.OUT || path.join(os.tmpdir(), 'p2-tile-editor')
const BASE = process.env.BASE ? process.env.BASE.replace(/\/$/, '') : null
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
fs.mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] })
const errors = []
const allReady = (n) => {
  const t = [...document.querySelectorAll('[data-testid^="tile-"][data-state]')].filter((x) => !x.closest('[data-testid="tile-editor"]'))
  return t.length >= n && t.every((x) => x.getAttribute('data-state') === 'ready')
}
const previewReady = () => {
  const box = document.querySelector('[data-testid="tile-editor-preview-tile"]')
  const tile = box?.querySelector('[data-state]')
  return !document.querySelector('[data-testid="tile-editor-preview-loading"]') && tile?.getAttribute('data-state') === 'ready'
}
/** a toast may lie over the editor's footer for a few seconds: click the button itself */
const clickDom = (page, sel) => page.$eval(sel, (b) => b.click())
/** waits for every dashboard tile; on a timeout says which tiles are not ready and why */
async function tilesReady(page, n, timeout = 30000) {
  try { await page.waitForFunction(allReady, { timeout }, n) } catch (e) {
    const st = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="tile-"][data-state]')].map((x) => `${x.getAttribute('data-testid')}=${x.getAttribute('data-state')} ${x.getAttribute('data-state') === 'error' ? x.textContent : ''}`))
    throw new Error(`tiles not ready (${page.url().split('#')[1]}): ${st.join(' | ')} (${e.message})`)
  }
}

/** builds a tile by clicking: returns after Apply */
async function addTileByClicking(page, label) {
  await page.click('[data-testid="dashboard-add-tile"]')
  await page.waitForSelector('[data-testid="tile-editor"]')
  await page.select('[data-testid="tile-editor-table"]', 'ProductionLog')
  await page.waitForSelector('[data-testid="tile-editor-add-measure"]')
  const title = await page.$('[data-testid="tile-editor-title"]')
  await title.click()
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await title.type('Good by machine')
  await page.select('[data-testid="tile-editor-kind"]', 'bar')
  await page.select('[data-testid="tile-editor-add-measure"]', 'Good')
  await page.waitForSelector('[data-testid="tile-editor-measure-Good"]')
  // a count of rows of shift A
  await page.select('[data-testid="tile-editor-add-measure"]', '__count')
  await page.waitForSelector('[data-testid="tile-editor-measure-Rows2"]')
  await page.click('[data-testid="tile-editor-count-filter-Rows2-add"]')
  await page.select('[data-testid="tile-editor-count-filter-Rows2-col-0"]', 'Shift')
  await page.select('[data-testid="tile-editor-count-filter-Rows2-value-0"]', 'A')
  const summary = await page.$eval('[data-testid="tile-editor-measure-Rows2-summary"]', (e) => e.textContent)
  ok(summary === 'Count of rows where Shift is "A"', `${label}: the count's condition reads in words (${summary})`)
  // remove the default count, add a calculation Good / Rows2
  await page.click('[data-testid="tile-editor-measure-Rows-remove"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tile-editor-measure-Rows"]'))
  await page.click('[data-testid="tile-editor-add-calc"]')
  await page.waitForSelector('[data-testid="tile-editor-calc-GoodPerRows2"]')
  await page.select('[data-testid="tile-editor-add-group"]', 'Machine')
  await page.select('[data-testid="tile-editor-sort"]', 'Good')
  await page.click('[data-testid="tile-editor-top"]')
  const n = await page.$('[data-testid="tile-editor-top-n"]')
  await n.click()
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await n.type('3')
  await page.click('[data-testid="tile-editor-others"]')
  await page.select('[data-testid="tile-editor-format-GoodPerRows2"]', 'decimal')
  await page.waitForFunction(previewReady, { timeout: 30000 })
  const bars = await page.$$eval('[data-testid="tile-editor-preview-tile"] svg rect', (x) => x.length)
  ok(bars > 0, `${label}: the live preview draws the new tile (${bars} rects)`)
  const lines = await page.$$eval('[data-testid="tile-editor-summary"] li', (x) => x.map((e) => e.textContent))
  ok(lines.includes('Top 3, the rest as "Others".') && lines.includes('By Machine.'), `${label}: the summary describes the tile (${lines.join(' / ')})`)
  // a problem in words blocks Apply; fixing it unblocks
  await page.select('[data-testid="tile-editor-date-col"]', '')
  await page.select('[data-testid="tile-editor-compare"]', 'previousPeriod')
  await page.waitForFunction(() => document.querySelector('[data-testid="tile-editor-issues"]')?.textContent.includes('A comparison needs the column the dashboard date range applies to.'))
  ok(await page.$eval('[data-testid="tile-editor-apply"]', (b) => b.disabled), `${label}: "A comparison needs the column the dashboard date range applies to." blocks Apply`)
  ok(await page.$eval('[data-testid="tile-editor-preview-tile"]', (e) => e.getAttribute('data-state') === 'blocked'), `${label}: the preview waits for the fix`)
  await page.select('[data-testid="tile-editor-compare"]', '')
  await page.select('[data-testid="tile-editor-date-col"]', 'LoggedOn')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tile-editor-apply"]').disabled)
  await page.waitForFunction(previewReady, { timeout: 30000 })
  await page.screenshot({ path: path.join(OUT, `${label}-editor.png`) })
  await clickDom(page, '[data-testid="tile-editor-apply"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tile-editor"]'))
}

const EXPECTED_QUERY = {
  table: 'ProductionLog',
  measures: [{ id: 'Good', label: 'Good quantity', fn: 'sum', col: 'Good' }, { id: 'Rows2', label: 'Rows', fn: 'count', filter: { col: 'Shift', op: 'eq', value: 'A' } }],
  dateColumn: { col: 'LoggedOn', kind: 'datetime' },
  computed: [{ id: 'GoodPerRows2', label: 'Good quantity / Rows', expr: { fn: 'div', args: [{ m: 'Good' }, { m: 'Rows2' }] } }],
  groupBy: ['Machine'], sort: { by: 'Good', dir: 'desc' }, top: { n: 3, others: 'Others' },
}
const sortKeys = (x) => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x)
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

try {
  /* ------------------------------------------------------------------ demo mode (no server) */
  const demo = await browser.newPage()
  demo.on('pageerror', (e) => errors.push(String(e)))
  await demo.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await demo.setViewport({ width: 1366, height: 900 })
  await demo.goto(pathToFileURL(HTML).href + '#u-dashboards', { waitUntil: 'domcontentloaded' })
  await demo.waitForSelector('[data-testid="dashboard-from-template"]', { timeout: 30000 })
  await demo.click('[data-testid="dashboard-from-template"]')
  await demo.waitForFunction(() => /[?&]d=/.test(location.hash), { timeout: 30000 })
  await tilesReady(demo, 7)
  const stored = () => demo.evaluate(() => { const id = /[?&]d=([A-Za-z0-9_-]+)/.exec(location.hash)[1]; return JSON.parse(localStorage.getItem('appbuilder-dashboards')).find((d) => d.id === id).def })
  const before = await stored()
  await demo.click('[data-testid="dashboard-edit"]')
  // edit an existing tile and apply it unchanged
  await demo.click('[data-testid="tile-good-configure"]')
  await demo.waitForSelector('[data-testid="tile-editor"]')
  await demo.waitForFunction(previewReady, { timeout: 30000 })
  ok(await demo.$eval('[data-testid="tile-editor-kind"]', (e) => e.value === 'kpi'), 'demo: "Edit tile" opens the editor on the KPI')
  await clickDom(demo, '[data-testid="tile-editor-apply"]')
  await demo.waitForFunction(() => !document.querySelector('[data-testid="tile-editor"]'))
  // the Scrap rate KPI with its calculation (and the OEE gauge with row calculations) also round-trip
  for (const id of ['scrap', 'oee', 'machines']) {
    await demo.click(`[data-testid="tile-${id}-configure"]`)
    await demo.waitForSelector('[data-testid="tile-editor"]')
    await clickDom(demo, '[data-testid="tile-editor-apply"]')
    await demo.waitForFunction(() => !document.querySelector('[data-testid="tile-editor"]'))
  }
  await addTileByClicking(demo, 'demo')
  await tilesReady(demo, 8)
  ok(true, 'demo: after Apply the new tile is on the dashboard draft and draws')
  await demo.click('[data-testid="dashboard-save"]')
  await demo.waitForSelector('[data-testid="dashboard-title"]')
  await demo.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(demo, 8)
  const after = await stored()
  ok(same(after.tiles.slice(0, 7), before.tiles), 'demo: tiles opened in the editor and applied unchanged are stored identically')
  const added = after.tiles[7]
  ok(added && added.title === 'Good by machine' && added.kind === 'bar', 'demo: the added tile is stored with its title and kind')
  ok(same(added.query, EXPECTED_QUERY), `demo: the stored query is the one clicked together: ${JSON.stringify(added.query)}`)
  ok(added.visual?.series?.find((s) => s.key === 'GoodPerRows2')?.format?.decimals === 2, 'demo: the calculation\'s number format is stored on its series')
  ok(await demo.$$eval(`[data-testid="tile-${added.id}"] svg rect`, (x) => x.length > 0), 'demo: the new tile draws on the dashboard after a reload')
  await demo.screenshot({ path: path.join(OUT, 'demo-dashboard.png') })

  // dark theme and tablet width
  await demo.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await demo.setViewport({ width: 820, height: 1180 })
  await demo.evaluate(() => {
    localStorage.setItem('appbuilder-theme', 'dark')
    for (const k of Object.keys(localStorage)) if (k.startsWith('appbuilder-prefs:')) { const p = JSON.parse(localStorage.getItem(k)); p.theme = 'dark'; localStorage.setItem(k, JSON.stringify(p)) }
  })
  await demo.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(demo, 8)
  await demo.click('[data-testid="dashboard-edit"]')
  await demo.click(`[data-testid="tile-${added.id}-configure"]`)
  await demo.waitForSelector('[data-testid="tile-editor"]')
  await demo.waitForFunction(previewReady, { timeout: 30000 })
  ok(await demo.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme is on')
  const geo = await demo.$eval('[data-testid="tile-editor"]', (e) => {
    const r = e.getBoundingClientRect()
    const wide = [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > r.right + 1).map((x) => x.getAttribute('data-testid') || x.tagName)
    return { w: r.width, vw: innerWidth, wide: wide.slice(0, 5), scroll: [...e.querySelectorAll('*')].some((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflowX !== 'visible' && x.clientWidth > 300) }
  })
  ok(geo.w <= geo.vw && geo.wide.length === 0 && !geo.scroll, `tablet width: the editor fits 820 px without sideways scrolling (${JSON.stringify(geo)})`)
  const bg = await demo.$eval('[data-testid="tile-editor"]', (e) => getComputedStyle(e).backgroundColor)
  ok(!/rgb\(255, 255, 255\)/.test(bg), `dark theme: the editor background is dark (${bg})`)
  await demo.screenshot({ path: path.join(OUT, 'demo-editor-dark-tablet.png') })
  await clickDom(demo, '[data-testid="tile-editor-cancel"]')
  await demo.close()

  /* ------------------------------------------------------------------ server mode */
  if (BASE) {
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.setViewport({ width: 1366, height: 900 })
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]', process.env.ADMIN_EMAIL)
    await page.type('input[type=password]', process.env.ADMIN_PASSWORD)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
    await page.goto(BASE + '/#u-dashboards', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="dashboard-from-template"]')
    await page.click('[data-testid="dashboard-from-template"]')
    await page.waitForFunction(() => /[?&]d=/.test(location.hash), { timeout: 30000 })
    const id = await page.evaluate(() => /[?&]d=([A-Za-z0-9_-]+)/.exec(location.hash)[1])
    await tilesReady(page, 7, 60000)
    const queried = []
    page.on('request', (r) => { if (r.url().endsWith('/dashboards/query')) queried.push(r.url()) })
    await page.click('[data-testid="dashboard-edit"]')
    await addTileByClicking(page, 'server')
    ok(queried.length > 0, `server: the preview went through POST /dashboards/query (${queried.length} requests)`)
    await page.click('[data-testid="dashboard-save"]')
    await page.waitForSelector('[data-testid="dashboard-title"]')
    const saved = await page.evaluate(async (d) => (await (await fetch(`/api/v1/dashboards/${d}`, { headers: { 'X-Appbuilder': '1' } })).json()).def, id)
    ok(saved.tiles.length === 8 && same(saved.tiles[7].query, EXPECTED_QUERY), 'server: the added tile was stored by the server as clicked together')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await tilesReady(page, 8, 60000)
    ok(true, 'server: after a reload every tile, the new one included, draws')
    await page.screenshot({ path: path.join(OUT, 'server-dashboard.png') })
    await page.evaluate(async (d) => { await fetch(`/api/v1/dashboards/${d}`, { method: 'DELETE', headers: { 'X-Appbuilder': '1' } }) }, id)
    await page.close()
  }
} finally {
  await browser.close()
}
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
