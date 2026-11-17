import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_BODY_BYTES: number
export function defaultWorkspaceRoot(): string
export function createFsHandler(options?: {
  root?: string
  maxBodyBytes?: number
  allowAnyHost?: boolean
}): {
  root: string
  /** resolves true when the request was an /api/fs/* request and has been answered */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}
