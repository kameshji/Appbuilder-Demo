/**
 * Zip bomb guard (P0 package M): before a ZIP container (an .xlsx workbook) is unpacked in memory, its central
 * directory is read and the declared sizes checked. A workbook whose members add up to more than `maxTotal` bytes, or
 * that is compressed more than `maxRatio` times overall, or that has too many members, is refused. ZIP64 entries (sizes
 * that do not fit 32 bits) are refused outright: no real upload here needs them.
 *
 * Declared sizes can lie; the libraries that unpack the members stop at the declared size or fail on a mismatch, so the
 * check bounds what they allocate. A lie that a library does not catch is a residual risk (docs/internal/security-review-p0.md).
 */
import { HttpError } from './contracts.ts'

export interface ZipLimits { maxTotal: number; maxRatio: number; maxEntries: number }
export const XLSX_LIMITS: ZipLimits = { maxTotal: 256 * 1024 * 1024, maxRatio: 200, maxEntries: 10_000 }

export function checkZip(buf: Buffer, what: string, limits: ZipLimits = XLSX_LIMITS): { entries: number; total: number } {
  const bad = (m: string): never => { throw new HttpError(422, 'invalid', `${what}: ${m}`) }
  // end of central directory: the last 22 bytes, or up to 64 KiB of comment before them
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) bad('this is not a ZIP-based file.')
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) bad('ZIP64 files are not supported.')
  if (entries > limits.maxEntries) bad(`it has ${entries} parts (at most ${limits.maxEntries}).`)
  if (cdOffset + cdSize > buf.length) bad('the file is damaged (its directory points past the end).')
  let p = cdOffset
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) bad('the file is damaged (bad directory entry).')
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    if (csize === 0xffffffff || usize === 0xffffffff) bad('ZIP64 files are not supported.')
    total += usize
    if (total > limits.maxTotal) bad(`it unpacks to more than ${Math.round(limits.maxTotal / 1024 / 1024)} MB.`)
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  if (total > Math.max(1024 * 1024, buf.length * limits.maxRatio)) bad(`it is compressed more than ${limits.maxRatio} times; that is not a normal workbook.`)
  return { entries, total }
}
