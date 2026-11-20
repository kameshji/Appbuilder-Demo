/**
 * The backup archive container (docs/dev/backup.md "Archive format").
 *
 * An archive is one POSIX tar file (ustar headers, pax records for long names and sizes over 8 GB), written and read
 * with Node built-ins only. Optionally the whole tar is wrapped in a chunked AES-256-GCM container:
 *
 *   header (64 bytes): "ABBAKENC" | version 1 | log2(N) | r | p | chunk size (u32 BE) | salt (16) | nonce prefix (7) | 0...
 *   chunks: AES-256-GCM(plaintext chunk) || tag (16), the last one possibly shorter (also 0 bytes)
 *   key = scrypt(passphrase, salt, 32, N, r, p); nonce of chunk i = prefix (7) || i (u32 BE) || last ? 1 : 0
 *   additional data of every chunk = the 64 header bytes
 *
 * Every chunk is authenticated on its own (a wrong passphrase or a changed byte fails on the first chunk read), the
 * last-chunk flag stops truncation and reordering, and any byte range can be read without decrypting the rest
 * (listing members, browsing one table). Memory stays bounded: writers and readers move at most one chunk (64 KB)
 * plus one read buffer (1 MB) at a time.
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto'

export const ENC_MAGIC = Buffer.from('ABBAKENC', 'ascii')
export const ENC_HEADER = 64
export const ENC_TAG = 16
export const DEFAULT_CHUNK = 64 * 1024
export const KDF = { log2N: 15, r: 8, p: 1 }
/** the first member of every archive: identifies the format before the manifest (the last member) is read */
export const MARKER_NAME = 'appbuilder-backup.json'
export const MANIFEST_NAME = 'manifest.json'

export class ArchiveError extends Error {
  /** wrong passphrase, tampered or truncated data, not an archive */
  kind: 'passphrase' | 'corrupt' | 'format' | 'needs-passphrase'
  constructor(kind: ArchiveError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

function scrypt(pass: string, salt: Buffer, o: { log2N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { N: 2 ** o.log2N, r: o.r, p: o.p, maxmem: 256 * 1024 * 1024 }
  return new Promise((resolve, reject) => scryptCb(pass.normalize('NFC'), salt, 32, opts, (e, k) => (e ? reject(e) : resolve(k))))
}

function nonceFor(prefix: Buffer, index: number, last: boolean): Buffer {
  const n = Buffer.alloc(12)
  prefix.copy(n, 0, 0, 7)
  n.writeUInt32BE(index >>> 0, 7)
  n[11] = last ? 1 : 0
  return n
}

/* ------------------------------------------------------------------ byte sinks (the output file) */

/** where archive bytes go: a file, optionally through the encryption container; counts bytes and hashes the file */
export interface ByteSink {
  write(buf: Buffer): Promise<void>
  /** flushes, closes the file; size and sha256 of the file on disk */
  close(): Promise<{ bytes: number; sha256: string }>
  abort(): Promise<void>
}

class FileWriter {
  private ws: fs.WriteStream
  private error: Error | null = null
  bytes = 0
  private hash = createHash('sha256')
  constructor(file: string) {
    this.ws = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })
    this.ws.on('error', (e) => { this.error = e })
  }
  async write(buf: Buffer): Promise<void> {
    if (this.error) throw this.error
    if (!buf.length) return
    this.hash.update(buf)
    this.bytes += buf.length
    if (!this.ws.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { this.ws.off('error', fail); resolve() }
        const fail = (e: Error) => { this.ws.off('drain', done); reject(e) }
        this.ws.once('drain', done)
        this.ws.once('error', fail)
      })
    }
  }
  async close(): Promise<{ bytes: number; sha256: string }> {
    if (this.error) throw this.error
    await new Promise<void>((resolve, reject) => {
      this.ws.end((e?: Error | null) => (e ? reject(e) : resolve()))
    })
    // the data is on disk before the archive is renamed into place
    const fd = await fs.promises.open(this.ws.path as string, 'r+')
    try { await fd.sync() } finally { await fd.close() }
    return { bytes: this.bytes, sha256: this.hash.digest('hex') }
  }
  async abort(): Promise<void> {
    await new Promise<void>((r) => { this.ws.destroy(); this.ws.once('close', () => r()); setTimeout(r, 200) })
  }
}

export function plainFileSink(file: string): ByteSink {
  const w = new FileWriter(file)
  return { write: (b) => w.write(b), close: () => w.close(), abort: () => w.abort() }
}

