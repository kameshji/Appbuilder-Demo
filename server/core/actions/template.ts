/**
 * Templates of HTTP actions: `{{name}}` (or `{{a.b}}`, `{{items.0.id}}`) is replaced by the input with that path.
 *
 *  - In a path every value is URL-encoded as one segment (`/` becomes %2F), and `.`, `..` and empty values are refused,
 *    so an input can never move the request to another path or host.
 *  - In query values, header values and text bodies the value is inserted as text (headers refuse line breaks).
 *  - In a JSON body template a string that is exactly `{{name}}` becomes the typed value (number, list, object);
 *    inside longer text it is inserted as text.
 *
 * Unknown names are errors (no silent empty strings).
 */
export class TemplateError extends Error {}

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g
const EXACT = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}$/

export function lookupPath(inputs: unknown, path: string): unknown {
  let cur: unknown = inputs
  for (const part of path.split('.')) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : undefined
    else if (typeof cur === 'object') cur = Object.prototype.hasOwnProperty.call(cur, part) ? (cur as Record<string, unknown>)[part] : undefined
    else return undefined
  }
  return cur
}

const asText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** names used by a template (for checks when a maker saves an action) */
export function templateNames(t: string): string[] {
  return [...t.matchAll(TOKEN)].map((m) => m[1])
}

function value(inputs: unknown, name: string, where: string): unknown {
  const v = lookupPath(inputs, name)
  if (v === undefined) throw new TemplateError(`${where} uses {{${name}}}, but the inputs have no "${name}".`)
  return v
}

/** a path template -> a path with encoded segments */
export function renderPath(t: string, inputs: unknown): string {
  return t.replace(TOKEN, (_m, name: string) => {
    const s = asText(value(inputs, name, 'The path'))
    if (s === '' || s === '.' || s === '..') throw new TemplateError(`The path input "${name}" may not be empty, "." or "..".`)
    return encodeURIComponent(s)
  })
}

/** query values, header values, text bodies */
export function renderText(t: string, inputs: unknown, where = 'A value', o: { header?: boolean } = {}): string {
  const out = t.replace(TOKEN, (_m, name: string) => asText(value(inputs, name, where)))
  if (o.header && /[\r\n\0]/.test(out)) throw new TemplateError(`${where} must not contain line breaks.`)
  return out
}

/** a JSON template (any value): strings are rendered; an exact "{{x}}" keeps the type of x */
export function renderJson(t: unknown, inputs: unknown, depth = 0): unknown {
  if (depth > 32) throw new TemplateError('The body template is nested too deeply.')
  if (typeof t === 'string') {
    const m = EXACT.exec(t)
    if (m) return value(inputs, m[1], 'The body')
    return renderText(t, inputs, 'The body')
  }
  if (Array.isArray(t)) return t.map((x) => renderJson(x, inputs, depth + 1))
  if (t && typeof t === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(t)) out[k] = renderJson(v, inputs, depth + 1)
    return out
  }
  return t
}
