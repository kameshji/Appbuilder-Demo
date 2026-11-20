import { describe, expect, it } from 'vitest'
import { readBody, type DomLike } from './dom'

const text = (v: string): DomLike => ({ nodeType: 3, nodeName: '#text', nodeValue: v, childNodes: [] })
const el = (name: string, attrs: Record<string, string>, ...kids: DomLike[]): DomLike => ({
  nodeType: 1, nodeName: name.toUpperCase(), nodeValue: null, childNodes: kids, getAttribute: (a) => (a in attrs ? attrs[a] : null),
})
const root = (...kids: DomLike[]): DomLike => el('div', {}, ...kids)

describe('a quick note: plain text as paragraphs, escaped', () => {
  it('one paragraph per line, markup stays text', async () => {
    const { plainToNote } = await import('./plain')
    expect(plainToNote('Call Asha\n<b>not bold</b> & co\n\n')).toBe('<p>Call Asha</p><p>&lt;b&gt;not bold&lt;/b&gt; &amp; co</p>')
    expect(plainToNote('a\n\nb')).toBe('<p>a</p><p></p><p>b</p>')
  })
})

describe('reading the editor back', () => {
  it('keeps the format, drops what the browser added (styles, fonts, classes, contenteditable)', () => {
    const r = root(
      el('h2', { style: 'color:red' }, text('Visit')),
      el('div', {}, text('Met '), el('span', { 'data-mention': 'u1', contenteditable: 'false', class: 'note-mention' }, text('@Asha')), text(' about '), el('span', { 'data-record': 'tbl_o:1', contenteditable: 'false' }, text('Order for Pune (the reader’s label)'))),
      el('font', { color: 'red' }, text('fonted')),
      el('ul', { 'data-type': 'checklist' }, el('li', { 'data-checked': 'true', onclick: 'x' }, text('done'))),
      el('p', {}, el('img', { 'data-att': 'att_1', src: 'blob:x', alt: 'Image' })),
    )
    expect(readBody(r)).toBe('<h2>Visit</h2><p>Met <span data-mention="u1">@Asha</span> about <span data-record="tbl_o:1"></span></p>fonted<ul data-type="checklist"><li data-checked="true">done</li></ul><p><img data-att="att_1"></p>')
  })
  it('text is escaped, never parsed as markup; an empty editor is an empty note', () => {
    expect(readBody(root(el('p', {}, text('<script>alert(1)</script> & co'))))).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; co</p>')
    expect(readBody(root(el('p', {}, el('br', {}))))).toBe('')
    expect(readBody(root())).toBe('')
  })
  it('a link keeps only a safe address', () => {
    expect(readBody(root(el('a', { href: 'javascript:alert(1)' }, text('x')), el('a', { href: 'https://ok.example/', target: '_self' }, text('ok'))))).toBe('<a>x</a><a href="https://ok.example/" rel="noopener noreferrer" target="_blank">ok</a>')
  })
})
