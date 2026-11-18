#!/usr/bin/env node
/**
 * Prepares an offline install bundle (package L) on any computer with internet and Node.js 22.18+:
 *
 *   node scripts/install/prepare-offline.mjs --os windows|linux --out <folder> [--release <appbuilder-x.y.z.zip>] [--no-postgres] [--no-caddy]
 *
 * Downloads every third-party file the installer of that system needs from scripts/install/manifest.txt, checks each
 * against its pinned SHA-256/SHA-512 (a mismatch deletes the file and fails), copies the release ZIP if given, and
 * writes bundle.txt (what is inside, with checksums). Copy the folder to the offline server (USB disk) and run
 *   Windows:  .\scripts\install\windows\install.ps1 -Offline D:\appbuilder-bundle
 *   Linux:    sudo bash scripts/install/linux/install.sh --offline /media/usb/appbuilder-bundle
 * Linux bundles hold Node.js and Caddy; PostgreSQL must come from the distribution's media or a local mirror.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const die = (s) => { process.stderr.write(`ERROR: ${s}\n`); process.exit(1) }

export function readManifest(file = path.join(here, 'manifest.txt')) {
  const m = new Map()
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1))
  }
  return m
}

/** the downloads one system needs: [{ key, url, algo, sum }] */
export function downloadsFor(m, os, o = {}) {
  const keys = os === 'windows'
    ? ['node.win-x64', ...(o.postgres === false ? [] : ['postgres.win-x64']), 'winsw.win', ...(o.caddy === false ? [] : ['caddy.win-x64'])]
    : ['node.linux-x64', 'node.linux-arm64', ...(o.caddy === false ? [] : ['caddy.linux-x64'])]
  return keys.map((k) => {
    const url = m.get(`${k}.url`)
    const algo = m.has(`${k}.sha512`) ? 'sha512' : 'sha256'
    const sum = m.get(`${k}.${algo}`)
    if (!url || !sum) throw new Error(`manifest.txt lacks ${k}.url or its checksum`)
    return { key: k, url, algo, sum: sum.toLowerCase() }
  })
}

function hashFile(file, algo) {
  return createHash(algo).update(fs.readFileSync(file)).digest('hex')
}

async function main() {
  const a = process.argv.slice(2)
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined)
  const os = get('--os')
  const out = get('--out')
  const release = get('--release')
  if (!['windows', 'linux'].includes(os ?? '') || !out) die('Usage: node scripts/install/prepare-offline.mjs --os windows|linux --out <folder> [--release <zip>] [--no-postgres] [--no-caddy]')
  const m = readManifest()
  const list = downloadsFor(m, os, { postgres: !a.includes('--no-postgres'), caddy: !a.includes('--no-caddy') })
  fs.mkdirSync(out, { recursive: true })
  const lines = [`# Appbuilder offline bundle for ${os}, manifest ${m.get('manifest.date')}, made ${new Date().toISOString()}`]
  for (const d of list) {
    if (!d.url.startsWith('https://')) die(`refusing a non-HTTPS URL: ${d.url}`)
    const name = path.basename(new URL(d.url).pathname)
    const file = path.join(out, name)
    if (fs.existsSync(file) && hashFile(file, d.algo) === d.sum) {
      process.stdout.write(`ok (already there)  ${name}\n`)
    } else {
      process.stdout.write(`downloading         ${d.url}\n`)
      const res = await fetch(d.url, { redirect: 'follow' })
      if (!res.ok) die(`${d.url}: HTTP ${res.status}`)
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      const got = hashFile(file, d.algo)
      if (got !== d.sum) {
        fs.rmSync(file)
        die(`${name}: ${d.algo} ${got} does not match the pinned ${d.sum}. Nothing was kept.`)
      }
      process.stdout.write(`ok (${d.algo} verified)  ${name}\n`)
    }
    lines.push(`${d.algo}:${d.sum}  ${name}`)
  }
  if (release) {
    const name = path.basename(release)
    fs.copyFileSync(release, path.join(out, name))
    lines.push(`sha256:${hashFile(path.join(out, name), 'sha256')}  ${name}`)
    process.stdout.write(`copied              ${name}\n`)
  }
  fs.writeFileSync(path.join(out, 'bundle.txt'), lines.join('\n') + '\n')
  process.stdout.write(`\nBundle ready in ${path.resolve(out)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
