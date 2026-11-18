/**
 * AttachmentStore on disk: <folder>/<key[0..1]>/<key>, where <folder> is the attachments folder of the current
 * environment (workspace/env/<id>/attachments). Keys are random hex; client names never reach paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from './contracts.ts'
import type { AttachmentRecord, AttachmentStore } from './contracts.ts'

const KEY_RE = /^[0-9a-f]{32}$/

/** the link of an attachment; it names its environment so an <img src> (no headers) reads from the right one */
export const attachmentUrl = (id: string, environmentId?: string): string =>
  `/api/v1/attachments/${encodeURIComponent(id)}${environmentId ? `?env=${encodeURIComponent(environmentId)}` : ''}`

/** dir: a fixed folder, or the folder of the current environment (called on every use) */
export function createAttachmentStore(dir: string | (() => string), environmentId: () => string | undefined = () => undefined): AttachmentStore {
  const folder = typeof dir === 'string' ? () => dir : dir
  const fileFor = (key: string): string => {
    if (!KEY_RE.test(key)) throw new HttpError(500, 'storage', 'Invalid attachment storage key.')
    return path.join(folder(), key.slice(0, 2), key)
  }
  return {
    async put(bytes) {
      const key = randomBytes(16).toString('hex')
      const file = fileFor(key)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.promises.writeFile(tmp, bytes, { mode: 0o600 })
        await fs.promises.rename(tmp, file)
      } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      return { storageKey: key, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }
    },
    open(storageKey) {
      return fs.createReadStream(fileFor(storageKey))
    },
    async remove(storageKey) {
      await fs.promises.rm(fileFor(storageKey), { force: true })
    },
    toRef(a: AttachmentRecord) {
      return { id: a.id, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes, url: attachmentUrl(a.id, environmentId()) }
    },
  }
}