/** the encryption container around a file; the key is derived here (scrypt) */
export async function encryptedFileSink(file: string, passphrase: string, o: { chunkSize?: number; kdf?: typeof KDF } = {}): Promise<ByteSink> {
  const chunkSize = o.chunkSize ?? DEFAULT_CHUNK
  const kdf = o.kdf ?? KDF
  const salt = randomBytes(16)
  const prefix = randomBytes(7)
  const header = Buffer.alloc(ENC_HEADER)
  ENC_MAGIC.copy(header, 0)
  header[8] = 1
  header[9] = kdf.log2N
  header[10] = kdf.r
  header[11] = kdf.p
  header.writeUInt32BE(chunkSize, 12)
  salt.copy(header, 16)
  prefix.copy(header, 32)
  const key = await scrypt(passphrase, salt, kdf)
  const w = new FileWriter(file)
  await w.write(header)
  let pending: Buffer[] = []
  let pendingLen = 0
  let index = 0
  const seal = async (plain: Buffer, last: boolean): Promise<void> => {
    const c = createCipheriv('aes-256-gcm', key, nonceFor(prefix, index++, last))
    c.setAAD(header)
    const ct = Buffer.concat([c.update(plain), c.final()])
    await w.write(Buffer.concat([ct, c.getAuthTag()]))
  }
  return {
    async write(buf) {
      if (!buf.length) return
      pending.push(buf)
      pendingLen += buf.length
      // keep up to one full chunk back: the last chunk must carry the "last" flag, so it is sealed only at close
      if (pendingLen <= chunkSize) return
      const all = pending.length === 1 ? pending[0] : Buffer.concat(pending)
      let off = 0
      while (all.length - off > chunkSize) {
        await seal(all.subarray(off, off + chunkSize), false)
        off += chunkSize
      }
      const rest = Buffer.from(all.subarray(off))
      pending = [rest]
      pendingLen = rest.length
    },
    async close() {
      await seal(Buffer.concat(pending), true)
      pending = []
      key.fill(0)
      return w.close()
    },
    async abort() {
      key.fill(0)
      await w.abort()
    },
  }
}

/* ------------------------------------------------------------------ random-access readers (the input file) */

export interface RandomReader {
  /** plaintext size */
  readonly size: number
  readonly encrypted: boolean
  read(pos: number, len: number): Promise<Buffer>
  close(): Promise<void>
}

async function readFully(fd: fs.promises.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  let off = 0
  while (off < len) {
    const { bytesRead } = await fd.read(buf, off, len - off, pos + off)
    if (!bytesRead) break
    off += bytesRead
  }
  return off === len ? buf : buf.subarray(0, off)
}

/** how a file is opened for reading: injectable so a test can count the handles that are still open */
export type OpenFile = (file: string, flags: 'r') => Promise<fs.promises.FileHandle>

/** is this file in the encryption container? (reads 8 bytes) */
export async function isEncryptedFile(file: string): Promise<boolean> {
  const fd = await fs.promises.open(file, 'r')
  try {
    const b = await readFully(fd, 0, 8)
    return b.length === 8 && b.equals(ENC_MAGIC)
  } finally {
    await fd.close()
  }
}

/**
 * Opens an archive file for random access. Encrypted archives need the passphrase (ArchiveError 'needs-passphrase'
 * without one, 'passphrase' when it is wrong); the first chunk is checked at once.
 */
