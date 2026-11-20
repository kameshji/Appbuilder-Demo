/**
 * The note body format (P3 package N, docs/dev/notes.md): a strict allow-list of HTML, parsed into a small tree and
 * written out again. Pure string processing (no DOM), shared by the server (the security boundary: every Body is cleaned
 * on write through `setNoteSanitizer` in server/core/tasks/service.ts) and the client (paste, the editor's serialiser,
 * rendering by building elements from the tree: never innerHTML).
 *
 * NOTE_TAGS = the comment subset (p br b i u s ul ol li a code pre blockquote span) + h1-h3, table thead tbody tr th td,
 * checklists (`<ul data-type="checklist"><li data-checked="true|false">`), and img with ONLY `data-att="att_..."` (the
 * file is in the note's own Files column, so its access follows the note).
 *
 * Attributes kept: a href (http, https, mailto, in-app #), span data-mention (a user id; the text is the name), span
 * data-record ("table:row"; stored EMPTY: the label is resolved per reader, so no record value is ever stored in a note),
 * ul data-type="checklist", li data-checked, img data-att. Everything else is dropped. script, style, iframe, svg, math,
 * template, object and similar are dropped WITH their content; comments, doctype and processing instructions are dropped;
 * unknown tags are unwrapped (their text stays, escaped). Nesting is repaired (lists hold items, tables hold rows and cells,
 * no table inside a table, no block inside an inline element, depth at most MAX_DEPTH).
 *
 * Only relative imports: the server runs this file directly.
 */

export const NOTE_TAGS = ['p', 'br', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'span', 'h1', 'h2', 'h3', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'] as const
export type NoteTag = (typeof NOTE_TAGS)[number]

export type NoteNode = { t: 'text'; v: string } | { t: 'el'; tag: NoteTag; attrs: Record<string, string>; kids: NoteNode[] }

/** deepest element nesting kept (deeper tags are unwrapped, their text stays) */
export const MAX_DEPTH = 24
/** input characters looked at (the server refuses larger bodies before this) */
export const MAX_INPUT = 1_000_000

/** names that map onto an allowed tag (pasted HTML from word processors and browsers) */
const ALIAS: Record<string, NoteTag> = { strong: 'b', em: 'i', del: 's', strike: 's', ins: 'u', div: 'p', h4: 'h3', h5: 'h3', h6: 'h3', tt: 'code', kbd: 'code', samp: 'code', dir: 'ul', menu: 'ul', section: 'p', article: 'p', header: 'p', footer: 'p', main: 'p', aside: 'p', figure: 'p', figcaption: 'p', caption: 'p' }
/** dropped together with everything inside them */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'template', 'noscript', 'noembed', 'noframes', 'textarea', 'title', 'xmp', 'plaintext', 'select', 'option', 'head', 'video', 'audio', 'canvas', 'map', 'datalist', 'button', 'portal'])
const BLOCK = new Set<NoteTag>(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
const INLINE = new Set<NoteTag>(['b', 'i', 'u', 's', 'a', 'code', 'span'])
const VOID = new Set<NoteTag>(['br', 'img'])
/** blocks that may contain other blocks */
const CONTAINER = new Set<NoteTag>(['li', 'blockquote', 'td', 'th'])

const MENTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const RECORD_REF = /^[A-Za-z0-9_]{1,64}:[A-Za-z0-9_-]{1,64}$/
const ATT_ID = /^att_[A-Za-z0-9_-]{1,64}$/
const SAFE_HREF = /^(https?:\/\/[^\s<>"'`\\]{1,2000}|mailto:[^\s<>"'`\\]{1,320}|#[A-Za-z0-9/_\-.~?=&%:+,]{0,500})$/i

/* ------------------------------------------------------------------ entities */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', rupee: '₹', deg: '°', times: '×' }

/** decodes character references; an unknown name stays as written (it is text) */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // NUL, surrogates, out of range and control characters become nothing
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || (n < 32 && n !== 9 && n !== 10 && n !== 13) || (n >= 0x7f && n < 0xa0)) return ''
      return String.fromCodePoint(n)
    }
    const v = NAMED[body.toLowerCase()]
    return v === undefined ? m : v
  })
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** control characters (except tab and new line) are never kept */
// eslint-disable-next-line no-control-regex
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u2028\\u2029]', 'g')
const stripControls = (s: string) => s.replace(CONTROLS, '')

