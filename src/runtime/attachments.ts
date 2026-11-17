/**
 * Attachment helpers shared by the runtime and the controls (Image, DataTable, List, Form, FileUpload).
 * A 'file' / 'image' cell holds an attachment id (`att_...`) or a JSON array of ids (columns with
 * `multiple`). Files being uploaded live in a module-level registry (token -> File[]) so a Form can
 * upload the original File objects without base64 round-trips.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { platform, type AttachmentRef } from '@/platform'

/* ------------------------------------------------------------------ ids in cells */

export const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]+$/

export function isAttachmentId(s: string): boolean {
  return ATTACHMENT_ID.test(s)
}

/** attachment ids held by a cell value: "att_x", '["att_x","att_y"]', or an array of those */
export function attachmentIds(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' && isAttachmentId(x.trim()) ? [x.trim()] : []))
  if (typeof v !== 'string') return []
  const s = v.trim()
  if (s === '') return []
  if (isAttachmentId(s)) return [s]
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr: unknown = JSON.parse(s)
      if (Array.isArray(arr)) return attachmentIds(arr)
    } catch {
      /* not JSON */
    }
  }
  return []
}

/** the cell text for a list of ids: '' / a bare id / a JSON array, per the column's `multiple` flag */
export function formatAttachmentCell(ids: string[], multiple: boolean): string {
  if (ids.length === 0) return ''
  return multiple ? JSON.stringify(ids) : ids[0]
}

const URL_LIKE = /^([a-z][a-z0-9+.-]*:|\/|\.\/|\.\.\/|#)/i

/** an Image value that is not a URL or path and looks like a bare id (letters, digits, - and _ only) */
function isBareId(s: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(s) && !URL_LIKE.test(s)
}

export function attachmentUrl(id: string): string {
  try {
    return platform.attachments.url(id)
  } catch {
    return ''
  }
}

/**
 * The `src` for an Image control value: attachment ids (`att_`, a JSON array of them, or a bare id
 * that is not a URL) resolve to platform.attachments.url(id); everything else is used as written.
 */
export function imageSource(value: string): string {
  const s = value.trim()
  if (s === '') return ''
  const ids = attachmentIds(s)
  if (ids.length > 0) return attachmentUrl(ids[0]) || s
  if (isBareId(s)) return attachmentUrl(s) || s
  return s
}

export function isImageMime(mime: string | undefined): boolean {
  return !!mime && mime.toLowerCase().startsWith('image/')
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
export function looksLikeImage(ref: Pick<AttachmentRef, 'mime' | 'fileName'> | undefined | null): boolean {
  if (!ref) return false
  return isImageMime(ref.mime) || IMAGE_EXT.test(ref.fileName)
}

export function formatBytes(n: number): string {
  if (!(n >= 0)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------------ ref cache (resolve ids -> metadata) */

const refCache = new Map<string, AttachmentRef | null>()
const inflight = new Set<string>()
const refListeners = new Set<() => void>()
let refVersion = 0

function bump() {
  refVersion++
  refListeners.forEach((fn) => fn())
}

function requestRefs(ids: string[]) {
  const need = ids.filter((id) => !refCache.has(id) && !inflight.has(id))
  if (need.length === 0) return
  need.forEach((id) => inflight.add(id))
  void Promise.resolve()
    .then(() => platform.attachments.resolve(need))
    .then(
      (refs) => {
        const got = new Map(refs.map((r) => [r.id, r] as const))
        for (const id of need) refCache.set(id, got.get(id) ?? null)
      },
      () => {
        for (const id of need) refCache.set(id, null)
      },
    )
    .finally(() => {
      need.forEach((id) => inflight.delete(id))
      bump()
    })
}

/** metadata for attachment ids: undefined while loading, null when unknown or forbidden */
export function useAttachmentRefs(ids: string[]): Record<string, AttachmentRef | null | undefined> {
  const key = ids.join(',')
  useEffect(() => {
    requestRefs(ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useSyncExternalStore(
    (fn) => {
      refListeners.add(fn)
      return () => refListeners.delete(fn)
    },
    () => refVersion,
    () => refVersion,
  )
  const out: Record<string, AttachmentRef | null | undefined> = {}
  for (const id of ids) out[id] = refCache.get(id)
  return out
}

/** forget cached metadata (tests, after a removed attachment) */
export function clearAttachmentCache() {
  refCache.clear()
  inflight.clear()
  bump()
}

/* ------------------------------------------------------------------ pending files registry */

const registry = new Map<string, File[]>()
const MAX_TOKENS = 200
let tokenSeq = 0

/** keep these files in memory under a new token; pass the previous token to release it */
export function registerFiles(files: File[], previous?: string): string {
  if (previous) registry.delete(previous)
  if (files.length === 0) return ''
  const token = `files_${Date.now().toString(36)}_${(++tokenSeq).toString(36)}`
  registry.set(token, files.slice())
  while (registry.size > MAX_TOKENS) {
    const oldest = registry.keys().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
  return token
}

export function filesForToken(token: string | null | undefined): File[] {
  if (!token) return []
  return registry.get(token)?.slice() ?? []
}

export function releaseFiles(token: string | null | undefined) {
  if (token) registry.delete(token)
}

/** column -> files, from a Form's hidden `__files` output ({ column: token }) */
export function pendingFilesOf(v: unknown): Array<{ column: string; files: File[] }> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return []
  const out: Array<{ column: string; files: File[] }> = []
  for (const [column, token] of Object.entries(v as Record<string, unknown>)) {
    if (column.startsWith('__') || typeof token !== 'string') continue
    const files = filesForToken(token)
    if (files.length) out.push({ column, files })
  }
  return out
}

/* ------------------------------------------------------------------ client-side checks for pickers */

/** does `file` match an accept list of MIME patterns / extensions (["image/*", ".pdf"])? empty = any */
export function acceptsFile(file: Pick<File, 'name' | 'type'>, accept: string[] | undefined): boolean {
  const list = (accept ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  return list.some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a))
}

export function fileProblem(file: File, opts: { accept?: string[]; maxSizeMB?: number }): string | null {
  if (!acceptsFile(file, opts.accept)) return `${file.name}: this file type is not allowed`
  const max = opts.maxSizeMB && opts.maxSizeMB > 0 ? opts.maxSizeMB : 25
  if (file.size > max * 1024 * 1024) return `${file.name}: larger than ${max} MB`
  return null
}
