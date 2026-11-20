/**
 * The licence public keys an install trusts (package H-G; docs/dev/licensing.md "Keys").
 *
 *   built in:  server/core/licence/licence-keys.json, { "keys": [{ "id", "publicKey" (SPKI DER base64), "comment" }] },
 *              shipped in every release next to the release keys (the release build copies data files that a server
 *              module reads with new URL(..., import.meta.url)). Empty in the repository until the vendor runs
 *              `licence-service keygen` (the key pair is separate from the release key).
 *   override:  APPBUILDER_LICENCE_PUBLIC_KEY=<PEM or SPKI DER base64> (or APPBUILDER_LICENCE_PUBLIC_KEY_FILE=<file>):
 *              REPLACES the built-in keys. For tests and for an on-premises evaluation against the customer's own
 *              licence service. The Admin console shows that the override is in use. Anyone who can set the server's
 *              environment can also change its code, so the override gives an operator nothing they did not have.
 */
import fs from 'node:fs'
import { trustedLicenceKey, type TrustedLicenceKey } from './answer.ts'
import { errText, log } from '../util.ts'

const BUILT_IN = new URL('./licence-keys.json', import.meta.url)

export interface LicenceKeys { keys: TrustedLicenceKey[]; source: 'built-in' | 'setting'; problems: string[] }

export function licenceKeys(env: NodeJS.ProcessEnv = process.env): LicenceKeys {
  const problems: string[] = []
  const text = env.APPBUILDER_LICENCE_PUBLIC_KEY?.trim()
    || (env.APPBUILDER_LICENCE_PUBLIC_KEY_FILE?.trim() ? readFile(env.APPBUILDER_LICENCE_PUBLIC_KEY_FILE.trim(), problems) : '')
  if (text) {
    try {
      return { keys: [trustedLicenceKey(text)], source: 'setting', problems }
    } catch (e) {
      problems.push(`APPBUILDER_LICENCE_PUBLIC_KEY is not an Ed25519 public key (${errText(e)}).`)
      return { keys: [], source: 'setting', problems }
    }
  }
  const keys: TrustedLicenceKey[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(BUILT_IN, 'utf8')) as { keys?: { publicKey?: string }[] }
    for (const k of raw.keys ?? []) {
      try {
        if (typeof k.publicKey === 'string') keys.push(trustedLicenceKey(k.publicKey))
      } catch (e) {
        log('warn', `licence-keys.json: an entry is not an Ed25519 public key (${errText(e)})`)
      }
    }
  } catch {
    // no file: no built-in key (a development build)
  }
  return { keys, source: 'built-in', problems }
}

function readFile(file: string, problems: string[]): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    problems.push(`APPBUILDER_LICENCE_PUBLIC_KEY_FILE cannot be read (${errText(e)}).`)
    return ''
  }
}
