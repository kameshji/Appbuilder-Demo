/**
 * The chat composer's text format (pure; default 6 of docs/plan/p3-spec.md): a plain text box whose shortcuts become
 * the comment rich-text subset (RICH_TEXT_TAGS of src/platform/system-tables.ts). The server sanitises every body and
 * takes mentions from it; nothing here is a security boundary.
 *
 *   *bold*  _italic_  ~strike~  `code`  ```code block```  - item / * item  1. item  > quote
 *   https://... (a link)   [text](https://...)   @Name (a person picked in the mention list)   @channel
 *
 * Also: the reverse (a stored body back to editable text, for editing a message), the mention being typed, mention
 * marks for display, and time labels.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = (s: string) => esc(s).replace(/"/g, '&quot;')

/** the people picked in the mention list: display name -> user id ('channel' for @channel) */
export type MentionMap = Map<string, string>

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const TRAILING = /[.,;:!?)\]]+$/

/** inline formatting of one line (already split from blocks) */
export function inline(text: string, mentions: MentionMap): string {
  // placeholders keep code, links and mentions away from the other rules
  const slots: string[] = []
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`
  let s = text
  // `code`
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => hold(`<code>${esc(c)}</code>`))
  // [text](url)
  s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/gi, (_m, t: string, u: string) => hold(`<a href="${attr(u)}">${esc(t)}</a>`))
  // bare links
  s = s.replace(URL_RE, (u: string) => {
    const tail = TRAILING.exec(u)?.[0] ?? ''
    const url = tail ? u.slice(0, -tail.length) : u
    return hold(`<a href="${attr(url)}">${esc(url)}</a>`) + tail
  })
  // mentions, longest names first (so "@Asha Rao" wins over "@Asha")
  for (const [name, id] of [...mentions].sort((a, b) => b[0].length - a[0].length)) {
    const token = `@${name}`
    if (!s.includes(token)) continue
    s = s.split(token).join(hold(`<span data-mention="${attr(id)}">@${esc(name)}</span>`))
  }
  s = esc(s)
  // *bold*, _italic_, ~strike~: the marks touch the words, and stand at word edges
  const mark = (ch: string, tag: string) => {
    const c = ch === '*' ? '\\*' : ch
    const re = new RegExp(`(^|[\\s(\\[{"'])${c}(?=\\S)([^${c}\\n]*?\\S)${c}(?=$|[\\s.,!?;:)\\]}"'])`, 'g')
    s = s.replace(re, (_m, pre: string, body: string) => `${pre}<${tag}>${body}</${tag}>`)
  }
  mark('*', 'b')
  mark('_', 'i')
  mark('~', 's')
  // put the held parts back (nested holds cannot occur: a hold is added once, outside the others)
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '')
}

const BULLET = /^\s*[-*]\s+(.*)$/
const NUMBER = /^\s*\d{1,3}[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

/**
 * composer text -> stored rich text. Lines become paragraphs; runs of "- " / "* " lines a bulleted list, "1. " lines a
 * numbered list, "> " lines a quote; ``` fences a code block. Leading and trailing blank lines are dropped.
 */
export function composeBody(text: string, mentions: MentionMap = new Map()): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line.trim())) {
      const body: string[] = []
      const first = line.trim().slice(3)
      // ```one line``` on one line
      if (first.endsWith('```') && first.length > 3) {
        out.push(`<pre>${esc(first.slice(0, -3))}</pre>`)
        i++
        continue
      }
      if (first) body.push(first)
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++])
      i++ // the closing fence (or the end)
      out.push(`<pre>${esc(body.join('\n'))}</pre>`)
      continue
    }
    const block = [[BULLET, '<ul>', '</ul>'], [NUMBER, '<ol>', '</ol>']] as const
    const list = block.find(([re]) => re.test(line))
    if (list) {
      const [re, open, close] = list
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) items.push(`<li>${inline(re.exec(lines[i++])![1], mentions)}</li>`)
      out.push(`${open}${items.join('')}${close}`)
      continue
    }
    if (QUOTE.test(line)) {
      const q: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) q.push(inline(QUOTE.exec(lines[i++])![1], mentions))
      out.push(`<blockquote>${q.join('<br>')}</blockquote>`)
      continue
    }
    out.push(`<p>${inline(line, mentions)}</p>`)
    i++
  }
  return out.join('')
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

/**
 * stored rich text -> composer text and the mentions in it (editing a message). The inverse of composeBody for what
 * the composer writes; other markup degrades to its text.
 */
