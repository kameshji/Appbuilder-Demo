import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, hotp, otpauthUri, totp, totpStep, verifyTotp } from './totp.ts'

describe('HOTP (RFC 4226 appendix D)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  it('matches the test values for counters 0-9', () => {
    expected.forEach((v, i) => expect(hotp(secret, i)).toBe(v))
  })
})

describe('TOTP (RFC 6238 appendix B)', () => {
  const sha1 = Buffer.from('12345678901234567890', 'ascii')
  const sha256 = Buffer.from('12345678901234567890123456789012', 'ascii')
  const sha512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii')
  const cases: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  it.each(cases)('T=%i', (t, a, b, c) => {
    expect(totp(sha1, t * 1000, { digits: 8 })).toBe(a)
    expect(totp(sha256, t * 1000, { digits: 8, algorithm: 'sha256' })).toBe(b)
    expect(totp(sha512, t * 1000, { digits: 8, algorithm: 'sha512' })).toBe(c)
  })
})

describe('verifyTotp', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii')
  const now = 1_700_000_000_000
  it('accepts the current step and one either side, returns the step', () => {
    const step = totpStep(now)
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(step)
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(step - 1)
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(step + 1)
  })
  it('refuses codes two steps away, wrong codes and malformed input', () => {
    expect(verifyTotp(secret, totp(secret, now - 60_000), now)).toBeNull()
    expect(verifyTotp(secret, totp(secret, now + 60_000), now)).toBeNull()
    const wrong = String((Number(totp(secret, now)) + 1) % 1_000_000).padStart(6, '0')
    expect(verifyTotp(secret, wrong, now)).toBeNull()
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull()
    expect(verifyTotp(secret, '12345', now)).toBeNull()
    expect(verifyTotp(secret, '', now)).toBeNull()
  })
  it('ignores spaces in the typed code', () => {
    const c = totp(secret, now)
    expect(verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, now)).toBe(totpStep(now))
  })
})

describe('Base32', () => {
  it('round-trips and matches RFC 4648 examples', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Encode(Buffer.from('f'))).toBe('MY')
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar')
    expect(base32Decode('mzxw 6ytb-oi======').toString()).toBe('foobar')
    const b = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13))
    expect(base32Decode(base32Encode(b))).toEqual(b)
    expect(() => base32Decode('M1')).toThrow()
  })
  it('builds an otpauth URI', () => {
    const u = otpauthUri('JBSWY3DPEHPK3PXP', 'ana@example.com', 'Appbuilder')
    expect(u).toBe('otpauth://totp/Appbuilder%3Aana%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Appbuilder&algorithm=SHA1&digits=6&period=30')
  })
})
