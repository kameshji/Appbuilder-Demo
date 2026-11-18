/** Small Markdown helpers shared by the reference-page generators. Output must be deterministic. */

export const GENERATED_NOTICE =
  '<!-- GENERATED FILE. Do not edit by hand: change the code (or the hand-written parts in scripts/docs/) and run `npm run docs:gen`. -->'

/** Escape text for a table cell: no line breaks, pipes escaped. */
export function cell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** Inline code that is safe inside a table cell (pipes escaped, newlines shown as \n, backticks handled). */
export function code(s: string): string {
  const flat = s.replace(/\r?\n/g, '\\n')
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return fence + pad + flat.replace(/\|/g, '\\|') + pad + fence
}

export function table(header: string[], rows: string[][]): string {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`)
  return lines.join('\n')
}

/** GitHub-style heading anchor, used for the in-page contents lists. */
export function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-')
}

/** Joins blocks with blank lines and ends the file with exactly one newline. */
export function page(blocks: string[]): string {
  return blocks.map((b) => b.replace(/\s+$/g, '')).join('\n\n') + '\n'
}
