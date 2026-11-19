/**
 * A minimal SMTP client (RFC 5321) for the outbound relay: implicit TLS (port 465), STARTTLS (RFC 3207, required when
 * chosen) or plain, AUTH PLAIN / LOGIN (RFC 4954), one message to one recipient per connection, MIME multipart/alternative
 * (text + HTML, UTF-8, base64 bodies, RFC 2047 encoded headers). P1-E: AUTH XOAUTH2 with an OAuth 2.0 access token
 * (Microsoft 365, Google Workspace). No dependency: nodemailer is MIT-0, which is not on our
 * licence allow-list (scripts/lib/licences.mjs).
 *
 * Safety rules: header values containing CR or LF are refused (header injection); the password is never sent over a
 * plain connection unless the relay is on this computer (loopback); certificates are verified unless the administrator
 * turned that off for an internal relay; every step has a timeout.
 */
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { assertOutboundHost } from '../net-policy.ts'

export type SmtpSecurity = 'starttls' | 'tls' | 'none'

export interface SmtpSettings {
  host: string
  port: number
  security: SmtpSecurity
  username?: string
  password?: string
  /** default true; false accepts self-signed certificates (internal relays only) */
  verifyCertificate?: boolean
  /** name sent in EHLO (default: this computer's host name) */
  heloName?: string
  /** per step (default 20 s) */
  timeoutMs?: number
  /**
   * P1-E: OAuth 2.0 instead of a password: an access token (from oauth-token.ts) sent with AUTH XOAUTH2 for `username`
   * (the mailbox), as Microsoft 365 and Google Workspace expect.
   */
  accessToken?: string
}

export interface MailAddress { address: string; name?: string }

export interface MailAttachment {
  fileName: string
  contentType: string
  content: Buffer
}

export interface MailMessage {
  from: MailAddress
  /** one address, or several (P1: flows, reports) */
  to: string | string[]
  /** P1: copies (Cc header) and blind copies (no header; RCPT only) */
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  text: string
  html?: string
  /** P1: files (multipart/mixed) */
  attachments?: MailAttachment[]
  /** P1: extra headers, only List-Unsubscribe, List-Unsubscribe-Post and X-* names */
  headers?: Record<string, string>
}

/** every recipient of a message (To, Cc, Bcc), lowercase, without duplicates */
export function recipientsOf(msg: Pick<MailMessage, 'to' | 'cc' | 'bcc'>): string[] {
  const all = [...(Array.isArray(msg.to) ? msg.to : [msg.to]), ...(msg.cc ?? []), ...(msg.bcc ?? [])]
  return [...new Set(all.map((a) => a.trim()).filter(Boolean))]
}

const EXTRA_HEADER = /^(List-Unsubscribe|List-Unsubscribe-Post|X-[A-Za-z0-9-]{1,60})$/

/** a file name for Content-Disposition: no path, quotes or control characters */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const clean = base.replace(/[\x00-\x1f\x7f"\\]/g, '').trim().slice(0, 150)
  return clean || 'file'
}

function attachmentPart(a: MailAttachment, boundary: string): string {
  const name = safeFileName(a.fileName)
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.contentType) ? a.contentType : 'application/octet-stream'
  const ascii = /^[\x20-\x7e]*$/.test(name)
  const disp = ascii ? `attachment; filename="${name}"` : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  return [
    `--${boundary}`,
    `Content-Type: ${type}${ascii ? `; name="${name}"` : ''}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disp}`,
    '',
    wrap76(a.content.toString('base64')),
  ].join('\r\n')
}

export class SmtpError extends Error {
  /** the SMTP reply code (0: network or TLS problem) */
  code: number
  /** 5xx: the relay refused for good; retrying will not help */
  permanent: boolean
  constructor(message: string, code = 0) {
    super(message)
    this.code = code
    this.permanent = code >= 500 && code < 600
  }
}

const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/

export function assertHeaderSafe(v: string, what: string): void {
  if (/[\r\n]/.test(v)) throw new SmtpError(`${what} must not contain line breaks.`)
}
export function validAddress(a: string): boolean {
  return a.length <= 254 && ADDRESS_RE.test(a)
}

