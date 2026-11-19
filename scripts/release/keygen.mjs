#!/usr/bin/env node
/**
 * `npm run release:keygen -- --out <folder outside the repository>` (package L): makes the vendor's Ed25519 release key.
 *
 * Writes appbuilder-release-<id>.key (encrypted PKCS#8 PEM, AES-256-CBC with your passphrase, mode 0600) and
 * appbuilder-release-<id>.pub, and prints the entry to add to scripts/release/release-keys.json (public keys only; that
 * file is committed and copied into every release). Keep the .key file and its passphrase apart, offline, with a backup:
 * a lost key means installs can only be updated with --allow-unsigned or by running the installer again.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createPublicKey } from 'node:crypto'
import { generateReleaseKey, trustedKeyEntry } from '../../server/core/update/release.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const die = (s) => { process.stderr.write(`ERROR: ${s}\n`); process.exit(1) }
const args = process.argv.slice(2)
const i = args.indexOf('--out')
const comment = args.includes('--comment') ? args[args.indexOf('--comment') + 1] : `Appbuilder release key ${new Date().toISOString().slice(0, 10)}`
if (i < 0 || !args[i + 1]) die('Usage: npm run release:keygen -- --out <folder outside the repository> [--comment "text"]')
const out = path.resolve(args[i + 1])
if (out === repo || out.startsWith(repo + path.sep)) die('Choose a folder outside the repository: the private key must never be committed.')

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s) }
    rl.question(q, (v) => { rl.close(); process.stdout.write('\n'); resolve(v) })
  })
}
let pass = process.env.APPBUILDER_RELEASE_KEY_PASSPHRASE
if (!pass) {
  pass = await askHidden('Passphrase for the new release key (at least 12 characters): ')
  if ((await askHidden('Repeat it: ')) !== pass) die('The passphrases do not match.')
}
const k = generateReleaseKey(pass)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const keyPath = path.join(out, `appbuilder-release-${k.id}.key`)
const pubPath = path.join(out, `appbuilder-release-${k.id}.pub`)
fs.writeFileSync(keyPath, k.privatePem, { mode: 0o600, flag: 'wx' })
fs.writeFileSync(pubPath, k.publicPem, { mode: 0o644, flag: 'wx' })
const entry = trustedKeyEntry(createPublicKey(k.publicPem), comment)
process.stdout.write(`Private key: ${keyPath}\nPublic key:  ${pubPath}\nKey id:      ${k.id}\n\nAdd this entry to "keys" in scripts/release/release-keys.json and commit it:\n${JSON.stringify(entry, null, 2)}\n`)