/* ------------------------------------------------------------------ tokenizer */

type Tok = { k: 'text'; v: string } | { k: 'open'; name: string; attrs: Record<string, string>; selfClose: boolean } | { k: 'close'; name: string }

/** an attribute list: name=value pairs, quoted (either quote) or bare; a `>` inside quotes does not end the tag */
function readTag(s: string, at: number): { end: number; attrs: Record<string, string>; selfClose: boolean } {
  const attrs: Record<string, string> = {}
  let i = at
  let selfClose = false
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === '>') return { end: i + 1, attrs, selfClose }
    if (c === '/' ) {
      selfClose = s[i + 1] === '>'
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue }
    let j = i
    while (j < n && !/[\s/>=]/.test(s[j])) j++
    const name = s.slice(i, j).toLowerCase()
    i = j
    while (i < n && /\s/.test(s[i])) i++
    let value = ''
    if (s[i] === '=') {
      i++
      while (i < n && /\s/.test(s[i])) i++
      const q = s[i]
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1)
        const stop = close < 0 ? n : close
        value = s.slice(i + 1, stop)
        i = close < 0 ? n : close + 1
      } else {
        let k = i
        while (k < n && !/[\s>]/.test(s[k])) k++
        value = s.slice(i, k)
        i = k
      }
    }
    selfClose = false
    if (name && !(name in attrs) && Object.keys(attrs).length < 32) attrs[name] = decodeEntities(value)
    if (!name) i++
  }
  return { end: n, attrs, selfClose }
}