/** RFC 2047 encoded-word when the value is not plain printable ASCII */
export function encodeHeader(v: string): string {
  assertHeaderSafe(v, 'A header')
  if (/^[\x20-\x7e]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

function formatAddress(a: MailAddress): string {
  if (!validAddress(a.address)) throw new SmtpError(`"${a.address}" is not a valid email address.`)
  if (!a.name) return `<${a.address}>`
  assertHeaderSafe(a.name, 'The sender name')
  const name = /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : encodeHeader(a.name)
  return `${name} <${a.address}>`
}

const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, '$1\r\n')
const b64Body = (s: string): string => wrap76(Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'))

/** the full RFC 5322 message (CRLF line ends), without SMTP dot-stuffing */
export function buildMime(msg: MailMessage, o: { date?: Date; messageId?: string; boundary?: string } = {}): { data: string; messageId: string } {
  const toList = Array.isArray(msg.to) ? msg.to : [msg.to]
  if (!toList.length) throw new SmtpError('A message needs at least one recipient.')
  for (const a of [...toList, ...(msg.cc ?? []), ...(msg.bcc ?? [])]) if (!validAddress(a)) throw new SmtpError(`"${a}" is not a valid email address.`)
  if (msg.replyTo && !validAddress(msg.replyTo)) throw new SmtpError(`"${msg.replyTo}" is not a valid reply-to address.`)
  assertHeaderSafe(msg.subject, 'The subject')
  const domain = msg.from.address.split('@')[1] ?? 'localhost'
  const messageId = o.messageId ?? `<${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}>`
  const headers = [
    `From: ${formatAddress(msg.from)}`,
    `To: ${toList.map((a) => `<${a}>`).join(', ')}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.map((a) => `<${a}>`).join(', ')}`] : []),
    ...(msg.replyTo ? [`Reply-To: <${msg.replyTo}>`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${(o.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ]
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    if (!EXTRA_HEADER.test(k)) throw new SmtpError(`The header "${k}" cannot be set.`)
    assertHeaderSafe(v, `The header ${k}`)
    headers.push(`${k}: ${v}`)
  }
  const files = msg.attachments ?? []
  let body: string
  if (files.length) {
    const mixed = `=_abm_${randomBytes(12).toString('hex')}`
    const inner = buildMime({ ...msg, attachments: [], headers: {} }, { ...o, messageId: 'x' })
    // the inner message's content headers and body become the first part
    const [innerHead, ...innerBody] = inner.data.split('\r\n\r\n')
    const contentHeaders = innerHead.split('\r\n').filter((l) => /^Content-(Type|Transfer-Encoding):/i.test(l))
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`)
    body = [`--${mixed}`, ...contentHeaders, '', innerBody.join('\r\n\r\n').replace(/\r\n$/, ''), ...files.map((f) => attachmentPart(f, mixed)), `--${mixed}--`, ''].join('\r\n')
  } else if (msg.html) {
    const boundary = o.boundary ?? `=_ab_${randomBytes(12).toString('hex')}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Body(msg.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Body(msg.html),
      `--${boundary}--`,
      '',
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64')
    body = b64Body(msg.text) + '\r\n'
  }
  return { data: headers.join('\r\n') + '\r\n\r\n' + body, messageId }
}

/** SMTP transparency (RFC 5321 4.5.2): a line starting with "." gets a second one */
export const dotStuff = (data: string): string => data.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..')

interface Reply { code: number; lines: string[] }

const isLoopbackHost = (h: string): boolean => h === 'localhost' || h === '::1' || /^127\./.test(h)

/** one SMTP conversation over a socket that may be upgraded to TLS */
class Conversation {
  private socket: net.Socket | tls.TLSSocket
  private buf = ''
  private waiting: { resolve(r: Reply): void; reject(e: Error): void } | null = null
  private pending: Reply[] = []
  private lines: string[] = []
  private failure: Error | null = null
  private timeoutMs: number
  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.timeoutMs = timeoutMs
    this.socket = socket
    this.attach(socket)
  }
  private attach(s: net.Socket | tls.TLSSocket) {
    s.setEncoding('utf8')
    s.on('data', (d: string) => this.onData(d))
    s.on('error', (e: Error) => this.fail(new SmtpError(`Connection problem: ${e.message}`)))
    s.on('close', () => this.fail(new SmtpError('The mail server closed the connection.')))
  }
  private fail(e: Error) {
    if (!this.failure) this.failure = e
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w.reject(this.failure)
    }
  }
  private onData(d: string) {
    this.buf += d
    if (this.buf.length > 64 * 1024) return this.fail(new SmtpError('The mail server sent an overlong reply.'))
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) return this.fail(new SmtpError(`Unexpected reply from the mail server: ${line.slice(0, 80)}`))
      this.lines.push(m[3])
      if (m[2] === ' ') {
        const r = { code: Number(m[1]), lines: this.lines }
        this.lines = []
        if (this.waiting) {
          const w = this.waiting
          this.waiting = null
          w.resolve(r)
        } else this.pending.push(r)
      }
    }
  }
  read(): Promise<Reply> {
    const next = this.pending.shift()
    if (next) return Promise.resolve(next)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = null
        reject(new SmtpError('The mail server did not answer in time.'))
        this.socket.destroy()
      }, this.timeoutMs)
      this.waiting = {
        resolve: (r) => { clearTimeout(t); resolve(r) },
        reject: (e) => { clearTimeout(t); reject(e) },
      }
    })
  }
  write(text: string) {
    if (this.failure) throw this.failure
    this.socket.write(text)
  }
  /** sends a command and expects one of the codes */
  async cmd(line: string, expect: number[], shown = line): Promise<Reply> {
    this.write(line + '\r\n')
    const r = await this.read()
    if (!expect.includes(r.code)) throw new SmtpError(`The mail server refused "${shown}": ${r.code} ${r.lines.join(' ').slice(0, 300)}`, r.code)
    return r
  }
  async upgrade(servername: string, verify: boolean): Promise<void> {
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('close')
    plain.removeAllListeners('error')
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: net.isIP(servername) ? undefined : servername, rejectUnauthorized: verify, minVersion: 'TLSv1.2' }, () => resolve(s))
      s.once('error', (e) => reject(new SmtpError(`TLS failed: ${e.message}`)))
      setTimeout(() => reject(new SmtpError('TLS negotiation timed out.')), this.timeoutMs).unref()
    })
    this.socket = secure
    this.attach(secure)
  }
  get encrypted(): boolean {
    return (this.socket as tls.TLSSocket).encrypted === true
  }
  close() {
    this.socket.end()
    this.socket.destroy()
  }
}

