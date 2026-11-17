// Path guard for the workspace file API. Plain ESM, dependency free, shared by the standalone
// server, the Vite dev middleware and the unit tests.
import path from 'node:path'
import fs from 'node:fs'

/**
 * Checks a client-supplied, workspace-relative path (forward slashes) and returns the reason it is
 * unsafe, or null when it is acceptable. An empty string is only acceptable when `allowEmpty`
 * (the workspace root itself, for directory listings).
 */
export function pathProblem(rel, { allowEmpty = false } = {}) {
  if (typeof rel !== 'string') return 'path must be a string'
  if (rel.length === 0) return allowEmpty ? null : 'path is empty'
  if (rel.length > 400) return 'path is too long'
  if (rel.includes('\0')) return 'path contains a NUL byte'
  if (rel.includes('\\')) return 'path contains a backslash'
  if (rel.startsWith('/')) return 'path is absolute'
  if (/^[a-zA-Z]:/.test(rel)) return 'path is absolute (drive letter)'
  const segments = rel.split('/')
  for (const seg of segments) {
    if (seg === '..') return 'path contains a ".." segment'
    if (seg === '.' || seg === '') return 'path contains an empty or "." segment'
  }
  return null
}

/** Throws PathError (code 'bad-path') when unsafe; otherwise returns the absolute path inside root. */
export class PathError extends Error {
  constructor(message) {
    super(message)
    this.code = 'bad-path'
  }
}

/**
 * Resolves `rel` against `root` and guarantees the result is inside root, also after following
 * symlinks of the deepest existing ancestor. Returns the absolute path.
 */
export function resolveSafe(root, rel, opts = {}) {
  const problem = pathProblem(rel, opts)
  if (problem) throw new PathError(problem)
  const absRoot = path.resolve(root)
  const abs = rel === '' ? absRoot : path.resolve(absRoot, ...rel.split('/'))
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) throw new PathError('path escapes the workspace')
  // Symlink check: the real path of the deepest existing ancestor must still be inside the real root.
  let realRoot
  try {
    realRoot = fs.realpathSync(absRoot)
  } catch {
    return abs // root does not exist yet: nothing can be symlinked inside it
  }
  let probe = abs
  while (true) {
    try {
      const real = fs.realpathSync(probe)
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new PathError('path escapes the workspace (symlink)')
      break
    } catch (e) {
      if (e instanceof PathError) throw e
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return abs
}

/** true when `rel` is acceptable (no filesystem access). */
export function isSafeRelPath(rel, opts) {
  return pathProblem(rel, opts) === null
}
