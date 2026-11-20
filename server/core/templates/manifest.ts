/**
 * Seals the built-in templates: writes each package's `signature.digest` and builtin/manifest.json (docs/dev/templates.md).
 * Developer tool, run after editing a built-in template:
 *
 *   node server/core/templates/manifest.ts --write     (or --check: exit 1 when something is out of date)
 *
 * The digest is SHA-256 over the canonical JSON without the signature, so reformatting a file does not change it.
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TemplatePackage } from '../../../src/templates/format.ts'
import { BUILTIN_MANIFEST_URL, BUILTIN_TEMPLATE_FILES } from './builtin/index.ts'
import { digestOf, type TemplateManifest } from './catalogue.ts'

/** the manifest the built-in files should have, and the files whose own digest is out of date */
export function expectedManifest(): { manifest: TemplateManifest; stale: string[]; packages: { file: string; url: URL; pkg: TemplatePackage }[] } {
  const packages = BUILTIN_TEMPLATE_FILES.map(({ file, url }) => ({ file, url, pkg: JSON.parse(fs.readFileSync(url, 'utf8')) as TemplatePackage }))
  const stale: string[] = []
  const templates = packages.map(({ file, pkg }) => {
    const sha256 = digestOf(pkg)
    if (pkg.signature?.digest !== sha256) stale.push(file)
    return { file, id: pkg.id, version: pkg.version, sha256 }
  })
  return { manifest: { format: 'appbuilder/template-manifest', templates }, stale, packages }
}

function main(argv: string[]): number {
  const { manifest, stale, packages } = expectedManifest()
  const current = fs.existsSync(BUILTIN_MANIFEST_URL) ? fs.readFileSync(BUILTIN_MANIFEST_URL, 'utf8') : ''
  const next = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestStale = current.replace(/\r\n/g, '\n') !== next
  if (argv.includes('--check')) {
    if (stale.length || manifestStale) {
      process.stderr.write(`Out of date: ${[...stale, ...(manifestStale ? ['manifest.json'] : [])].join(', ')}. Run node server/core/templates/manifest.ts --write\n`)
      return 1
    }
    process.stdout.write('The built-in templates and their manifest are up to date.\n')
    return 0
  }
  if (!argv.includes('--write')) {
    process.stdout.write('Usage: node server/core/templates/manifest.ts --write | --check\n')
    return 2
  }
  for (const { file, url, pkg } of packages) {
    if (!stale.includes(file)) continue
    const sealed = { ...pkg, signature: { alg: 'sha256', digest: digestOf(pkg) } }
    fs.writeFileSync(url, `${JSON.stringify(sealed, null, 2)}\n`)
    process.stdout.write(`sealed ${file}\n`)
  }
  fs.writeFileSync(BUILTIN_MANIFEST_URL, next)
  process.stdout.write(`wrote ${fileURLToPath(BUILTIN_MANIFEST_URL)}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
