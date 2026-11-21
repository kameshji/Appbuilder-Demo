/**
 * Where the setup screen says the setup code is: the server window, or the setup-code file of a server installed as a
 * service (APPBUILDER_SETUP_CODE_FILE set: only that fact is sent, never the path); `appbuilder setup-code` prints it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type AppServer } from '../app.ts'
import { setQuiet } from '../util.ts'
import { runSetupCodeCli } from './admin-cli.ts'
import { setupCodeWhere } from '../auth.ts'

setQuiet(true)

describe('setup code location', () => {
  const dirs: string[] = []
  const apps: { app: AppServer; server: http.Server }[] = []
  // the status reads whether the server's console is interactive (a service has none); each test says which it is
  const tty = process.stdout.isTTY
  const setTty = (v: boolean | undefined) => Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true, writable: true })
  const start = async (env: NodeJS.ProcessEnv, consoleIsTty = true) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-setupcode-'))
    dirs.push(tmp)
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    let app: AppServer
    try {
      app = await createApp({ env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replace('<tmp>', tmp)])), config: { workspaceDir: tmp }, jobs: false })
    } finally {
      process.stdout.write = write
    }
    const server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    apps.push({ app, server })
    setTty(consoleIsTty)
    const status = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/status`)).json()
    setTty(tty)
    return { tmp, app, status }
  }
  afterAll(async () => {
    for (const a of apps) {
      await new Promise<void>((r) => a.server.close(() => r()))
      await a.app.close()
    }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  })

  it('started by hand: the code is in the server window', async () => {
    const { status } = await start({})
    expect(status.setup).toMatchObject({ needsDatabase: true, codeIn: 'console' })
    expect(['windows', 'linux', 'macos']).toContain(status.setup.platform)
  })

  it('started by hand in a console WITH APPBUILDER_SETUP_CODE_FILE: the window and the file, not "a service"', async () => {
    const { status } = await start({ APPBUILDER_SETUP_CODE_FILE: '<tmp>/setup-code.txt' }, true)
    expect(status.setup.codeIn).toBe('both')
  })

  it('the rule: no file -> console; a file and a console -> both; a file and no console (a service) -> file', () => {
    expect(setupCodeWhere(false, true)).toBe('console')
    expect(setupCodeWhere(false, false)).toBe('console')
    expect(setupCodeWhere(true, true)).toBe('both')
    expect(setupCodeWhere(true, false)).toBe('file')
  })

  it('installed as a service: the code is in its file (the path is not sent); appbuilder setup-code prints it', async () => {
    const { tmp, app, status } = await start({ APPBUILDER_SETUP_CODE_FILE: '<tmp>/setup-code.txt' }, false)
    expect(status.setup.codeIn).toBe('file')
    expect(JSON.stringify(status)).not.toContain('setup-code.txt')
    const out: string[] = []
    const err: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
    expect(runSetupCodeCli({ env: { APPBUILDER_SETUP_CODE_FILE: path.join(tmp, 'setup-code.txt') }, io })).toBe(0)
    const code = app.services.setupCode.current()!
    expect(out[0]).toBe(`Setup code: ${code.slice(0, 4)}-${code.slice(4)}`)
    expect(runSetupCodeCli({ env: {}, io })).toBe(1)
    expect(err[0]).toMatch(/window/)
    expect(runSetupCodeCli({ env: { APPBUILDER_SETUP_CODE_FILE: path.join(tmp, 'nope.txt') }, io })).toBe(1)
    expect(err[1]).toMatch(/no setup code/i)
  })
})
