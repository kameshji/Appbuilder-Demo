/**
 * Headless check of the dashboard layout, viewer roles, settings and drill-through screens (P2-C, Phase 2 wave 2).
 * DEVELOPER TOOL, not part of the product. Demo mode only (a built index.html from file://, no server); screenshots to OUT.
 *
 *  - drag a tile with the mouse and with touch, resize it with the corner handle, Escape drops a drag, the arrow keys and the
 *    step buttons still work, no overlap after any of it (DOM rectangles), Save and reload keep the layout;
 *  - widths: phone (one column), tablet (6 columns, nothing overlapping or narrower than 160 px, no sideways scrolling),
 *    computer (12 columns), and what the edit hint says;
 *  - viewer roles: the sentence, ticking a role, Save, reload;
 *  - settings: values, plain-English errors that block Save, Save, reload, dark theme;
 *  - drill-through: the tile editor's "Clicking opens an app", a click on a table row opens the app with the clicked value in the
 *    address (read with Param), and the Open button.
 *
 *   PUPPETEER_CORE=<dir>/node_modules/puppeteer-core CHROME_PATH=<chrome> HTML=dist/index.html OUT=<dir> node scripts/exit-check/p2-dashboard-layout.mjs
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'p2-dashboard-layout')
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok - ${what}`) }
fs.mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] })
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allReady = (n) => {
  const t = [...document.querySelectorAll('[data-testid^="tile-"][data-state]')].filter((x) => !x.closest('[data-testid="tile-editor"]'))
  return t.length >= n && t.every((x) => x.getAttribute('data-state') === 'ready')
}
const previewReady = () => {
  const box = document.querySelector('[data-testid="tile-editor-preview-tile"]')
  const tile = box?.querySelector('[data-state]')
  return !document.querySelector('[data-testid="tile-editor-preview-loading"]') && tile?.getAttribute('data-state') === 'ready'
}
const clickDom = (page, sel) => page.$eval(sel, (b) => b.click())
const tilesReady = (page, n) => page.waitForFunction(allReady, { timeout: 30000 }, n)

/** every tile's rectangle on the page and its place on the grid (read from the wrapper's grid-area) */
const measure = (page) => page.evaluate(() => {
  const grid = document.querySelector('[data-testid="dashboard-grid"]')
  const g = grid.getBoundingClientRect()
  const out = {}
  for (const sec of grid.querySelectorAll(':scope > div > section[data-testid^="tile-"]')) {
    const id = sec.getAttribute('data-testid').slice(5)
    const r = sec.getBoundingClientRect()
    const st = sec.parentElement.style
    const col = /(\d+) \/ span (\d+)/.exec(st.gridColumn), row = /(\d+) \/ span (\d+)/.exec(st.gridRow)
    out[id] = { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, x: col ? +col[1] - 1 : null, cw: col ? +col[2] : null, y: row ? +row[1] - 1 : null, ch: row ? +row[2] : null }
  }
  return { tiles: out, grid: { l: g.left, r: g.right, w: g.width, scroll: grid.parentElement.scrollWidth, client: grid.parentElement.clientWidth }, mode: grid.getAttribute('data-layout') }
})
const overlaps = (tiles) => {
  const a = Object.entries(tiles)
  const bad = []
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    const p = a[i][1], q = a[j][1]
    if (p.l < q.r - 1 && q.l < p.r - 1 && p.t < q.b - 1 && q.t < p.b - 1) bad.push(`${a[i][0]}/${a[j][0]}`)
  }
  return bad
}
const stored = (page) => page.evaluate(() => { const id = /[?&]d=([A-Za-z0-9_-]+)/.exec(location.hash)[1]; return JSON.parse(localStorage.getItem('appbuilder-dashboards')).find((d) => d.id === id) })
const center = (r) => [r.l + r.w / 2, r.t + r.h / 2]
const rectOf = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } })

async function mouseDrag(page, sel, dx, dy, o = {}) {
  const r = await rectOf(page, sel)
  const [x, y] = [r.l + r.w / 2, r.t + r.h / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await sleep(15) }
  if (o.during) await o.during()
  await page.mouse.up()
  await sleep(60)
}