export async function openReader(file: string, passphrase?: string | null, o: { open?: OpenFile } = {}): Promise<RandomReader> {
  const fd = await (o.open ?? fs.promises.open)(file, 'r')
  try {
    const st = await fd.stat()
    const head = await readFully(fd, 0, Math.min(ENC_HEADER, st.size))
    if (head.length < 8 || !head.subarray(0, 8).equals(ENC_MAGIC)) {
      return {
        size: st.size,
        encrypted: false,
        read: (pos, len) => readFully(fd, pos, Math.max(0, Math.min(len, st.size - pos))),
        close: () => fd.close(),
      }
    }
    if (head.length < ENC_HEADER || head[8] !== 1) throw new ArchiveError('format', 'This backup was encrypted by a newer Appbuilder or is damaged (unknown container version).')
    if (!passphrase) throw new ArchiveError('needs-passphrase', 'This backup is encrypted: enter its passphrase.')
    const kdf = { log2N: head[9], r: head[10], p: head[11] }
    if (kdf.log2N < 10 || kdf.log2N > 22 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 16) throw new ArchiveError('format', 'The encryption header of this backup is damaged.')
    const chunkSize = head.readUInt32BE(12)
    if (chunkSize < 1024 || chunkSize > 16 * 1024 * 1024) throw new ArchiveError('format', 'The encryption header of this backup is damaged.')
    const salt = head.subarray(16, 32)
    const prefix = Buffer.from(head.subarray(32, 39))
    const header = Buffer.from(head)
    const key = await scrypt(passphrase, salt, kdf)
    const body = st.size - ENC_HEADER
    const stride = chunkSize + ENC_TAG
    const chunks = Math.max(1, Math.ceil(body / stride))
    const lastCipher = body - (chunks - 1) * stride
    if (lastCipher < ENC_TAG) throw new ArchiveError('corrupt', 'The backup file is truncated (the last encrypted block is incomplete).')
    const size = (chunks - 1) * chunkSize + (lastCipher - ENC_TAG)
    let cache: { index: number; plain: Buffer } | null = null
    const chunk = async (i: number): Promise<Buffer> => {
      if (cache?.index === i) return cache.plain
      const last = i === chunks - 1
      const raw = await readFully(fd, ENC_HEADER + i * stride, last ? lastCipher : stride)
      if (raw.length < ENC_TAG) throw new ArchiveError('corrupt', 'The backup file is truncated.')
      const d = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, i, last))
      d.setAAD(header)
      d.setAuthTag(raw.subarray(raw.length - ENC_TAG))
      let plain: Buffer
      try {
        plain = Buffer.concat([d.update(raw.subarray(0, raw.length - ENC_TAG)), d.final()])
      } catch {
        throw i === 0
          ? new ArchiveError('passphrase', 'The passphrase is wrong, or the backup file was changed.')
          : new ArchiveError('corrupt', `The backup file was changed or damaged (encrypted block ${i + 1} of ${chunks} does not authenticate).`)
      }
      cache = { index: i, plain }
      return plain
    }
    await chunk(0)
    return {
      size,
      encrypted: true,
      async read(pos, len) {
        len = Math.max(0, Math.min(len, size - pos))
        const out: Buffer[] = []
        let p = pos
        while (p < pos + len) {
          const i = Math.floor(p / chunkSize)
          const c = await chunk(i)
          const from = p - i * chunkSize
          const take = Math.min(c.length - from, pos + len - p)
          out.push(c.subarray(from, from + take))
          p += take
          if (take <= 0) break
        }
        return Buffer.concat(out)
      },
      async close() {
        key.fill(0)
        await fd.close()
      },
    }
  } catch (e) {
    await fd.close().catch(() => {})
    throw e
  }
}

/* ------------------------------------------------------------------ tar */

const BLOCK = 512
const ZERO = Buffer.alloc(BLOCK)

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return Buffer.from(`${len}${body}`, 'utf8')
}

