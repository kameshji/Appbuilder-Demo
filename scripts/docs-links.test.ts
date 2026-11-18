/**
 * Docs link checker (P0 package M): every relative link and image in docs/ and the top-level Markdown files must point at
 * a file or folder that exists. External links (http, mailto) and pure anchors are not checked; code blocks and inline
 * code are ignored.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) markdownFiles(p, acc)
    else if (name.endsWith('.md')) acc.push(p)
  }
  return acc
}

/** link targets of a Markdown text (inline links, images, reference definitions, HTML src/href), outside code */
export function linkTargets(md: string): string[] {
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const out: string[] = []
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]!)
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1]!)
  for (const m of text.matchAll(/<(?:img|a)\s[^>]*?(?:src|href)="([^"]+)"/g)) out.push(m[1]!)
  return out
}

const isExternal = (t: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t) || t.startsWith('#')

describe('documentation links', () => {
  it('finds links, images and references, ignoring code', () => {
    expect(linkTargets('see [a](a.md#x) and ![p](../images/p.png "t") `[no](x.md)`\n```\n[no](y.md)\n```\n[r]: ref.md\n<img src="i.png">')).toEqual(['a.md#x', '../images/p.png', 'ref.md', 'i.png'])
  })

  it('every relative link and image in docs/ and the top-level Markdown files exists', () => {
    const files = [...markdownFiles(resolve(root, 'docs')), ...['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md'].map((f) => resolve(root, f)).filter(existsSync)]
    const broken: string[] = []
    for (const file of files) {
      for (const target of linkTargets(readFileSync(file, 'utf8'))) {
        if (isExternal(target)) continue
        const clean = decodeURIComponent(target.replace(/[#?].*$/, ''))
        if (!clean) continue
        const abs = clean.startsWith('/') ? resolve(root, '.' + clean) : resolve(dirname(file), clean)
        if (!existsSync(abs)) broken.push(`${relative(root, file)}: ${target}`)
      }
    }
    expect(broken).toEqual([])
  })
})
