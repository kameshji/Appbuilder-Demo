/**
 * A fake SMTP server for tests and the headless run (never used at run time): EHLO, STARTTLS (when given a certificate),
 * AUTH PLAIN / LOGIN, MAIL, RCPT, DATA, RSET, NOOP, QUIT. Received messages are kept in `inbox` with their decoded text
 * and HTML parts. `failNext` makes the next messages fail with a code (retry tests).
 */
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface ReceivedMail {
  from: string
  to: string[]
  data: string
  subject: string
  text: string
  html: string
  headers: Record<string, string>
  tls: boolean
  authUser: string | null
  /** P1: decoded attachments */
  attachments: ReceivedAttachment[]
}

export interface FakeSmtp {
  port: number
  inbox: ReceivedMail[]
  /** the next n DATA commands (to `to` only, when given) answer with this code (e.g. 451 temporary, 550 permanent) */
  failNext(n: number, code: number, to?: string): void
  /** resolves when the inbox has at least n messages (or rejects after timeoutMs) */
  waitFor(n: number, timeoutMs?: number): Promise<ReceivedMail[]>
  close(): Promise<void>
}

export interface FakeSmtpOptions {
  /** PEM key and certificate: STARTTLS is offered (or implicit TLS when implicitTls) */
  tls?: { key: string; cert: string }
  implicitTls?: boolean
  /** required credentials (AUTH is offered either way) */
  user?: string
  password?: string
  /** listen address (default 127.0.0.1) */
  listen?: string
  /** P1-E: offer AUTH XOAUTH2 and accept this bearer token (for the user `user`, when given) */
  oauthToken?: string
}

/** a throw-away self-signed certificate for localhost (openssl must be installed) */
export function selfSignedCert(): { key: string; cert: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-smtp-cert-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
    return { key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function decodeWord(v: string): string {
  return v.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'))
}

/** an attachment of a received message (decoded) */
export interface ReceivedAttachment { fileName: string; contentType: string; content: Buffer }

function splitHead(part: string): { headers: Record<string, string>; body: string } {
  const i = part.indexOf('\r\n\r\n')
  const head = i >= 0 ? part.slice(0, i) : part
  const body = i >= 0 ? part.slice(i + 4) : ''
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const j = line.indexOf(':')
    if (j > 0) headers[line.slice(0, j).toLowerCase()] = decodeWord(line.slice(j + 1).trim())
  }
  return { headers, body }
}

/**
 * parses the messages our client builds: headers, then one text part, multipart/alternative, or multipart/mixed
 * (alternative + attachments, P1)
 */
export function parseMessage(data: string): { headers: Record<string, string>; text: string; html: string; attachments: ReceivedAttachment[] } {
  const top = splitHead(data)
  let text = ''
  let html = ''
  const attachments: ReceivedAttachment[] = []
  const bytes = (h: Record<string, string>, b: string): Buffer => (/base64/i.test(h['content-transfer-encoding'] ?? '') ? Buffer.from(b.replace(/\s/g, ''), 'base64') : Buffer.from(b, 'utf8'))
  const visit = (h: Record<string, string>, b: string, depth: number) => {
    const ct = h['content-type'] ?? 'text/plain'
    const m = /boundary="([^"]+)"/.exec(ct)
    if (m && depth < 5) {
      for (const raw of b.split(`--${m[1]}`).slice(1)) {
        if (raw.startsWith('--')) break
        const part = splitHead(raw.replace(/^\r\n/, ''))
        visit(part.headers, part.body.replace(/\r\n$/, ''), depth + 1)
      }
      return
    }
    const disp = h['content-disposition'] ?? ''
    if (/attachment/i.test(disp)) {
      const fn = /filename\*=UTF-8''([^;]+)/i.exec(disp)?.[1]
      attachments.push({ fileName: fn ? decodeURIComponent(fn) : (/filename="([^"]*)"/i.exec(disp)?.[1] ?? 'file'), contentType: ct.split(';')[0].trim(), content: bytes(h, b) })
    } else if (/text\/html/i.test(ct)) html = bytes(h, b).toString('utf8')
    else if (/text\/plain/i.test(ct)) text = bytes(h, b).toString('utf8')
  }
  visit(top.headers, top.body, 0)
  return { headers: top.headers, text, html, attachments }
}