function header(name: string, size: number, type: '0' | 'x', mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, 100, 'utf8')
  h.write(octal(0o644, 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(Math.min(size, 0o77777777777), 12), 124, 'ascii')
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(type, 156, 'ascii')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  h.write('appbuilder', 265, 'ascii')
  h.write('appbuilder', 297, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(octal(sum, 7) + ' ', 148, 'ascii')
  return h
}

export interface MemberInfo { name: string; size: number; sha256: string }

/**
 * Writes tar members to a sink, one after another (each member's size must be known before its bytes). Every member
 * is hashed (sha256) as it is written: the manifest lists them.
 */
export class TarWriter {
  private sink: ByteSink
  readonly members: MemberInfo[] = []
  constructor(sink: ByteSink) {
    this.sink = sink
  }

  private async head(name: string, size: number): Promise<void> {
    const mtime = Date.now()
    const ascii = /^[\x20-\x7e]*$/.test(name)
    const fits = ascii && Buffer.byteLength(name) <= 100 && size <= 0o77777777777
    if (!fits) {
      const pax = Buffer.concat([paxRecord('path', name), ...(size > 0o77777777777 ? [paxRecord('size', String(size))] : [])])
      await this.sink.write(header('PaxHeader', pax.length, 'x', mtime))
      await this.sink.write(pax)
      await this.pad(pax.length)
    }
    await this.sink.write(header(ascii ? name.slice(0, 100) : 'member', size, '0', mtime))
  }

  private async pad(size: number): Promise<void> {
    const rest = size % BLOCK
    if (rest) await this.sink.write(ZERO.subarray(0, BLOCK - rest))
  }

  async addBuffer(name: string, data: Buffer): Promise<MemberInfo> {
    await this.head(name, data.length)
    await this.sink.write(data)
    await this.pad(data.length)
    const m = { name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    this.members.push(m)
    return m
  }

  /** a member of exactly `size` bytes from a stream (a source that is shorter or longer is an error) */
  async addStream(name: string, size: number, src: AsyncIterable<Buffer | string>, onBytes?: (n: number) => void): Promise<MemberInfo> {
    await this.head(name, size)
    const hash = createHash('sha256')
    let n = 0
    for await (const c of src) {
      const b = typeof c === 'string' ? Buffer.from(c) : c
      if (n + b.length > size) throw new Error(`${name} grew while it was being backed up`)
      hash.update(b)
      await this.sink.write(b)
      n += b.length
      onBytes?.(b.length)
    }
    if (n !== size) throw new Error(`${name} changed size while it was being backed up (${n} of ${size} bytes)`)
    await this.pad(size)
    const m = { name, size, sha256: hash.digest('hex') }
    this.members.push(m)
    return m
  }

  /** a file on disk (its size is taken now: files that change while being read are an error) */
  async addFile(name: string, file: string, onBytes?: (n: number) => void): Promise<MemberInfo> {
    const st = await fs.promises.stat(file)
    return this.addStream(name, st.size, fs.createReadStream(file, { highWaterMark: 1024 * 1024 }), onBytes)
  }

  async finish(): Promise<{ bytes: number; sha256: string }> {
    await this.sink.write(ZERO)
    await this.sink.write(ZERO)
    return this.sink.close()
  }
}

export interface TarEntry { name: string; size: number; offset: number }

function parseOctal(b: Buffer): number {
  const s = b.toString('ascii').replace(/\0.*$/s, '').trim()
  return s ? parseInt(s, 8) : 0
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i)
    if (sp < 0) break
    const len = Number(buf.subarray(i, sp).toString('ascii'))
    if (!Number.isFinite(len) || len <= 0) break
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

/** lists the members of a tar through a random reader (reads headers only) */
export async function listTar(r: RandomReader): Promise<TarEntry[]> {
  const out: TarEntry[] = []
  let pos = 0
  let pax: Record<string, string> = {}
  while (pos + BLOCK <= r.size) {
    const h = await r.read(pos, BLOCK)
    if (h.length < BLOCK) throw new ArchiveError('corrupt', 'The backup file is truncated (a member header is incomplete).')
    if (h.equals(ZERO)) return out
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
    if (sum !== parseOctal(h.subarray(148, 156))) throw new ArchiveError('corrupt', `The backup file is damaged (bad member header at byte ${pos}).`)
    const type = String.fromCharCode(h[156] || 48)
    let size = parseOctal(h.subarray(124, 136))
    const data = pos + BLOCK
    if (type === 'x') {
      // a pax record holds a name and a size: anything bigger is a crafted archive, not one of ours
      if (size > 64 * 1024) throw new ArchiveError('corrupt', `The backup file is damaged (an oversized extended header at byte ${pos}).`)
      pax = parsePax(await r.read(data, size))
      pos = data + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    if (prefix) name = `${prefix}/${name}`
    if (pax.path) name = pax.path
    if (pax.size) size = Number(pax.size)
    pax = {}
    if (type === '0' || type === '\0') out.push({ name, size, offset: data })
    pos = data + Math.ceil(size / BLOCK) * BLOCK
    if (pos > r.size) throw new ArchiveError('corrupt', `The backup file is truncated (member ${name} is incomplete).`)
  }
  throw new ArchiveError('corrupt', 'The backup file is truncated (no end-of-archive marker).')
}

/** a member's bytes as a stream (1 MB reads) */
export function memberStream(r: RandomReader, e: TarEntry, step = 1024 * 1024): Readable {
  let pos = e.offset
  const end = e.offset + e.size
  return new Readable({
    highWaterMark: step,
    read() {
      if (pos >= end) {
        this.push(null)
        return
      }
      const len = Math.min(step, end - pos)
      r.read(pos, len).then((b) => {
        if (b.length !== len) throw new ArchiveError('corrupt', `The backup file is truncated in ${e.name}.`)
        pos += len
        this.push(b)
      }, (err) => this.destroy(err))
    },
  })
}

/** members read whole into memory (marker, manifest, catalogs) are small; a crafted archive must not exhaust memory */
export const MAX_BUFFERED_MEMBER = 256 * 1024 * 1024

export async function memberBuffer(r: RandomReader, e: TarEntry, max = MAX_BUFFERED_MEMBER): Promise<Buffer> {
  if (e.size > max) throw new ArchiveError('corrupt', `The backup file is damaged (${e.name} is ${e.size} bytes, more than a member of this kind can be).`)
  return r.read(e.offset, e.size)
}

export async function sha256OfStream(src: AsyncIterable<Buffer>, onBytes?: (n: number) => void): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256')
  let bytes = 0
  for await (const c of src) {
    h.update(c)
    bytes += c.length
    onBytes?.(c.length)
  }
  return { sha256: h.digest('hex'), bytes }
}

export async function sha256OfFile(file: string): Promise<{ sha256: string; bytes: number }> {
  return sha256OfStream(fs.createReadStream(file, { highWaterMark: 1024 * 1024 }))
}
