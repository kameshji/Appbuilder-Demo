import type { PlatformError } from './contracts.ts'

/**
 * The request ids (references) of recent server errors by their message, so an error toast or dialog can show
 * "Reference: <id>" wherever the message ends up (support matches it to the server log). Bounded; newest wins.
 */
const refs = new Map<string, string>()
export function rememberErrorReference(message: string, requestId: string | null | undefined): void {
  if (!message || !requestId) return
  refs.delete(message)
  refs.set(message, requestId)
  if (refs.size > 50) refs.delete(refs.keys().next().value as string)
}
export function errorReference(message: string): string | undefined {
  return refs.get(message)
}
/** the request id of a thrown value (PlatformError.requestId), remembered for its message */
export function referenceOf(e: unknown): string | undefined {
  const id = (e as { requestId?: unknown } | null)?.requestId
  return typeof id === 'string' && id ? id : undefined
}

/** Fixed, user-facing messages for server error codes whose server text is not meant for display. */
export const CODE_MESSAGES: Partial<Record<PlatformError['code'], string>> = {
  rate_limited: 'Too many attempts, wait and try again.',
  method_not_allowed: 'That action is not supported by the server.',
  password_change_required: 'You must change your password before you can continue.',
}

/**
 * Hosting (H-C): a write refused because the install is read-only (503 install_read_only / licence_read_only). These
 * codes have no fixed text above on purpose: the server's message says why (suspended, payment, maintenance, licence,
 * plus the operator's note), and every place that shows a failed save shows that message (errMsg, errorMessage).
 */
export function isReadOnlyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'install_read_only' || code === 'licence_read_only'
}