export async function startFakeSmtp(o: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const inbox: ReceivedMail[] = []
  const waiters: (() => void)[] = []
  let failCount = 0
  let failCode = 451
  let failTo: string | undefined
  const sockets = new Set<net.Socket>()

  const handle = (raw: net.Socket, startTls: boolean) => {
    let sock: net.Socket = raw
    sockets.add(raw)
    let isTls = startTls
    let buf = ''
    let from = ''
    let to: string[] = []
    let inData = false
    let data = ''
    let authUser: string | null = null
    let loginStep: 0 | 1 | 2 = 0
    let xoauthFailed = false
    let loginUser = ''
    const send = (l: string) => sock.write(l + '\r\n')
    const okCreds = (u: string, p: string) => (o.user === undefined || (u === o.user && p === (o.password ?? '')))
    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false
          if (failCount > 0 && (!failTo || to.includes(failTo))) {
            failCount--
            send(`${failCode} ${failCode >= 500 ? 'Rejected for good' : 'Try again later'}`)
            return
          }
          const unstuffed = data.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.')
          const p = parseMessage(unstuffed)
          inbox.push({ from, to, data: unstuffed, subject: p.headers.subject ?? '', text: p.text, html: p.html, headers: p.headers, tls: isTls, authUser, attachments: p.attachments })
          for (const w of waiters.splice(0)) w()
          send('250 2.0.0 Ok: queued')
          from = ''
          to = []
          data = ''
          return
        }
        data += (data ? '\r\n' : '') + line
        return
      }
      if (xoauthFailed) {
        // the client's empty answer to the error challenge (RFC 7628 style)
        xoauthFailed = false
        return send('535 5.7.3 Authentication unsuccessful')
      }
      if (loginStep === 1) {
        loginUser = Buffer.from(line, 'base64').toString('utf8')
        loginStep = 2
        return send('334 UGFzc3dvcmQ6')
      }
      if (loginStep === 2) {
        loginStep = 0
        const pass = Buffer.from(line, 'base64').toString('utf8')
        if (!okCreds(loginUser, pass)) return send('535 5.7.8 Authentication failed')
        authUser = loginUser
        return send('235 2.7.0 Authentication successful')
      }
      const [verb, ...args] = line.split(' ')
      const arg = args.join(' ')
      switch (verb.toUpperCase()) {
        case 'EHLO':
        case 'HELO':
          sock.write(`250-fake.smtp Hello\r\n${o.tls && !isTls ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN LOGIN${o.oauthToken ? ' XOAUTH2' : ''}\r\n250 8BITMIME\r\n`)
          return
        case 'STARTTLS': {
          if (!o.tls || isTls) return send('454 TLS not available')
          send('220 Ready to start TLS')
          sock.removeAllListeners('data')
          const secure = new tls.TLSSocket(sock, { isServer: true, key: o.tls.key, cert: o.tls.cert })
          sockets.add(secure)
          sock = secure
          isTls = true
          buf = ''
          secure.setEncoding('utf8')
          secure.on('data', onData)
          secure.on('error', () => {})
          return
        }
        case 'AUTH': {
          const [mech, initial] = arg.split(' ')
          if (mech?.toUpperCase() === 'PLAIN') {
            const parts = Buffer.from(initial ?? '', 'base64').toString('utf8').split('\0')
            if (!okCreds(parts[1] ?? '', parts[2] ?? '')) return send('535 5.7.8 Authentication failed')
            authUser = parts[1] ?? ''
            return send('235 2.7.0 Authentication successful')
          }
          if (mech?.toUpperCase() === 'XOAUTH2' && o.oauthToken) {
            const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(Buffer.from(initial ?? '', 'base64').toString('utf8'))
            if (m && m[2] === o.oauthToken && (o.user === undefined || m[1] === o.user)) {
              authUser = m[1]
              return send('235 2.7.0 Authentication successful')
            }
            xoauthFailed = true
            return send(`334 ${Buffer.from(JSON.stringify({ status: '401', schemes: 'bearer', scope: 'https://mail.google.com/' })).toString('base64')}`)
          }
          if (mech?.toUpperCase() === 'LOGIN') {
            loginStep = 1
            return send('334 VXNlcm5hbWU6')
          }
          return send('504 Unrecognized authentication type')
        }
        case 'MAIL':
          if (o.user !== undefined && !authUser) return send('530 5.7.0 Authentication required')
          from = /<([^>]*)>/.exec(arg)?.[1] ?? ''
          return send('250 2.1.0 Ok')
        case 'RCPT':
          to.push(/<([^>]*)>/.exec(arg)?.[1] ?? '')
          return send('250 2.1.5 Ok')
        case 'DATA':
          inData = true
          data = ''
          return send('354 End data with <CR><LF>.<CR><LF>')
        case 'RSET':
          from = ''
          to = []
          return send('250 Ok')
        case 'NOOP':
          return send('250 Ok')
        case 'QUIT':
          send('221 Bye')
          sock.end()
          return
        default:
          return send('502 Command not implemented')
      }
    }
    const onData = (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        onLine(line)
      }
    }
    sock.setEncoding('utf8')
    sock.on('data', onData)
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(raw))
    send('220 fake.smtp ESMTP ready')
  }

  const server = o.implicitTls && o.tls
    ? tls.createServer({ key: o.tls.key, cert: o.tls.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false))
  await new Promise<void>((r) => server.listen(0, o.listen ?? '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    inbox,
    failNext(n, code, to) {
      failCount = n
      failCode = code
      failTo = to
    },
    waitFor(n, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`fake SMTP: expected ${n} message(s), got ${inbox.length}`)), timeoutMs)
        const check = () => {
          if (inbox.length >= n) {
            clearTimeout(t)
            resolve(inbox)
          } else waiters.push(check)
        }
        check()
      })
    },
    close() {
      for (const s of sockets) s.destroy()
      return new Promise((r) => server.close(() => r()))
    },
  }
}
