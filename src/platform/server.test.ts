/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isSafeRelPath, pathProblem, resolveSafe, PathError } from '../../server/pathGuard.mjs'
import { createFsHandler } from '../../server/handler.mjs'
import { LocalFolderStorage } from './storage'

describe('server path guard', () => {
  it('accepts ordinary relative paths', () => {
    expect(isSafeRelPath('workspace.yaml')).toBe(true)
    expect(isSafeRelPath('tables/Contacts.csv')).toBe(true)
    expect(isSafeRelPath('apps/app_1a2b.app.yaml')).toBe(true)
    expect(isSafeRelPath('a/b/c/d.txt')).toBe(true)
    expect(isSafeRelPath('', { allowEmpty: true })).toBe(true)
  })

  it('rejects absolute paths, parent segments, backslashes and NUL', () => {
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
    expect(isSafeRelPath('C:/Windows/win.ini')).toBe(false)
    expect(isSafeRelPath('c:\\x')).toBe(false)
    expect(isSafeRelPath('..')).toBe(false)
    expect(isSafeRelPath('../secret')).toBe(false)
    expect(isSafeRelPath('a/../../b')).toBe(false)
    expect(isSafeRelPath('a/..')).toBe(false)
    expect(isSafeRelPath('a\\b')).toBe(false)
    expect(isSafeRelPath('a\0b')).toBe(false)
    expect(isSafeRelPath('a//b')).toBe(false)
    expect(isSafeRelPath('./a')).toBe(false)
    expect(isSafeRelPath('a/./b')).toBe(false)
    expect(isSafeRelPath('x'.repeat(500))).toBe(false)
    expect(isSafeRelPath(undefined)).toBe(false)
    expect(pathProblem('../x')).toMatch(/\.\./)
  })

  it('resolveSafe stays inside the root, also through symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-guard-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-outside-'))
    try {
      expect(resolveSafe(root, 'tables/a.csv')).toBe(path.join(root, 'tables', 'a.csv'))
      expect(resolveSafe(root, '', { allowEmpty: true })).toBe(root)
      expect(() => resolveSafe(root, '../x')).toThrow(PathError)
      expect(() => resolveSafe(root, '/abs')).toThrow(PathError)
      fs.symlinkSync(outside, path.join(root, 'link'))
      expect(() => resolveSafe(root, 'link/file.txt')).toThrow(/symlink/)
      expect(() => resolveSafe(root, 'link')).toThrow(PathError)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('server fs api', () => {
  let root: string
  let outside: string
  let server: http.Server
  let base: string

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ws-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-out-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
    const api = createFsHandler({ root, maxBodyBytes: 1024 })
    server = http.createServer((req, res) => {
      api.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end('next')
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const q = (p: string) => encodeURIComponent(p)
  const put = (p: string, body: string) => fetch(`${base}/api/fs/write?path=${q(p)}`, { method: 'PUT', body })

  it('health reports the root', async () => {
    const res = await fetch(`${base}/api/fs/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; root: string }
    expect(body.ok).toBe(true)
    expect(body.root).toBe(root)
  })

  it('writes (creating folders), reads, lists and removes', async () => {
    expect((await put('tables/Notes.csv', 'a,b\r\n1,2')).status).toBe(200)
    expect(fs.readFileSync(path.join(root, 'tables', 'Notes.csv'), 'utf8')).toBe('a,b\r\n1,2')
    const read = await fetch(`${base}/api/fs/read?path=${q('tables/Notes.csv')}`)
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('a,b\r\n1,2')
    await put('tables/Other.csv', 'x')
    const list = (await (await fetch(`${base}/api/fs/list?dir=tables`)).json()) as { files: string[] }
    expect(list.files).toEqual(['Notes.csv', 'Other.csv'])
    expect(((await (await fetch(`${base}/api/fs/list?dir=missing`)).json()) as { files: string[] }).files).toEqual([])
    expect(((await (await fetch(`${base}/api/fs/list?dir=`)).json()) as { files: string[] }).files).toEqual([])
    expect((await fetch(`${base}/api/fs/remove?path=${q('tables/Notes.csv')}`, { method: 'DELETE' })).status).toBe(200)
    const gone = await fetch(`${base}/api/fs/read?path=${q('tables/Notes.csv')}`)
    expect(gone.status).toBe(204)
    expect(gone.headers.get('x-appbuilder-missing')).toBe('1')
    expect(await gone.text()).toBe('')
    expect((await fetch(`${base}/api/fs/remove?path=${q('tables/Notes.csv')}`, { method: 'DELETE' })).status).toBe(200) // idempotent
  })

  it('LocalFolderStorage.readText returns null for a missing file and the text for an existing one', async () => {
    const storage = new LocalFolderStorage('workspace', base)
    expect(await storage.readText('workspace.yaml')).toBeNull()
    await put('workspace.yaml', 'name: demo')
    expect(await storage.readText('workspace.yaml')).toBe('name: demo')
    fs.rmSync(path.join(root, 'workspace.yaml'), { force: true })
  })

  it('overwrites atomically and leaves no temp files behind', async () => {
    await put('atomic.txt', 'one')
    await put('atomic.txt', 'two')
    expect(fs.readFileSync(path.join(root, 'atomic.txt'), 'utf8')).toBe('two')
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const files = ((await (await fetch(`${base}/api/fs/list?dir=`)).json()) as { files: string[] }).files
    expect(files).toContain('atomic.txt')
  })

  it('rejects path escapes with 400 and never touches files outside the root', async () => {
    for (const bad of ['../secret.txt', '/etc/passwd', 'a\\b', 'a/../../x', 'a\0b', '', 'C:/x']) {
      const r = await fetch(`${base}/api/fs/read?path=${q(bad)}`)
      expect(r.status, `read ${JSON.stringify(bad)}`).toBe(400)
    }
    expect((await put('../escape.txt', 'x')).status).toBe(400)
    expect((await put('/tmp/escape.txt', 'x')).status).toBe(400)
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.txt'))).toBe(false)
    expect((await fetch(`${base}/api/fs/remove?path=${q('../x')}`, { method: 'DELETE' })).status).toBe(400)
    expect((await fetch(`${base}/api/fs/list?dir=${q('..')}`)).status).toBe(400)
    // raw (unencoded) dot-dot segments in the URL path are normalised by the client; the query form is what matters
    const raw = await fetch(`${base}/api/fs/read?path=..%2F..%2Fetc%2Fpasswd`)
    expect(raw.status).toBe(400)
  })

  it('does not follow symlinks out of the workspace', async () => {
    fs.symlinkSync(outside, path.join(root, 'linked'))
    expect((await fetch(`${base}/api/fs/read?path=${q('linked/secret.txt')}`)).status).toBe(400)
    expect((await put('linked/new.txt', 'x')).status).toBe(400)
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
  })

  it('limits the body size', async () => {
    expect((await put('big.txt', 'x'.repeat(2048))).status).toBe(413)
    expect(fs.existsSync(path.join(root, 'big.txt'))).toBe(false)
    expect((await put('ok.txt', 'x'.repeat(1000))).status).toBe(200)
  })

  it('rejects wrong methods, unknown routes and foreign Host or Origin headers; ignores other urls', async () => {
    expect((await fetch(`${base}/api/fs/read?path=a`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${base}/api/fs/write?path=a`)).status).toBe(405)
    expect((await fetch(`${base}/api/fs/nope`)).status).toBe(404)
    expect(await (await fetch(`${base}/index.html`)).text()).toBe('next') // not an api request: falls through
    const hostile = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/fs/health`, { headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(hostile).toBe(403)
    const foreign = await fetch(`${base}/api/fs/health`, { headers: { Origin: 'https://evil.example.com' } })
    expect(foreign.status).toBe(403)
    const same = await fetch(`${base}/api/fs/health`, { headers: { Origin: 'http://localhost:5173' } })
    expect(same.status).toBe(200)
  })
})
