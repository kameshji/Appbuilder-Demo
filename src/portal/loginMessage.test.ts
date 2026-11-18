import { describe, expect, it } from 'vitest'
import { PlatformError } from '@/platform'
import { CODE_MESSAGES } from '@/platform/errorMessages'
import { loginMessage } from './Auth'

describe('loginMessage', () => {
  it('uses the rate_limited code (not the message text) for throttled sign-ins', () => {
    expect(loginMessage(new PlatformError('rate_limited', 'Too many attempts for this account. Try again in 4 second(s).'))).toBe(CODE_MESSAGES.rate_limited)
    expect(loginMessage(new PlatformError('unauthenticated', 'Invalid email or password.'))).toMatch(/do not match/)
    // a message that merely mentions "too many" is not a throttle
    expect(loginMessage(new PlatformError('invalid', 'Too many columns.'))).toMatch(/do not match/)
  })
})
