/**
 * SecretBox: AES-256-GCM with a 32-byte key from APPBUILDER_SECRET_KEY (64 hex) or workspace/.secret-key
 * (hex, created on first start with mode 0600). Sealed format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 */
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretBox } from './contracts.ts'

const HEX64 = /^[0-9a-fA-F]{64}$/

export function loadSecretKey(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.APPBUILDER_SECRET_KEY
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!HEX64.test(fromEnv.trim())) throw new Error('APPBUILDER_SECRET_KEY must be 64 hex characters (32 bytes)')
    return Buffer.from(fromEnv.trim(), 'hex')
  }
  const file = path.join(workspaceDir, '.secret-key')
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!HEX64.test(text)) throw new Error(`${file} is not a 64 hex character key`)
    return Buffer.from(text, 'hex')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  fs.mkdirSync(workspaceDir, { recursive: true })
  const key = randomBytes(32)
  // 'wx': never overwrite a key another process created in the meantime
  try {
    fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return loadSecretKey(workspaceDir, env)
    throw e
  }
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return key
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error('secret key must be 32 bytes')
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
    },
    decrypt(sealed: string): string {
      const parts = sealed.split(':')
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('sealed secret has an unknown format')
      const iv = Buffer.from(parts[1], 'base64')
      const tag = Buffer.from(parts[2], 'base64')
      const ct = Buffer.from(parts[3], 'base64')
      if (iv.length !== 12 || tag.length !== 16) throw new Error('sealed secret is corrupt')
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('sealed secret cannot be decrypted (wrong key or tampered data)')
      }
    },
  }
}
