import { serializeNote } from './sanitize'

/** plain text as a note body: one paragraph per line (escaped by the serialiser); trailing empty lines dropped */
export function plainToNote(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return serializeNote(lines.map((l) => ({ t: 'el' as const, tag: 'p' as const, attrs: {}, kids: l ? [{ t: 'text' as const, v: l }] : [] })))
}
