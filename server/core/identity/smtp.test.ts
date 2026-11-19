import os from 'node:os'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkTokenUrl, clearOAuthCache, getAccessToken, oauthDefaults, OAuthTokenError } from './oauth-token.ts'
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

describe('OAuth 2.0 (XOAUTH2) for Microsoft 365 / Google Workspace relays', () => {
  let srv: FakeSmtp
  let tokenServer: http.Server
  let tokenUrl = ''
  const seen: URLSearchParams[] = []
  let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' } }
  beforeAll(async () => {
    srv = await startFakeSmtp({ user: 'mailbox@example.com', oauthToken: 'tok-1' })
    tokenServer = http.createServer((req, res) => {
      let b = ''
      req.on('data', (d) => { b += d })
      req.on('end', () => {
        seen.push(new URLSearchParams(b))
        res.writeHead(answer.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((r) => tokenServer.listen(0, '127.0.0.1', () => r()))
    tokenUrl = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/tenant/oauth2/v2.0/token`
  })
  afterAll(async () => {
    await srv?.close()
    await new Promise((r) => tokenServer.close(r))
  })

  it('client credentials: fetches a token (cached), signs in with AUTH XOAUTH2 and delivers', async () => {
    clearOAuthCache()
    const cfg = { provider: 'microsoft' as const, grant: 'client_credentials' as const, tokenUrl, clientId: 'app-1', clientSecret: 'sec-1', scope: 'https://outlook.office365.com/.default' }
    const t = await getAccessToken(cfg)
    expect(t).toBe('tok-1')
    expect(await getAccessToken(cfg)).toBe('tok-1')
    expect(seen.length).toBe(1) // cached
    expect(Object.fromEntries(seen[0])).toEqual({ grant_type: 'client_credentials', client_id: 'app-1', scope: 'https://outlook.office365.com/.default', client_secret: 'sec-1' })
    const r = await sendSmtp({ host: '127.0.0.1', port: srv.port, security: 'none', username: 'mailbox@example.com', accessToken: t }, msg)
    expect(r.response).toMatch(/^250/)
    expect((await srv.waitFor(1))[0].authUser).toBe('mailbox@example.com')
  })
  it('a wrong token: the error challenge is answered and the sign-in fails permanently', async () => {
    await expect(sendSmtp({ host: '127.0.0.1', port: srv.port, security: 'none', username: 'mailbox@example.com', accessToken: 'nope' }, msg)).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/OAuth 2.0 sign-in: 535/) })
  })
  it('a relay without XOAUTH2 is refused before sending anything', async () => {
    const pw = await startFakeSmtp({ user: 'x', password: 'y' })
    try {
      await expect(sendSmtp({ host: '127.0.0.1', port: pw.port, security: 'none', username: 'x', accessToken: 'tok-1' }, msg)).rejects.toThrow(/does not offer OAuth 2.0/)
    } finally { await pw.close() }
  })
  it('refresh token: a rotated refresh token is handed back; refusals carry the provider error, never the secrets', async () => {
    clearOAuthCache()
    answer = { status: 200, body: { access_token: 'tok-2', expires_in: 3600, refresh_token: 'rt-new' } }
    const rotated: string[] = []
    const cfg = { provider: 'google' as const, grant: 'refresh_token' as const, tokenUrl, clientId: 'g-1', clientSecret: 'gsec', refreshToken: 'rt-old', scope: 'https://mail.google.com/' }
    expect(await getAccessToken(cfg, { onRefreshToken: (x) => { rotated.push(x) } })).toBe('tok-2')
    expect(rotated).toEqual(['rt-new'])
    expect(seen[seen.length - 1].get('refresh_token')).toBe('rt-old')
    clearOAuthCache()
    answer = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }
    const err = await getAccessToken(cfg).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthTokenError)
    expect(err.permanent).toBe(true)
    expect(err.message).toMatch(/invalid_grant/)
    expect(err.message).not.toMatch(/gsec|rt-old/)
  })
  it('token addresses: https only (http only to this computer), no user info, outbound policy applies', async () => {
    expect(() => checkTokenUrl('http://login.example.com/token')).toThrow(/https/)
    expect(() => checkTokenUrl('https://u:p@login.example.com/token')).toThrow(/user name/)
    clearOAuthCache()
    await expect(getAccessToken({ provider: 'custom', grant: 'client_credentials', tokenUrl: 'https://metadata.example/token', clientId: 'a', clientSecret: 'b', scope: 's' }, { lookup: async () => [{ address: '169.254.169.254' }] })).rejects.toThrow(/169\.254|not allowed|link-local|blocked/i)
    expect(oauthDefaults('microsoft', 'client_credentials', 'contoso.onmicrosoft.com')).toEqual({ tokenUrl: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token', scope: 'https://outlook.office365.com/.default' })
  })
})
