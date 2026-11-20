/**
 * Encryption at rest for the offline store (P2-A, docs/dev/phone.md "Offline store"): AES-256-GCM (WebCrypto) with a
 * random 96-bit IV per record. The key is the server-issued offline key (POST /api/v1/offline/key), imported as a
 * non-extractable CryptoKey and held in memory; its text is kept in sessionStorage only (keyring.ts).
 *
 * JSON values keep Dates ({"$d": ISO}) so queued formula values round-trip. Binary (photos waiting to upload) is sealed
 * separately as bytes.
 */
export interface Sealed {
  iv: Uint8Array
  data: ArrayBuffer
}

export interface Codec {
  seal(value: unknown): Promise<Sealed>
  open<T = unknown>(s: Sealed): Promise<T>
  sealBytes(bytes: ArrayBuffer): Promise<Sealed>
  openBytes(s: Sealed): Promise<ArrayBuffer>
  /**
   * a keyed name for a record key that would otherwise be stored in clear (P2 security re-check: the read cache was keyed
   * by the request text, which holds search words and filter values): HMAC-SHA-256 under a subkey of the offline key
   */
  name(text: string): Promise<string>
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) throw new Error('This browser cannot encrypt data (WebCrypto needs HTTPS or localhost).')
  return c.subtle
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, k, v) {
    const raw = this[k]
    return raw instanceof Date ? { $d: raw.toISOString() } : v
  })
}

export function decodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $d?: unknown }).$d === 'string' ? new Date((v as { $d: string }).$d) : v)) as T
}

function randomIv(): Uint8Array {
  const iv = new Uint8Array(12)
  ;(globalThis as { crypto: Crypto }).crypto.getRandomValues(iv)
  return iv
}

/** a Codec for a raw 32-byte key (base64url from the server) */
export async function codecFor(keyB64Url: string): Promise<Codec> {
  const raw = fromBase64Url(keyB64Url)
  if (raw.length !== 32) throw new Error('The offline key must be 32 bytes.')
  const key = await subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  // a separate subkey for names (never the encryption key itself): HMAC(offline key, label)
  const parent = await subtle().importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sub = await subtle().sign('HMAC', parent, new TextEncoder().encode('appbuilder-offline-names-v1') as BufferSource)
  const nameKey = await subtle().importKey('raw', sub, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  new Uint8Array(sub).fill(0)
  raw.fill(0)
  const enc = async (bytes: ArrayBuffer | Uint8Array): Promise<Sealed> => {
    const iv = randomIv()
    const data = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, bytes as BufferSource)
    return { iv, data }
  }
  const dec = (s: Sealed) => subtle().decrypt({ name: 'AES-GCM', iv: s.iv as BufferSource }, key, s.data)
  return {
    seal: (value) => enc(new TextEncoder().encode(encodeJson(value))),
    open: async <T,>(s: Sealed) => decodeJson<T>(new TextDecoder().decode(await dec(s))),
    sealBytes: (bytes) => enc(bytes),
    openBytes: (s) => dec(s),
    name: async (text) => toBase64Url(new Uint8Array(await subtle().sign('HMAC', nameKey, new TextEncoder().encode(text) as BufferSource))),
  }
}