try {
  /* ------------------------------------------------------------------ the dashboard (computer width) */
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await page.setViewport({ width: 1600, height: 1000, hasTouch: true })
  await page.goto(pathToFileURL(HTML).href + '#u-dashboards', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-from-template"]', { timeout: 30000 })
  await page.click('[data-testid="dashboard-from-template"]')
  await page.waitForFunction(() => /[?&]d=/.test(location.hash), { timeout: 30000 })
  await tilesReady(page, 7)
  let m = await measure(page)
  ok(m.mode === 'grid', `computer width: the 12-column grid (${m.grid.w | 0} px wide)`)
  ok(overlaps(m.tiles).length === 0, 'the template does not overlap')
  const tileIds = Object.keys(m.tiles)
  const colStep = (m.grid.w - 12 * 11) / 12 + 12
  const rowStep = 92

  await page.click('[data-testid="dashboard-edit"]')
  await page.waitForSelector('[data-testid="tile-good-grip"]')
  ok(await page.$('[data-testid="tile-good-resize"]') !== null, 'edit mode shows the move grip and the corner handle')
  ok(await page.$('[data-testid="dashboard-layout-hint"]') === null, 'no narrow-window hint at computer width')

  // drag with the mouse: one cell sideways (the direction that fits)
  m = await measure(page)
  const g0 = m.tiles.good
  const dxCells = g0.x + g0.cw < 12 ? 1 : -1
  let sawDragging = false
  await mouseDrag(page, '[data-testid="tile-good-grip"]', dxCells * colStep, 0, { during: async () => { sawDragging = (await page.$eval('[data-testid="dashboard-grid"]', (e) => e.getAttribute('data-dragging'))) === 'true' } })
  m = await measure(page)
  ok(sawDragging, 'while dragging the grid says so (data-dragging)')
  ok(m.tiles.good.x === g0.x + dxCells, `mouse drag: the tile moved ${dxCells} column (${g0.x} -> ${m.tiles.good.x})`)
  ok(overlaps(m.tiles).length === 0, `after the drag nothing overlaps (${overlaps(m.tiles).join(', ') || 'none'})`)
  await page.screenshot({ path: path.join(OUT, 'edit-after-drag.png') })

  // resize with the corner handle: one column narrower and one row taller
  const before = (await measure(page)).tiles.good
  await mouseDrag(page, '[data-testid="tile-good-resize"]', -colStep, rowStep)
  m = await measure(page)
  ok(m.tiles.good.cw === before.cw - 1 && m.tiles.good.ch === before.ch + 1, `corner handle: ${before.cw}x${before.ch} -> ${m.tiles.good.cw}x${m.tiles.good.ch}`)
  ok(overlaps(m.tiles).length === 0, 'after the resize nothing overlaps')

  // Escape drops a drag
  const e0 = JSON.stringify(Object.fromEntries(Object.entries((await measure(page)).tiles).map(([k, v]) => [k, [v.x, v.y, v.cw, v.ch]])))
  await mouseDrag(page, '[data-testid="tile-oee-grip"]', 3 * colStep, 2 * rowStep, { during: async () => { await page.keyboard.press('Escape'); await sleep(50) } })
  const e1 = JSON.stringify(Object.fromEntries(Object.entries((await measure(page)).tiles).map(([k, v]) => [k, [v.x, v.y, v.cw, v.ch]])))
  ok(e0 === e1, 'Escape during a drag leaves the layout as it was')

  // many drags and resizes in a row never overlap and never leave the grid
  const moves = [['pareto', 2, 1], ['oee', -3, 2], ['machines', 1, -3], ['scrap', 5, 0], ['good', -6, 4], ['pareto', 0, -9], ['machines', 9, 9], ['oee', 11, 0]]
  for (const [id, cx, cy] of moves) {
    await mouseDrag(page, `[data-testid="tile-${id}-grip"]`, cx * colStep, cy * rowStep)
    m = await measure(page)
    const out = Object.entries(m.tiles).filter(([, t]) => t.x < 0 || t.x + t.cw > 12 || t.y < 0)
    ok(overlaps(m.tiles).length === 0 && out.length === 0, `drag ${id} by ${cx},${cy}: no overlap, inside the grid`)
  }
  for (const [id, cx, cy] of [['pareto', 4, 1], ['good', -9, -9], ['machines', 20, 2]]) {
    await mouseDrag(page, `[data-testid="tile-${id}-resize"]`, cx * colStep, cy * rowStep)
    m = await measure(page)
    const t = m.tiles[id]
    ok(overlaps(m.tiles).length === 0 && t.x + t.cw <= 12 && t.cw >= 1 && t.ch >= 1, `resize ${id} by ${cx},${cy}: ${t.cw}x${t.ch}, no overlap, inside the grid`)
  }

  // touch: the same drag with a finger
  m = await measure(page)
  const s0 = m.tiles.scrap
  const tdx = s0.x + s0.cw < 12 ? 1 : -1
  const gr = await rectOf(page, '[data-testid="tile-scrap-grip"]')
  const touch = await page.touchscreen.touchStart(gr.l + gr.w / 2, gr.t + gr.h / 2)
  for (let i = 1; i <= 6; i++) { await touch.move(gr.l + gr.w / 2 + (tdx * colStep * i) / 6, gr.t + gr.h / 2); await sleep(15) }
  await touch.end()
  await sleep(80)
  m = await measure(page)
  ok(m.tiles.scrap.x === s0.x + tdx, `touch drag: the tile moved ${tdx} column (${s0.x} -> ${m.tiles.scrap.x})`)
  ok(overlaps(m.tiles).length === 0, 'after the touch drag nothing overlaps')

  // keyboard: arrow keys on the grip, Shift + arrows resize
  m = await measure(page)
  const k0 = m.tiles.good
  await page.focus('[data-testid="tile-good-grip"]')
  await page.keyboard.press(k0.x + k0.cw < 12 ? 'ArrowRight' : 'ArrowLeft')
  m = await measure(page)
  ok(m.tiles.good.x === k0.x + (k0.x + k0.cw < 12 ? 1 : -1), 'the arrow keys on the grip move the tile one cell')
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift')
  m = await measure(page)
  ok(m.tiles.good.ch === k0.ch + 1, 'Shift + arrow resizes it')
  // step buttons still work and push neighbours instead of overlapping
  await page.click('[data-testid="tile-good-wider"]')
  await page.click('[data-testid="tile-good-wider"]')
  await page.click('[data-testid="tile-good-wider"]')
  m = await measure(page)
  ok(overlaps(m.tiles).length === 0, 'the step buttons never leave an overlap')

  // save, reload, same layout
  const domLayout = Object.fromEntries(Object.entries((await measure(page)).tiles).map(([k, v]) => [k, { x: v.x, y: v.y, w: v.cw, h: v.ch }]))
  await page.click('[data-testid="dashboard-save"]')
  await page.waitForSelector('[data-testid="dashboard-title"]')
  const saved = await stored(page)
  ok(saved.def.tiles.every((t) => JSON.stringify(t.layout) === JSON.stringify(domLayout[t.id])), 'Save stored exactly the layout on screen')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(page, 7)
  const re = Object.fromEntries(Object.entries((await measure(page)).tiles).map(([k, v]) => [k, { x: v.x, y: v.y, w: v.cw, h: v.ch }]))
  ok(JSON.stringify(re) === JSON.stringify(domLayout), 'after a reload the layout is the same')

  /* ------------------------------------------------------------------ widths */
  const widths = {}
  for (const w of [380, 600, 700, 820, 1000, 1100, 1366]) {
    await page.setViewport({ width: w, height: 1000, hasTouch: true })
    await sleep(250)
    await tilesReady(page, 7)
    const r = await measure(page)
    widths[w] = `${r.mode} (grid ${r.grid.w | 0} px)`
    const minW = Math.min(...Object.values(r.tiles).map((t) => t.w))
    const bad = overlaps(r.tiles)
    ok(bad.length === 0 && r.grid.scroll <= r.grid.client + 1, `${w} px viewport -> ${r.mode}: no overlap, no sideways scrolling, narrowest tile ${minW | 0} px`)
    if (r.mode === 'tablet') ok(minW >= 160, `tablet layout: no tile under 160 px (${minW | 0})`)
    if (r.mode === 'tablet') {
      ok(Object.values(r.tiles).every((t) => t.cw >= 2 && t.x + t.cw <= 6), 'tablet layout: 6 columns, every tile at least 2 columns wide')
      await page.screenshot({ path: path.join(OUT, `tablet-${w}.png`) })
    }
    if (r.mode === 'phone') {
      ok(new Set(Object.values(r.tiles).map((t) => Math.round(t.l))).size === 1, 'phone layout: one column')
      await page.screenshot({ path: path.join(OUT, 'phone.png') })
    }
  }
  console.log('layout per viewport width:', JSON.stringify(widths))
  ok(Object.values(widths).some((v) => v.startsWith('tablet')) && Object.values(widths).some((v) => v.startsWith('phone')) && Object.values(widths).some((v) => v.startsWith('grid')), 'phone, tablet and computer layouts were all reached')
  // edit mode at tablet width: the hint, no corner handles, the buttons still work
  await page.setViewport({ width: 1000, height: 1000, hasTouch: true })
  await sleep(250)
  await page.click('[data-testid="dashboard-edit"]')
  await page.waitForSelector('[data-testid="dashboard-layout-hint"]')
  ok((await measure(page)).mode === 'tablet', 'edit mode at 1000 px is the tablet layout')
  ok(await page.$('[data-testid="tile-good-resize"]') === null, 'tablet width, edit mode: the hint is shown and there are no corner handles')
  const t0 = (await measure(page)).tiles.good
  await page.click('[data-testid="tile-good-taller"]')
  ok((await measure(page)).tiles.good.ch === t0.ch + 1, 'tablet width, edit mode: the "Taller" button still changes the layout')
  await page.screenshot({ path: path.join(OUT, 'tablet-edit.png') })
  await page.click('[data-testid="dashboard-cancel"]')
  await page.setViewport({ width: 1600, height: 1000, hasTouch: true })
  await sleep(250)

  /* ------------------------------------------------------------------ viewer roles */
  await page.click('[data-testid="dashboard-edit"]')
  ok((await page.$eval('[data-testid="dashboard-viewers-line"]', (e) => e.innerText)).includes('Only the owner, makers and administrators can see this dashboard.'), 'edit mode says in words who can see the dashboard')
  await page.click('[data-testid="dashboard-viewers"]')
  await page.waitForSelector('[data-testid="viewer-roles-list"]')
  const names = await page.$$eval('[data-testid="viewer-roles-list"] label', (x) => x.map((e) => e.innerText.split('\n')[0]))
  ok(names.includes('Viewer') && names.includes('Administrator'), `the roles are listed (${names.join(', ')})`)
  ok(await page.$eval('[data-testid^="viewer-role-"][data-testid$="admin"], [data-testid="viewer-roles-list"] label:first-child input', (e) => e.disabled), 'the administrator role is shown ticked and fixed')
  const viewerBox = await page.evaluateHandle(() => [...document.querySelectorAll('[data-testid="viewer-roles-list"] label')].find((l) => l.innerText.startsWith('Viewer')).querySelector('input'))
  await viewerBox.click()
  const sentence = await page.$eval('[data-testid="viewer-roles-summary"]', (e) => e.innerText)
  ok(sentence === 'The owner, makers and administrators, and people with the role Viewer, can see this dashboard.', `ticking Viewer changes the sentence: "${sentence}"`)
  await page.screenshot({ path: path.join(OUT, 'viewer-roles.png') })
  await clickDom(page, '[data-testid="viewer-roles-close"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="viewer-roles-dialog"]'))
  await page.click('[data-testid="dashboard-save"]')
  await page.waitForSelector('[data-testid="dashboard-title"]')
  ok((await stored(page)).roles.length === 1, 'Save stored the chosen role on the dashboard')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await tilesReady(page, 7)
  await page.click('[data-testid="dashboard-viewers"]')
  await page.waitForSelector('[data-testid="viewer-roles-summary"]')
  ok((await page.$eval('[data-testid="viewer-roles-summary"]', (e) => e.innerText)).includes('the role Viewer'), 'after a reload the role is still listed')
  ok(await page.$$eval('[data-testid="viewer-roles-list"] input', (x) => x.length > 0 && x.every((i) => i.disabled)), 'outside edit mode the list cannot be changed')
  await clickDom(page, '[data-testid="viewer-roles-close"]')

  /* ------------------------------------------------------------------ drill-through */
  await page.click('[data-testid="dashboard-edit"]')
  await page.click('[data-testid="tile-machines-configure"]')
  await page.waitForSelector('[data-testid="tile-editor"]')
  await page.waitForFunction(previewReady, { timeout: 30000 })
  await page.$eval('[data-testid="tile-editor-drill"]', (c) => c.click())
  await page.waitForSelector('[data-testid="tile-editor-drill-app"]')
  const apps = await page.$$eval('[data-testid="tile-editor-drill-app"] option', (o) => o.map((x) => [x.value, x.textContent]))
  ok(apps.length > 0 && apps[0][0], `the editor lists apps the user can run (${apps.map((a) => a[1]).join(', ')})`)
  const appId = apps[0][0]
  const pname = await page.$eval('[data-testid="tile-editor-drill-name-0"]', (e) => e.value)
  ok(pname === 'Machine', `by default the first group column is passed as the parameter ${pname}`)
  const sum = await page.$eval('[data-testid="tile-editor-drill-summary"]', (e) => e.innerText)
  ok(/Param\("Machine"\)/.test(sum) && /not possible/.test(sum), 'the editor explains Param and that opening a screen is not possible')
  await page.screenshot({ path: path.join(OUT, 'tile-editor-drill.png') })
  await clickDom(page, '[data-testid="tile-editor-apply"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tile-editor"]'))
  await page.click('[data-testid="dashboard-save"]')
  await page.waitForSelector('[data-testid="dashboard-title"]')
  ok((await stored(page)).def.tiles.find((t) => t.id === 'machines').drill.appId === appId, 'Save stored the drill target on the tile')
  await tilesReady(page, 7)
  const firstRow = await page.$eval('[data-testid="tile-machines-table"] tbody tr td', (e) => e.textContent)
  ok(await page.$('[data-testid="tile-machines-open"]') !== null, 'the tile has an Open button')
  await page.click('[data-testid="tile-machines-table"] tbody tr')
  await page.waitForFunction((id) => location.hash.startsWith(`#u-${id}`), { timeout: 10000 }, appId)
  const hash = await page.evaluate(() => location.hash)
  ok(new URLSearchParams(hash.split('?')[1]).get('Machine') === firstRow, `clicking a row opens the app with the clicked machine in the address: ${hash}`)
  await page.waitForSelector(`[data-testid="tab-pane-${appId}"]`, { timeout: 15000 })
  ok(true, 'the app is open in its tab')
  await page.screenshot({ path: path.join(OUT, 'drill-app.png') })
  await page.evaluate(() => history.back())
  await page.waitForSelector('[data-testid="dashboard-view"]', { timeout: 15000 })
  await tilesReady(page, 7)
  await page.click('[data-testid="tile-machines-open"]')
  await page.waitForFunction((id) => location.hash === `#u-${id}`, { timeout: 10000 }, appId)
  ok(true, 'the Open button opens the app without values')

  /* ------------------------------------------------------------------ settings */
  await page.goto(pathToFileURL(HTML).href + '#u-dashboards', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-settings-open"]')
  await page.click('[data-testid="dashboard-settings-open"]')
  await page.waitForSelector('[data-testid="settings-timezone"]')
  ok(await page.$eval('[data-testid="settings-timezone"]', (e) => e.value) === 'Asia/Kolkata' && await page.$eval('[data-testid="settings-fiscal"]', (e) => e.value) === '4', 'the settings screen shows the defaults (Asia/Kolkata, April)')
  ok(await page.$eval('[data-testid="settings-save"]', (b) => b.disabled), 'Save waits for a change')
  const setVal = (sel, v) => page.$eval(sel, (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }, v)
  const text = (sel) => page.$eval(sel, (e) => e.innerText)
  await setVal('[data-testid="settings-locale"]', 'english india')
  await setVal('[data-testid="settings-currency"]', 'RS')
  await setVal('[data-testid="settings-timezone"]', 'Mars/Base')
  await sleep(100)
  const body = await text('[data-testid="dashboard-settings"]')
  ok(body.includes('is not a locale code') && body.includes('exactly three letters') && body.includes('is not a time zone name'), 'bad locale, currency and time zone are explained in plain English')
  ok(await page.$eval('[data-testid="settings-save"]', (b) => b.disabled), 'Save is blocked while there are problems')
  await setVal('[data-testid="settings-locale"]', 'en-US')
  await setVal('[data-testid="settings-currency"]', 'usd')
  await setVal('[data-testid="settings-timezone"]', 'Europe/Berlin')
  await setVal('[data-testid="settings-fiscal"]', '1')
  await setVal('[data-testid="settings-week"]', '7')
  // shift C runs past midnight: untick it and the screen says why that is wrong
  await page.$eval('[data-testid="settings-shift-2-next"]', (c) => c.click())
  await sleep(80)
  ok((await text('[data-testid="settings-shift-2"]')).includes('ends before it starts. Tick "Ends the next day"'), 'a shift that ends before it starts without "Ends the next day" is explained')
  ok(await page.$eval('[data-testid="settings-save"]', (b) => b.disabled), 'and blocks Save')
  await page.$eval('[data-testid="settings-shift-2-next"]', (c) => c.click())
  await page.click('[data-testid="settings-add-shift"]')
  await setVal('[data-testid="settings-shift-3-name"]', 'a')
  await sleep(80)
  ok((await text('[data-testid="settings-shift-3"]')).includes('Two shifts are called a'), 'two shifts with the same name are refused in words')
  await setVal('[data-testid="settings-shift-3-name"]', 'Night')
  await setVal('[data-testid="settings-shift-3-start"]', '23:00')
  await setVal('[data-testid="settings-shift-3-end"]', '23:00')
  await sleep(80)
  ok((await text('[data-testid="settings-shift-3"]')).includes('starts and ends at the same time'), 'a shift that starts and ends at the same time is refused in words')
  await page.$eval('[data-testid="settings-shift-3-remove"]', (b) => b.click())
  await sleep(80)
  await page.screenshot({ path: path.join(OUT, 'settings.png') })
  ok(!(await page.$eval('[data-testid="settings-save"]', (b) => b.disabled)), 'with everything fixed Save is enabled')
  await clickDom(page, '[data-testid="settings-save"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="dashboard-settings"]'))
  const keptDemo = await page.evaluate(() => JSON.parse(localStorage.getItem('appbuilder-dashboard-settings')))
  ok(keptDemo.timeZone === 'Europe/Berlin' && keptDemo.currency === 'USD' && keptDemo.fiscalYearStart === 1 && keptDemo.weekStart === 7 && keptDemo.shifts.length === 3, `the settings were stored (demo backend): ${JSON.stringify(keptDemo).slice(0, 120)}...`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-settings-open"]')
  await page.click('[data-testid="dashboard-settings-open"]')
  await page.waitForSelector('[data-testid="settings-timezone"]')
  ok(await page.$eval('[data-testid="settings-timezone"]', (e) => e.value) === 'Europe/Berlin' && await page.$eval('[data-testid="settings-week"]', (e) => e.value) === '7', 'after a reload the screen shows the saved values')
  // dark theme
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.evaluate(() => {
    localStorage.setItem('appbuilder-theme', 'dark')
    for (const k of Object.keys(localStorage)) if (k.startsWith('appbuilder-prefs:')) { const p = JSON.parse(localStorage.getItem(k)); p.theme = 'dark'; localStorage.setItem(k, JSON.stringify(p)) }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="dashboard-settings-open"]')
  await page.click('[data-testid="dashboard-settings-open"]')
  await page.waitForSelector('[data-testid="settings-timezone"]')
  ok(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme is on')
  const bg = await page.$eval('[data-testid="dashboard-settings"]', (e) => getComputedStyle(e).backgroundColor)
  ok(!/rgb\(255, 255, 255\)/.test(bg), `dark theme: the settings screen is dark (${bg})`)
  await page.screenshot({ path: path.join(OUT, 'settings-dark.png') })
  await clickDom(page, '[data-testid="settings-cancel"]')
  // dark theme: the edit-mode dashboard with handles
  await page.goto(pathToFileURL(HTML).href + '#u-dashboards', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid^="dashboard-card-"]')
  await page.click('[data-testid^="dashboard-card-"]')
  await tilesReady(page, 7)
  await page.click('[data-testid="dashboard-edit"]')
  await page.screenshot({ path: path.join(OUT, 'edit-dark.png') })
  await page.close()
} finally {
  await browser.close()
}
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
