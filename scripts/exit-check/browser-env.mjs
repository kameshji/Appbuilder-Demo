/**
 * Where Chrome and puppeteer-core are, for the developer-tool scripts (exit checks, benchmarks, drills). DEVELOPER TOOL.
 * CHROME_PATH and PUPPETEER_CORE win; otherwise the usual places of the current system are tried, so the same script runs on
 * Linux, macOS and Windows. Neither Chrome nor puppeteer-core is a dependency of the product.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function chromePath(env = process.env) {
  if (env.CHROME_PATH) return env.CHROME_PATH
  const pf = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
  const list = process.platform === 'win32'
    ? [...pf.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...pf.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return list.find((f) => fs.existsSync(f)) ?? list[0] ?? 'chrome'
}

/** the folder of puppeteer-core (it has lib/puppeteer/puppeteer-core.js) */
export function puppeteerCorePath(root, env = process.env) {
  if (env.PUPPETEER_CORE) return env.PUPPETEER_CORE
  const list = [path.join(root, 'node_modules', 'puppeteer-core'), path.join(os.tmpdir(), 'pgcheck', 'node_modules', 'puppeteer-core'), '/tmp/pgcheck/node_modules/puppeteer-core']
  return list.find((d) => fs.existsSync(path.join(d, 'lib', 'puppeteer', 'puppeteer-core.js'))) ?? list[0]
}