export function bodyToText(html: string): { text: string; mentions: MentionMap } {
  const mentions: MentionMap = new Map()
  const lines: string[] = []
  let cur = ''
  let list: { kind: 'ul' | 'ol'; n: number } | null = null
  let pre = false
  let quote = false
  let link: { href: string; start: number } | null = null
  let mention: { id: string; start: number } | null = null
  const flush = () => {
    lines.push(cur)
    cur = ''
  }
  const re = /<(\/?)([a-z]+)([^>]*)>|([^<]+)/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[4] !== undefined) {
      cur += decode(m[4])
      continue
    }
    const close = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3] ?? ''
    if (tag === 'br') { flush(); if (quote) cur = '> '; continue }
    if (tag === 'p') { if (close) flush(); continue }
    if (tag === 'b' || tag === 'strong') { cur += '*'; continue }
    if (tag === 'i' || tag === 'em') { cur += '_'; continue }
    if (tag === 's') { cur += '~'; continue }
    if (tag === 'code') { if (!pre) cur += '`'; continue }
    if (tag === 'pre') {
      if (!close) { pre = true; cur += '```\n' } else { pre = false; cur += '\n```'; flush() }
      continue
    }
    if (tag === 'blockquote') {
      if (!close) { quote = true; cur = '> ' } else { quote = false; flush() }
      continue
    }
    if (tag === 'ul' || tag === 'ol') { list = close ? null : { kind: tag, n: 0 }; continue }
    if (tag === 'li') {
      if (!close) { if (list) list.n++; cur = list?.kind === 'ol' ? `${list.n}. ` : '- ' } else flush()
      continue
    }
    if (tag === 'a') {
      if (!close) link = { href: decode(/href="([^"]*)"/.exec(attrs)?.[1] ?? ''), start: cur.length }
      else if (link) {
        const t = cur.slice(link.start)
        if (link.href && t !== link.href) cur = `${cur.slice(0, link.start)}[${t}](${link.href})`
        link = null
      }
      continue
    }
    if (tag === 'span') {
      if (!close) {
        const id = /data-mention="([^"]+)"/.exec(attrs)?.[1]
        mention = id ? { id, start: cur.length } : null
      } else if (mention) {
        const t = cur.slice(mention.start)
        if (t.startsWith('@') && t.length > 1) mentions.set(t.slice(1), mention.id)
        mention = null
      }
    }
  }
  if (cur) flush()
  // consecutive pre lines were joined with \n inside one "line"
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), mentions }
}

/** the mention being typed before the caret: "@as" -> { q: 'as', at: index of @ } */
export function mentionQuery(text: string, caret: number): { q: string; at: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|[\s(])@([\p{L}\p{M}\p{N}._-]{0,30})$/u.exec(before)
  return m ? { q: m[2], at: caret - m[2].length - 1 } : null
}

/** the text after a person is picked in the mention list (replaces the "@query" with "@Name ") */
export function insertMention(text: string, at: number, q: string, name: string): { text: string; caret: number } {
  const head = `${text.slice(0, at)}@${name} `
  const tail = text.slice(at + 1 + q.length).replace(/^ /, '')
  return { text: head + tail, caret: head.length }
}

/** mentions still present in the text (a removed "@Name" is no longer a mention) */
export function liveMentions(text: string, mentions: MentionMap): MentionMap {
  return new Map([...mentions].filter(([name]) => text.includes(`@${name}`)))
}

/** wraps the selection in a mark (Ctrl+B, Ctrl+I): returns the new text and selection */
export function wrapSelection(text: string, start: number, end: number, mark: string): { text: string; start: number; end: number } {
  const sel = text.slice(start, end)
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= 2 * mark.length) {
    const inner = sel.slice(mark.length, sel.length - mark.length)
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length }
  }
  return { text: `${text.slice(0, start)}${mark}${sel}${mark}${text.slice(end)}`, start: start + mark.length, end: end + mark.length }
}

/**
 * display: mention spans of the reader (and @channel) get data-me, so they stand out. Input is the sanitised body
 * (sanitizeRichText keeps data-mention only), output adds the one attribute.
 */
export function markMentions(html: string, me: string): string {
  return html.replace(/<span data-mention="([A-Za-z0-9_-]{1,64})">/g, (m, id: string) => (id === me || id === 'channel' ? `<span data-mention="${id}" data-me="">` : m))
}

/** user ids mentioned in a body (display only; the server's list is authoritative) */
export function mentionIds(html: string): string[] {
  return [...new Set([...html.matchAll(/data-mention="([A-Za-z0-9_-]{1,64})"/g)].map((m) => m[1]))]
}

/** plain characters of the composer text that count against the limit (what the server counts: the text) */
export function textLength(text: string): number {
  return text.trim().length
}

/* ------------------------------------------------------------------ time */

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", "Monday", "3 March", "3 March 2025" */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export const timeLabel = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** list time: the time today, "Yesterday", or a short date */
export function listTime(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY)
  if (diff === 0) return timeLabel(iso)
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** same day as the previous message? (date separators) */
export const sameDay = (a: string, b: string): boolean => startOfDay(new Date(a)) === startOfDay(new Date(b))

/** a message continues the previous one (same sender within 5 minutes, both ordinary messages) */
export function continues(prev: { sender: { id: string } | null; createdOn: string; kind: string } | undefined, m: { sender: { id: string } | null; createdOn: string; kind: string }): boolean {
  if (!prev || prev.kind !== 'message' || m.kind !== 'message' || !prev.sender || !m.sender) return false
  return prev.sender.id === m.sender.id && Date.parse(m.createdOn) - Date.parse(prev.createdOn) < 5 * 60_000 && sameDay(prev.createdOn, m.createdOn)
}

export function fileSize(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '')).toUpperCase()
}