function connect(s: SmtpSettings, timeoutMs: number, address?: string): Promise<net.Socket | tls.TLSSocket> {
  // the address the outbound policy checked (no second DNS answer in between); TLS still checks the host name
  const host = address ?? s.host
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(new SmtpError(`Could not connect to ${s.host}:${s.port}: ${e.message}`))
    const sock = s.security === 'tls'
      ? tls.connect({ host, port: s.port, servername: net.isIP(s.host) ? undefined : s.host, rejectUnauthorized: s.verifyCertificate !== false, minVersion: 'TLSv1.2' }, () => resolve(sock))
      : net.connect({ host, port: s.port }, () => resolve(sock))
    sock.once('error', onErr)
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      reject(new SmtpError(`Could not connect to ${s.host}:${s.port} in time.`))
    })
    sock.once('connect', () => sock.setTimeout(0))
    sock.once('secureConnect', () => sock.setTimeout(0))
  })
}

/** sends one message; resolves with the Message-ID and the relay's final answer */
export async function sendSmtp(s: SmtpSettings, msg: MailMessage): Promise<{ messageId: string; response: string }> {
  const timeoutMs = s.timeoutMs ?? 20_000
  const { data, messageId } = buildMime(msg)
  if (!validAddress(msg.from.address)) throw new SmtpError(`"${msg.from.address}" is not a valid sender address.`)
  let addrs: string[]
  try {
    addrs = await assertOutboundHost(s.host, 'SMTP relay')
  } catch (e) {
    throw new SmtpError((e as Error).message)
  }
  const socket = await connect(s, timeoutMs, addrs[0])
  const c = new Conversation(socket, timeoutMs)
  try {
    const greeting = await c.read()
    if (greeting.code !== 220) throw new SmtpError(`The mail server is not ready: ${greeting.code} ${greeting.lines.join(' ')}`, greeting.code)
    const helo = (s.heloName || os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'
    let ehlo = await c.cmd(`EHLO ${helo}`, [250])
    const has = (r: Reply, ext: string) => r.lines.some((l) => l.toUpperCase().split(/\s+/)[0] === ext)
    if (s.security === 'starttls') {
      if (!has(ehlo, 'STARTTLS')) throw new SmtpError('The mail server does not offer STARTTLS. Choose another security mode or another port.')
      await c.cmd('STARTTLS', [220])
      await c.upgrade(s.host, s.verifyCertificate !== false)
      ehlo = await c.cmd(`EHLO ${helo}`, [250])
    }
    if (s.username) {
      if (!c.encrypted && !isLoopbackHost(s.host)) throw new SmtpError('Refusing to send the password over an unencrypted connection. Use STARTTLS or TLS.')
      const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))
      const mechs = auth ? auth.slice(5).toUpperCase().split(/\s+/) : []
      const pass = s.password ?? ''
      if (s.accessToken !== undefined) {
        if (!mechs.includes('XOAUTH2')) throw new SmtpError('The mail server does not offer OAuth 2.0 sign-in (AUTH XOAUTH2). Use a password, or check the host and port.')
        assertHeaderSafe(s.username, 'The mailbox')
        if (/[\x00-\x1f]/.test(s.accessToken)) throw new SmtpError('The access token is not valid.')
        const token = Buffer.from(`user=${s.username}\x01auth=Bearer ${s.accessToken}\x01\x01`, 'utf8').toString('base64')
        c.write(`AUTH XOAUTH2 ${token}\r\n`)
        let r = await c.read()
        if (r.code === 334) {
          // an error challenge (base64 JSON with the reason): answer with an empty line, the server then fails the AUTH
          let why = ''
          try { why = Buffer.from(r.lines.join(''), 'base64').toString('utf8').slice(0, 200) } catch { /* not base64 */ }
          c.write('\r\n')
          r = await c.read()
          throw new SmtpError(`The mail server refused the OAuth 2.0 sign-in: ${r.code} ${r.lines.join(' ').slice(0, 200)}${why ? ` (${why})` : ''}`, r.code >= 500 ? r.code : 535)
        }
        if (r.code !== 235) throw new SmtpError(`The mail server refused the OAuth 2.0 sign-in: ${r.code} ${r.lines.join(' ').slice(0, 300)}`, r.code)
      } else if (mechs.includes('PLAIN')) {
        const token = Buffer.from(`\0${s.username}\0${pass}`, 'utf8').toString('base64')
        await c.cmd(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN (credentials hidden)')
      } else if (mechs.includes('LOGIN')) {
        await c.cmd('AUTH LOGIN', [334])
        await c.cmd(Buffer.from(s.username, 'utf8').toString('base64'), [334], '(user name hidden)')
        await c.cmd(Buffer.from(pass, 'utf8').toString('base64'), [235], '(password hidden)')
      } else {
        throw new SmtpError('The mail server offers no sign-in method we support (PLAIN or LOGIN).')
      }
    }
    await c.cmd(`MAIL FROM:<${msg.from.address}>`, [250])
    for (const rcpt of recipientsOf(msg)) await c.cmd(`RCPT TO:<${rcpt}>`, [250, 251])
    await c.cmd('DATA', [354])
    c.write(dotStuff(data) + '\r\n.\r\n')
    const done = await c.read()
    if (done.code !== 250) throw new SmtpError(`The mail server refused the message: ${done.code} ${done.lines.join(' ').slice(0, 300)}`, done.code)
    try {
      c.write('QUIT\r\n')
    } catch { /* closed already */ }
    return { messageId, response: `${done.code} ${done.lines.join(' ')}`.slice(0, 300) }
  } finally {
    c.close()
  }
}
