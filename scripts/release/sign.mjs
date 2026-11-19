#!/usr/bin/env node
/**
 * `npm run release:sign -- <release folder> --key <private key file>` (package L): signs SHA256SUMS of a release folder
 * with the vendor's Ed25519 key (SHA256SUMS.sig) and writes the ZIP again.
 *
 * The private key file is the encrypted PKCS#8 PEM made by `npm run release:keygen`; it must live outside the
 * repository (refused otherwise). The passphrase comes from APPBUILDER_RELEASE_KEY_PASSPHRASE or is asked for (not
 * shown). The script first checks the folder against SHA256SUMS, and afterwards that the signature verifies with the
 * public keys the release carries (release-keys.json), so a release signed with a key it does not list is refused.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { SIG_FILE, SUMS_FILE, checkSignature, readTrustedKeys, signSums, verifyTree } from '../../server/core/update/release.ts'
import { zipRelease } from './lib.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const die = (s) => { process.stderr.write(`ERROR: ${s}\n`); process.exit(1) }
const args = process.argv.slice(2)
let folder = null
let keyFile = process.env.APPBUILDER_RELEASE_KEY ?? null
let zip = true
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--key') keyFile = args[++i]
  else if (args[i] === '--no-zip') zip = false
  else folder = args[i]
}
if (!folder || !keyFile) die('Usage: npm run release:sign -- <release folder> --key <private key file>   (or APPBUILDER_RELEASE_KEY)')
folder = path.resolve(folder)
keyFile = path.resolve(keyFile)
if (keyFile.startsWith(repo + path.sep)) die('The private key must not be inside the repository folder. Keep it on an encrypted, offline medium.')
const check = verifyTree(folder)
if (!check.ok) die(`${folder} does not match its ${SUMS_FILE} (missing ${check.missing.length}, changed ${check.changed.length}, extra ${check.extra.length}). Build it again.`)

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s) }
    rl.question(q, (v) => { rl.close(); process.stdout.write('\n'); resolve(v) })
  })
}
const passphrase = process.env.APPBUILDER_RELEASE_KEY_PASSPHRASE ?? (await askHidden('Passphrase of the release key: '))
const sums = fs.readFileSync(path.join(folder, SUMS_FILE), 'utf8')
let sig
try {
  sig = signSums(sums, fs.readFileSync(keyFile, 'utf8'), passphrase)
} catch (e) {
  die(`could not sign: ${e instanceof Error ? e.message : String(e)} (wrong passphrase?)`)
}
fs.writeFileSync(path.join(folder, SIG_FILE), JSON.stringify(sig, null, 2) + '\n', { mode: 0o644 })
const st = checkSignature(folder, readTrustedKeys(folder))
if (st.state !== 'valid') {
  fs.rmSync(path.join(folder, SIG_FILE))
  die(`the signature does not verify with the keys this release lists (${st.state}). Add the public key to scripts/release/release-keys.json and build again.`)
}
process.stdout.write(`Signed ${path.basename(folder)} with key ${sig.keyId}.\n`)
if (zip) process.stdout.write(`ZIP written: ${zipRelease(folder)}\n`)
