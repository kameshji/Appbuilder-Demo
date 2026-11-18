/**
 * Demo mode realtime check (package H). DEVELOPER TOOL. Serve the built single file WITHOUT the API, e.g.
 *   cp dist/index.html /tmp/demo-dist/ && (cd /tmp/demo-dist && python3 -m http.server 5198 --bind 127.0.0.1)
 * then:  node scripts/docs-shots/live-demo.mjs        (BASE default http://127.0.0.1:5198/index.html)
 * Two tabs of one browser: a contact saved in the form of tab 1 shows up in tab 2's table without a reload, a
 * notification sent in tab 1 reaches the bell of tab 2, and each tab sees the other's presence avatar.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '/tmp/pgcheck/node_modules/puppeteer-core'
const { default: puppeteer } = await import(pathToFileURL(path.join(PUPPETEER_CORE, 'lib/puppeteer/puppeteer-core.js')).href)
const BASE = process.env.BASE || 'http://127.0.0.1:5198/index.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const waitText = async (page, needle, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true
    await sleep(150)
  }
  return false
}
try {
  const ctx = browser.defaultBrowserContext()
  const one = await ctx.newPage()
  await one.setViewport({ width: 1440, height: 900 })
  one.on('pageerror', (e) => console.log('  [tab 1 error]', e.message))
  await one.goto(BASE, { waitUntil: 'networkidle0' })
  await sleep(1500)
  // the sample app's id from the launcher link
  await one.goto(BASE + '#u', { waitUntil: 'networkidle0' })
  await sleep(800)
  const appId = await one.evaluate(() => document.querySelector('[data-testid^="launcher-open-"]')?.getAttribute('data-testid')?.slice('launcher-open-'.length))
  check(!!appId, 'demo workspace with the sample app')
  const two = await ctx.newPage()
  await two.setViewport({ width: 1440, height: 900 })
  for (const p of [one, two]) {
    await p.goto(`${BASE}#u-${appId}`, { waitUntil: 'networkidle0' })
  }
  await sleep(1500)
  check(!!(await two.$('[data-testid="app-live-bar"] [data-testid="presence-avatars"]')), 'tab 2 sees the other tab on the app')
  // a background tab does not paint: bring tab 1 to the front to type in it
  await one.bringToFront()
  // tab 1: select the first contact and change its company in the form
  const first = await one.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-testid="tab-run-root"] td')]
    const c = cells[0]
    c?.click()
    return c?.textContent?.trim()
  })
  await sleep(500)
  const marker = `Demo Sync ${Date.now() % 10000}`
  const input = await one.evaluateHandle(() => {
    const label = [...document.querySelectorAll('[data-testid="tab-run-root"] label')].find((l) => l.textContent?.trim().startsWith('Company'))
    return label ? document.getElementById(label.getAttribute('for')) : null
  })
  check(!!first && (await one.evaluate((el) => !!el, input)), 'tab 1 has a contact open in the form')
  await input.click({ clickCount: 3 })
  await one.keyboard.press('Backspace')
  await input.type(marker)
  await one.click('[data-testid="form-save"]')
  check(await waitText(two, marker, 10000), "tab 2's table shows tab 1's saved change without a reload")
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser.close()
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
