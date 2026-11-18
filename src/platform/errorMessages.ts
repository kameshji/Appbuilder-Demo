import type { PlatformError } from './contracts'

/** Fixed, user-facing messages for server error codes whose server text is not meant for display. */
export const CODE_MESSAGES: Partial<Record<PlatformError['code'], string>> = {
  rate_limited: 'Too many attempts, wait and try again.',
  method_not_allowed: 'That action is not supported by the server.',
  password_change_required: 'You must change your password before you can continue.',
}
