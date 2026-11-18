/**
 * A small, dependency-free ZIP writer and reader for release packages and diagnostics bundles (package L).
 *
 * Writer: deterministic output (entries in the order given, fixed timestamp, no extra fields, deflate level 9), so the same
 * files give the same bytes. Reader: our own archives and ordinary ZIPs from other tools (stored or deflated entries,
 * no ZIP64, no encryption). extractZip refuses absolute paths, "..", drive letters and symbolic links, and checks every
 * entry's CRC-32 and size.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export interface ZipEntryInput {
  /** forward slashes, relative ("app/server/main.ts") */
  name: string
  data: Buffer
  /** unix mode bits to record (e.g. 0o755 for scripts); default 0o644 */
  mode?: number
}

export interface ZipEntry {
  name: string
  data: Buffer
  mode: number
}

/** the fixed timestamp written into every entry: 1 January 2000, 00:00 (DOS time cannot hold 1970) */
const DOS_TIME = 0
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1

export const crc32 = (b: Buffer): number => zlib.crc32(b) >>> 0

export function safeEntryName(name: string): string | null {
  const n = name.replace(/\\/g, '/')
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\0')) return null
  const parts = n.split('/')
  if (parts.some((p) => p === '..' || p === '.')) return null
  return n
}

export function writeZip(entries: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const seen = new Set<string>()
  for (const e of entries) {
    const name = safeEntryName(e.name)
    if (!name || name.endsWith('/')) throw new Error(`Invalid ZIP entry name: ${e.name}`)
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`)
    seen.add(name)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(e.data)
    const deflated = zlib.deflateRawSync(e.data, { level: 9 })
    const useDeflate = deflated.length < e.data.length
    const body = useDeflate ? deflated : e.data
    const method = useDeflate ? 8 : 0
    if (body.length >= 0xffffffff || e.data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('ZIP64 is not supported (file too large).')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, body)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE((3 << 8) | 20, 4) // made by: unix, so the mode bits are honoured by unzip
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(DOS_TIME, 12)
    cen.writeUInt16LE(DOS_DATE, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30) // extra
    cen.writeUInt16LE(0, 32) // comment
    cen.writeUInt16LE(0, 34) // disk
    cen.writeUInt16LE(0, 36) // internal attrs
    cen.writeUInt32LE((((e.mode ?? 0o644) & 0o7777) | 0o100000) * 0x10000 >>> 0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, cenBuf, end])
}

export class ZipError extends Error {}

/** reads every file entry (directories are skipped); checks CRC-32 and sizes */
export function readZip(buf: Buffer, limits: { maxEntries?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 100_000
  const maxTotal = limits.maxTotalBytes ?? 4 * 1024 * 1024 * 1024
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file (no end of central directory).')
  const count = buf.readUInt16LE(eocd + 10)
  const cenSize = buf.readUInt32LE(eocd + 12)
  let p = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || p === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.')
  if (count > maxEntries) throw new ZipError(`Too many entries in the ZIP file (${count}).`)
  if (p + cenSize > buf.length) throw new ZipError('The ZIP file is truncated.')
  const out: ZipEntry[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Damaged ZIP central directory.')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const madeBy = buf.readUInt16LE(p + 4) >> 8
    const ext = buf.readUInt32LE(p + 38)
    const lho = buf.readUInt32LE(p + 42)
    const rawName = buf.subarray(p + 46, p + 46 + nlen)
    const name = (flags & 0x0800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/')
    p += 46 + nlen + xlen + clen
    if (name.endsWith('/')) continue
    const unixMode = madeBy === 3 ? (ext >>> 16) & 0xffff : 0
    if ((unixMode & 0o170000) === 0o120000) throw new ZipError(`The ZIP file contains a symbolic link (${name}); refused.`)
    if (flags & 0x1) throw new ZipError(`Encrypted ZIP entries are not supported (${name}).`)
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError(`Damaged ZIP entry ${name}.`)
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    total += usize
    if (total > maxTotal) throw new ZipError('The ZIP file unpacks to more than the allowed size.')
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) })
    else throw new ZipError(`Unsupported compression method ${method} (${name}).`)
    if (data.length !== usize || crc32(data) !== crc) throw new ZipError(`The ZIP entry ${name} is damaged (checksum mismatch).`)
    out.push({ name, data, mode: unixMode & 0o7777 })
  }
  return out
}

/** unpacks into dir (created; must be empty or missing); returns the relative file names */
export function extractZip(buf: Buffer, dir: string): string[] {
  const entries = readZip(buf)
  fs.mkdirSync(dir, { recursive: true })
  const root = path.resolve(dir)
  const names: string[] = []
  for (const e of entries) {
    const safe = safeEntryName(e.name)
    if (!safe) throw new ZipError(`Unsafe path in the ZIP file: ${e.name}`)
    const target = path.resolve(root, ...safe.split('/'))
    if (target !== root && !target.startsWith(root + path.sep)) throw new ZipError(`Unsafe path in the ZIP file: ${e.name}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, e.data, { mode: e.mode & 0o111 ? 0o755 : 0o644 })
    names.push(safe)
  }
  return names
}