/** where the element `name` (dropped with its content) ends: after its matching close tag, counting nested ones */
function skipElement(s: string, from: number, name: string): number {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>?`, 'gi')
  re.lastIndex = from
  let depth = 1
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) depth--
    else if (!m[0].endsWith('/>')) depth++
    if (depth === 0) return m.index + m[0].length
  }
  return s.length
}

function* tokens(input: string): Generator<Tok> {
  const s = input
  const n = s.length
  let i = 0
  let text = ''
  const flush = function* () {
    if (text) yield { k: 'text', v: decodeEntities(text) } as Tok
    text = ''
  }
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      text += s.slice(i)
      break
    }
    text += s.slice(i, lt)
    i = lt
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4)
      i = e < 0 ? n : e + 3
      continue
    }
    const c1 = s[i + 1] ?? ''
    if (c1 === '!' || c1 === '?') {
      const e = s.indexOf('>', i + 2)
      i = e < 0 ? n : e + 1
      continue
    }
    if (c1 === '/' && /[A-Za-z]/.test(s[i + 2] ?? '')) {
      let j = i + 2
      while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++
      const name = s.slice(i + 2, j).toLowerCase()
      const e = s.indexOf('>', j)
      i = e < 0 ? n : e + 1
      yield* flush()
      yield { k: 'close', name }
      continue
    }
    if (/[A-Za-z]/.test(c1)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++
      const name = s.slice(i + 1, j).toLowerCase()
      const t = readTag(s, j)
      i = t.end
      yield* flush()
      if (DROP_WITH_CONTENT.has(name)) {
        if (!t.selfClose) i = skipElement(s, i, name)
        continue
      }
      yield { k: 'open', name, attrs: t.attrs, selfClose: t.selfClose }
      continue
    }
    // a lone "<" is text
    text += '<'
    i++
  }
  yield* flush()
}

/* ------------------------------------------------------------------ tree builder */

type El = Extract<NoteNode, { t: 'el' }>
type Frame = { el: El; textOnly?: boolean; noContent?: boolean }

/** the allowed attributes of an element (null: the element is dropped entirely, e.g. an img without a file) */
function cleanAttrs(tag: NoteTag, a: Record<string, string>): Record<string, string> | null {
  switch (tag) {
    case 'a': {
      const h = (a.href ?? '').trim()
      return SAFE_HREF.test(h) ? { href: h } : {}
    }
    case 'span':
      if (MENTION_ID.test(a['data-mention'] ?? '')) return { 'data-mention': a['data-mention'] }
      if (RECORD_REF.test(a['data-record'] ?? '')) return { 'data-record': a['data-record'] }
      return {}
    case 'ul':
      return a['data-type'] === 'checklist' ? { 'data-type': 'checklist' } : {}
    case 'li':
      return a['data-checked'] === 'true' || a['data-checked'] === 'false' ? { 'data-checked': a['data-checked'] } : {}
    case 'img':
      return ATT_ID.test(a['data-att'] ?? '') ? { 'data-att': a['data-att'] } : null
    default:
      return {}
  }
}

/** parses (untrusted) HTML into the allowed tree */
export function parseNoteHtml(html: string, maxInput = MAX_INPUT): NoteNode[] {
  const root: El = { t: 'el', tag: 'p', attrs: {}, kids: [] }
  const stack: Frame[] = [{ el: root }]
  const top = () => stack[stack.length - 1]
  const has = (tag: NoteTag) => stack.some((f) => f.el.tag === tag && f.el !== root)
  const inTable = () => stack.some((f) => f.el.tag === 'table')
  /** depth of tables being ignored (a table inside a table): their structure tags are unwrapped */
  let ignoredTables = 0
  const popTo = (i: number) => {
    stack.length = Math.max(1, i)
  }
  const push = (tag: NoteTag, attrs: Record<string, string>, extra: Omit<Frame, 'el'> = {}) => {
    const el: El = { t: 'el', tag, attrs, kids: [] }
    top().el.kids.push(el)
    if (!VOID.has(tag)) stack.push({ el, ...extra })
    return el
  }
  const appendText = (v: string) => {
    const f = top()
    if (f.noContent) return
    const tag = f.el.tag
    // whitespace between list items and table parts is formatting, not content
    if ((tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr') && f.el !== root) {
      if (!v.trim()) return
      if (tag === 'ul' || tag === 'ol') push('li', {})
      else return // stray text inside a table outside a cell is dropped
    }
    const last = top().el.kids[top().el.kids.length - 1]
    if (last && last.t === 'text') last.v += v
    else top().el.kids.push({ t: 'text', v })
  }
  /** an inline element cannot hold a block: close inline elements (and a paragraph or heading) before a block opens */
  const closeInlines = () => {
    while (stack.length > 1 && (INLINE.has(top().el.tag) || top().el.tag === 'p' || top().el.tag === 'h1' || top().el.tag === 'h2' || top().el.tag === 'h3' || top().el.tag === 'pre')) stack.pop()
  }

  let src = stripControls(String(html ?? ''))
  if (src.length > maxInput) src = src.slice(0, maxInput)
  for (const tk of tokens(src)) {
    if (tk.k === 'text') {
      if (top().textOnly && top().noContent) continue
      appendText(tk.v)
      continue
    }
    const raw = tk.name
    const tag: NoteTag | undefined = (NOTE_TAGS as readonly string[]).includes(raw) ? (raw as NoteTag) : ALIAS[raw]
    if (tk.k === 'close') {
      if (!tag) continue
      if (tag === 'table' && ignoredTables > 0) { ignoredTables--; continue }
      if (ignoredTables > 0 && (tag === 'thead' || tag === 'tbody' || tag === 'tr' || tag === 'td' || tag === 'th')) continue
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].el.tag === tag) {
          popTo(i)
          break
        }
        // a close tag never reaches past the cell or item it is in
        if ((stack[i].el.tag === 'td' || stack[i].el.tag === 'th') && tag !== 'td' && tag !== 'th' && tag !== 'tr' && tag !== 'table' && tag !== 'tbody' && tag !== 'thead') break
      }
      continue
    }
    // open tags
    if (!tag) continue // unknown: unwrapped (its text stays)
    // inside a mention only text; inside a record reference nothing
    if (top().textOnly || top().noContent) continue
    if (stack.length > MAX_DEPTH && !VOID.has(tag)) continue
    const attrs = cleanAttrs(tag, tk.attrs)
    if (attrs === null) continue
    if (tag === 'span' && !attrs['data-mention'] && !attrs['data-record']) continue // a plain span is unwrapped
    if (tag === 'br') { if (!['ul', 'ol', 'table', 'thead', 'tbody', 'tr'].includes(top().el.tag) || top().el === root) push('br', {}); continue }

    if (tag === 'table') {
      if (inTable()) { ignoredTables++; continue }
      closeInlines()
      push('table', {})
      continue
    }
    if (tag === 'thead' || tag === 'tbody') {
      if (ignoredTables > 0) continue
      const ti = stack.map((f) => f.el.tag).lastIndexOf('table')
      if (ti < 0) continue
      popTo(ti + 1)
      push(tag, {})
      continue
    }
    if (tag === 'tr') {
      if (ignoredTables > 0) continue
      const ti = stack.map((f) => f.el.tag).lastIndexOf('table')
      if (ti < 0) continue
      const after = stack.slice(ti + 1).findIndex((f) => f.el.tag === 'thead' || f.el.tag === 'tbody')
      popTo(after >= 0 ? ti + 1 + after + 1 : ti + 1)
      push('tr', {})
      continue
    }
    if (tag === 'td' || tag === 'th') {
      if (ignoredTables > 0) continue
      const ri = stack.map((f) => f.el.tag).lastIndexOf('tr')
      const ti = stack.map((f) => f.el.tag).lastIndexOf('table')
      if (ti < 0) continue
      if (ri < ti) {
        // a cell without a row: the row is implied
        popTo(ti + 1)
        push('tr', {})
      } else popTo(ri + 1)
      push(tag, {})
      continue
    }
    // inside a table only cells hold content
    const t = top().el.tag
    if ((t === 'table' || t === 'thead' || t === 'tbody' || t === 'tr') && top().el !== root) continue

    if (tag === 'li') {
      // the nearest list (not past a cell or a quote) holds the item; without one it is a paragraph
      let li = -1
      for (let i = stack.length - 1; i >= 1; i--) {
        const g = stack[i].el.tag
        if (g === 'ul' || g === 'ol') { li = i; break }
        if (g === 'td' || g === 'th' || g === 'blockquote') break
      }
      if (li < 0) {
        closeInlines()
        push('p', {})
        continue
      }
      popTo(li + 1)
      push('li', attrs)
      continue
    }
    if (BLOCK.has(tag)) {
      closeInlines()
      // a list directly in a list goes into its last item
      if ((tag === 'ul' || tag === 'ol' || tag === 'p' || tag === 'blockquote' || tag === 'pre' || tag === 'h1' || tag === 'h2' || tag === 'h3') && (top().el.tag === 'ul' || top().el.tag === 'ol') && top().el !== root) {
        const list = top().el
        const last = list.kids[list.kids.length - 1]
        if (last && last.t === 'el' && last.tag === 'li') stack.push({ el: last })
        else push('li', {})
      }
      // blocks stay out of blocks that cannot contain them (p in p, a heading in a paragraph)
      if (!CONTAINER.has(top().el.tag) && top().el !== root && top().el.tag !== 'ul' && top().el.tag !== 'ol') {
        while (stack.length > 1 && !CONTAINER.has(top().el.tag) && top().el.tag !== 'ul' && top().el.tag !== 'ol') stack.pop()
      }
      push(tag, attrs)
      continue
    }
    if (tag === 'a' && has('a')) {
      // no link inside a link
      const ai = stack.map((f) => f.el.tag).lastIndexOf('a')
      popTo(ai)
    }
    if (tag === 'img') { push('img', attrs); continue }
    if (tag === 'span') {
      if (attrs['data-record']) push('span', attrs, { noContent: true, textOnly: true })
      else push('span', attrs, { textOnly: true })
      if (tk.selfClose) stack.pop()
      continue
    }
    push(tag, attrs)
    if (tk.selfClose) stack.pop()
  }
  return root.kids
}

/* ------------------------------------------------------------------ writer */

function isEmptyInline(n: NoteNode): boolean {
  return n.t === 'el' && (n.tag === 'b' || n.tag === 'i' || n.tag === 'u' || n.tag === 's' || n.tag === 'code' || n.tag === 'a') && n.kids.every((k) => (k.t === 'text' ? k.v === '' : isEmptyInline(k)))
}

function write(nodes: NoteNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.t === 'text') {
      out.push(escText(n.v))
      continue
    }
    if (isEmptyInline(n)) continue
    if (n.tag === 'span' && n.attrs['data-mention'] && !n.kids.length) continue
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')
    const extra = n.tag === 'a' && /^(https?:|mailto:)/i.test(n.attrs.href ?? '') ? ' rel="noopener noreferrer" target="_blank"' : ''
    if (n.tag === 'br') { out.push('<br>'); continue }
    if (n.tag === 'img') { out.push(`<img${attrs}>`); continue }
    out.push(`<${n.tag}${attrs}${extra}>`)
    if (n.tag === 'span' && n.attrs['data-record']) { out.push('</span>'); continue }
    if (n.tag === 'span' && n.attrs['data-mention']) {
      out.push(escText(n.kids.map((k) => (k.t === 'text' ? k.v : plainOf([k]))).join('')))
      out.push('</span>')
      continue
    }
    write(n.kids, out)
    out.push(`</${n.tag}>`)
  }
}

/** the tree as HTML (every value escaped) */
export function serializeNote(nodes: NoteNode[]): string {
  const out: string[] = []
  write(nodes, out)
  return out.join('')
}

/** the note sanitiser: untrusted HTML in, allow-listed HTML out (idempotent: sanitising the output changes nothing) */
export function sanitizeNoteHtml(html: string): string {
  return serializeNote(parseNoteHtml(html))
}

/* ------------------------------------------------------------------ reading a body */

function plainOf(nodes: NoteNode[], out: string[] = []): string {
  for (const n of nodes) {
    if (n.t === 'text') { out.push(n.v); continue }
    if (n.tag === 'br') { out.push('\n'); continue }
    if (n.tag === 'img') { out.push('[image]'); continue }
    if (n.tag === 'span' && n.attrs['data-record']) { out.push('[record]'); continue }
    if (n.tag === 'td' || n.tag === 'th') { plainOf(n.kids, out); out.push('\t'); continue }
    plainOf(n.kids, out)
    if (BLOCK.has(n.tag)) out.push('\n')
  }
  return out.join('')
}

/** plain text of a body (search snippets, notifications, previews) */
export function noteToPlain(html: string): string {
  return plainOf(parseNoteHtml(html)).replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function walk(nodes: NoteNode[], fn: (n: El) => void): void {
  for (const n of nodes) {
    if (n.t !== 'el') continue
    fn(n)
    walk(n.kids, fn)
  }
}
const collect = (html: string, attr: string, tag: NoteTag): string[] => {
  const out = new Set<string>()
  walk(parseNoteHtml(html), (n) => {
    if (n.tag === tag && n.attrs[attr]) out.add(n.attrs[attr])
  })
  return [...out]
}
/** user ids mentioned in a body */
export const noteMentionIds = (html: string): string[] => collect(html, 'data-mention', 'span')
/** "table:row" references of record cards in a body */
export const noteRecordRefs = (html: string): string[] => collect(html, 'data-record', 'span')
/** attachment ids of the images in a body */
export const noteImageIds = (html: string): string[] => collect(html, 'data-att', 'img')
