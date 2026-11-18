import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMime, dotStuff, encodeHeader, sendSmtp, SmtpError } from './smtp.ts'
import { parseMessage, selfSignedCert, startFakeSmtp, type FakeSmtp } from './fake-smtp.ts'

const msg = { from: { address: 'noreply@example.com', name: 'Acme Ünits' }, to: 'ana@example.com', replyTo: 'help@example.com', subject: 'Reset — your code', text: 'Line one\n.starts with a dot\nLine 3', html: '<p>Hello <b>Ana</b></p>' }

describe('MIME building', () => {
  it('encodes non-ASCII headers, builds multipart/alternative, and round-trips the bodies', () => {
    const { data, messageId } = buildMime(msg, { boundary: 'b1', messageId: '<x@example.com>' })
    expect(data).toContain('From: =?UTF-8?B?')
    expect(data).toContain('Subject: =?UTF-8?B?')
    expect(data).toContain('Reply-To: <help@example.com>')
    expect(data).toContain('multipart/alternative; boundary="b1"')
    expect(messageId).toBe('<x@example.com>')
    const p = parseMessage(data)
    expect(p.headers.subject).toBe('Reset — your code')
    expect(p.text).toBe('Line one\r\n.starts with a dot\r\nLine 3')
    expect(p.html).toBe('<p>Hello <b>Ana</b></p>')
  })
  it('refuses header injection and bad addresses', () => {
    expect(() => buildMime({ ...msg, subject: 'Hi\r\nBcc: evil@example.com' })).toThrow(SmtpError)
    expect(() => buildMime({ ...msg, to: 'ana@example.com>\r\nRCPT TO:<x@y.z' })).toThrow(SmtpError)
    expect(() => buildMime({ ...msg, from: { address: 'a@b.c', name: 'x\ny' } })).toThrow(SmtpError)
    expect(() => buildMime({ ...msg, to: 'not-an-address' })).toThrow(SmtpError)
    expect(encodeHeader('plain')).toBe('plain')
  })
  it('dot-stuffs lines starting with a dot', () => {
    expect(dotStuff('.a\r\nb\r\n.c')).toBe('..a\r\nb\r\n..c')
  })
})

describe('SMTP client against a local fake server', () => {
  const cert = selfSignedCert()
  let plain: FakeSmtp
  let starttls: FakeSmtp | null = null
  let implicit: FakeSmtp | null = null
  beforeAll(async () => {
    plain = await startFakeSmtp({ user: 'relay', password: 's3cret' })
    if (cert) {
      starttls = await startFakeSmtp({ tls: cert, user: 'relay', password: 's3cret' })
      implicit = await startFakeSmtp({ tls: cert, implicitTls: true })
    }
  })
  afterAll(async () => {
    await plain?.close()
    await starttls?.close()
    await implicit?.close()
  })

  it('plain on loopback with AUTH PLAIN: delivers, dot-stuffing survives', async () => {
    const r = await sendSmtp({ host: '127.0.0.1', port: plain.port, security: 'none', username: 'relay', password: 's3cret' }, msg)
    expect(r.response).toMatch(/^250/)
    const [m] = await plain.waitFor(1)
    expect(m.authUser).toBe('relay')
    expect(m.to).toEqual(['ana@example.com'])
    expect(m.from).toBe('noreply@example.com')
    expect(m.text).toContain('\r\n.starts with a dot')
  })

  it('wrong password: a permanent SmtpError with the code', async () => {
    const e = await sendSmtp({ host: '127.0.0.1', port: plain.port, security: 'none', username: 'relay', password: 'nope' }, msg).catch((x) => x)
    expect(e).toBeInstanceOf(SmtpError)
    expect(e.code).toBe(535)
    expect(e.permanent).toBe(true)
    expect(String(e.message)).not.toContain('nope')
  })

  it('temporary and permanent refusals of DATA', async () => {
    plain.failNext(1, 451)
    const t = await sendSmtp({ host: '127.0.0.1', port: plain.port, security: 'none', username: 'relay', password: 's3cret' }, msg).catch((x) => x)
    expect(t.code).toBe(451)
    expect(t.permanent).toBe(false)
    plain.failNext(1, 550)
    const p = await sendSmtp({ host: '127.0.0.1', port: plain.port, security: 'none', username: 'relay', password: 's3cret' }, msg).catch((x) => x)
    expect(p.permanent).toBe(true)
  })

  it('STARTTLS required but not offered: refused before any credentials are sent', async () => {
    const e = await sendSmtp({ host: '127.0.0.1', port: plain.port, security: 'starttls', username: 'relay', password: 's3cret' }, msg).catch((x) => x)
    expect(e).toBeInstanceOf(SmtpError)
    expect(e.message).toMatch(/STARTTLS/)
  })

  it.skipIf(!cert)('STARTTLS with AUTH LOGIN fallback and a self-signed certificate (verification off)', async () => {
    const before = starttls!.inbox.length
    const r = await sendSmtp({ host: '127.0.0.1', port: starttls!.port, security: 'starttls', username: 'relay', password: 's3cret', verifyCertificate: false }, msg)
    expect(r.response).toMatch(/^250/)
    const all = await starttls!.waitFor(before + 1)
    expect(all.at(-1)!.tls).toBe(true)
  })

  it.skipIf(!cert)('certificate verification on by default: a self-signed certificate is refused', async () => {
    const e = await sendSmtp({ host: '127.0.0.1', port: starttls!.port, security: 'starttls', username: 'relay', password: 's3cret' }, msg).catch((x) => x)
    expect(e).toBeInstanceOf(SmtpError)
    expect(e.message).toMatch(/TLS|certificate/i)
  })

  it.skipIf(!cert)('implicit TLS (port 465 style)', async () => {
    await sendSmtp({ host: '127.0.0.1', port: implicit!.port, security: 'tls', verifyCertificate: false }, msg)
    const [m] = await implicit!.waitFor(1)
    expect(m.tls).toBe(true)
  })

  it('refuses to send a password over plain text to a non-loopback host', async () => {
    const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address
    if (!ip) return
    const wide = await startFakeSmtp({ user: 'relay', password: 's3cret', listen: '0.0.0.0' })
    try {
      const e = await sendSmtp({ host: ip, port: wide.port, security: 'none', username: 'relay', password: 's3cret' }, msg).catch((x) => x)
      expect(e).toBeInstanceOf(SmtpError)
      expect(e.message).toMatch(/unencrypted/)
      expect(wide.inbox).toHaveLength(0)
    } finally {
      await wide.close()
    }
  })

  it('connection refused: a clear error', async () => {
    const e = await sendSmtp({ host: '127.0.0.1', port: 1, security: 'none' }, msg).catch((x) => x)
    expect(e).toBeInstanceOf(SmtpError)
    expect(e.message).toMatch(/Could not connect/)
  })
})
