/** H-B follow-up: a save refused by a read-only install says why (the server's message), never a generic text. */
import { describe, expect, it } from 'vitest'
import { PlatformError, READ_ONLY_ERROR_CODES } from './contracts.ts'
import { CODE_MESSAGES, isReadOnlyError } from './errorMessages.ts'
import { errorMessage } from '../runtime/data.ts'

describe('read-only error codes (install_read_only, licence_read_only)', () => {
  it('are platform error codes, recognised, and shown with the server message', () => {
    for (const code of READ_ONLY_ERROR_CODES) {
      const msg = code === 'licence_read_only' ? 'The licence could not be verified for more than 3 days: changes are paused.' : 'This install is read-only (suspended): Call the office.'
      const e = new PlatformError(code, msg)
      expect(isReadOnlyError(e)).toBe(true)
      expect(CODE_MESSAGES[code]).toBeUndefined()
      expect(errorMessage(e)).toBe(msg)
    }
    expect(isReadOnlyError(new PlatformError('unavailable', 'x'))).toBe(false)
    expect(isReadOnlyError(null)).toBe(false)
  })
})
