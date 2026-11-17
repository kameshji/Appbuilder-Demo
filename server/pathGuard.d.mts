export function pathProblem(rel: unknown, opts?: { allowEmpty?: boolean }): string | null
export class PathError extends Error {
  code: 'bad-path'
}
export function resolveSafe(root: string, rel: string, opts?: { allowEmpty?: boolean }): string
export function isSafeRelPath(rel: unknown, opts?: { allowEmpty?: boolean }): boolean
