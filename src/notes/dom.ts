/**
 * The note body in the page (docs/dev/notes.md): the sanitised tree is turned into elements one by one
 * (document.createElement, textContent, setAttribute of the allowed attributes): never innerHTML, never
 * dangerouslySetInnerHTML. The editor's content is read back by walking its nodes, keeping only tag names and the allowed
 * attributes, and the result goes through the same sanitiser as on the server.
 */
import { NOTE_TAGS, parseNoteHtml, sanitizeNoteHtml, type NoteNode } from './sanitize'

export interface BuildOptions {
  /** the URL of an image of the note (its own Files), or '' when it is not one of them */
  imageUrl(attId: string): string
  /** the text of a record card for this reader (null: not known yet) */
  recordLabel(ref: string): { text: string; available: boolean } | null
  editable: boolean
}

/** elements for the tree (into `doc`) */
export function buildNodes(nodes: NoteNode[], doc: Document, o: BuildOptions): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    if (n.t === 'text') {
      out.push(doc.createTextNode(n.v))
      continue
    }
    const el = doc.createElement(n.tag)
    for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v)
    if (n.tag === 'a' && /^(https?:|mailto:)/i.test(n.attrs.href ?? '')) {
      el.setAttribute('rel', 'noopener noreferrer')
      el.setAttribute('target', '_blank')
    }
    if (n.tag === 'img') {
      const src = o.imageUrl(n.attrs['data-att'] ?? '')
      if (src) el.setAttribute('src', src)
      el.setAttribute('alt', src ? 'Image' : 'Image not available')
      el.className = 'note-img'
    } else if (n.tag === 'span' && n.attrs['data-record']) {
      const l = o.recordLabel(n.attrs['data-record']) ?? { text: 'Record', available: true }
      el.textContent = l.text
      el.setAttribute('contenteditable', 'false')
      el.className = l.available ? 'note-card' : 'note-card note-card-off'
    } else if (n.tag === 'span' && n.attrs['data-mention']) {
      el.textContent = n.kids.map((k) => (k.t === 'text' ? k.v : '')).join('')
      el.setAttribute('contenteditable', 'false')
      el.className = 'note-mention'
    } else {
      for (const c of buildNodes(n.kids, doc, o)) el.appendChild(c)
    }
    out.push(el)
  }
  return out
}

/** replaces the content of `root` with the body */
export function renderInto(root: HTMLElement, html: string, o: BuildOptions): void {
  while (root.firstChild) root.removeChild(root.firstChild)
  for (const n of buildNodes(parseNoteHtml(html), root.ownerDocument, o)) root.appendChild(n)
}

/** the minimum of a DOM node read here (tests pass plain objects) */
export interface DomLike {
  nodeType: number
  nodeName: string
  nodeValue: string | null
  childNodes: ArrayLike<DomLike>
  getAttribute?(name: string): string | null
}

const KEEP_ATTRS = ['href', 'data-mention', 'data-record', 'data-type', 'data-checked', 'data-att']
const escT = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escA = (s: string) => escT(s).replace(/"/g, '&quot;')
const KNOWN = new Set<string>([...NOTE_TAGS, 'strong', 'em', 'div', 'h4', 'h5', 'h6', 'del', 'strike'])

function walk(n: DomLike, out: string[]): void {
  if (n.nodeType === 3) {
    out.push(escT(n.nodeValue ?? ''))
    return
  }
  if (n.nodeType !== 1) return
  const tag = n.nodeName.toLowerCase()
  const kids = Array.from(n.childNodes)
  if (!KNOWN.has(tag)) {
    // an element the editor made that is not part of the format (font, a span with a style): its content stays
    for (const k of kids) walk(k, out)
    return
  }
  const attrs = KEEP_ATTRS.map((a) => [a, n.getAttribute?.(a) ?? null] as const).filter(([, v]) => v !== null).map(([a, v]) => ` ${a}="${escA(v!)}"`).join('')
  if (tag === 'br' || tag === 'img') {
    out.push(`<${tag}${attrs}>`)
    return
  }
  out.push(`<${tag}${attrs}>`)
  // a record card's label is the reader's view of the record: never part of the note
  if (!(tag === 'span' && n.getAttribute?.('data-record'))) for (const k of kids) walk(k, out)
  out.push(`</${tag}>`)
}

/** the editor's content as a (sanitised) body */
export function readBody(root: DomLike): string {
  const out: string[] = []
  for (const k of Array.from(root.childNodes)) walk(k, out)
  const html = sanitizeNoteHtml(out.join(''))
  // an editor holding only an empty paragraph or a line break is an empty note
  return /^(<p>(<br>)?<\/p>|<br>)?$/.test(html) ? '' : html
}
