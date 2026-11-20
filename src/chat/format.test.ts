import { describe, expect, it } from 'vitest'
import { sanitizeRichText } from '@/platform/system-tables'
import {
  bodyToText, composeBody, continues, dayLabel, fileSize, initials, inline, insertMention, liveMentions, markMentions, mentionIds, mentionQuery,
  wrapSelection,
} from './format'

const M = (o: Record<string, string>) => new Map(Object.entries(o))

describe('composer text -> rich text (the comment subset)', () => {
  it('paragraphs per line, HTML escaped', () => {
    expect(composeBody('hello\nworld')).toBe('<p>hello</p><p>world</p>')
    expect(composeBody('<script>alert(1)</script> & "x"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "x"</p>')
    expect(composeBody('\n\n hi \n\n')).toBe('<p> hi </p>')
  })
  it('bold, italic, strike, code; marks need word edges', () => {
    expect(inline('*bold* and _it_ and ~gone~', new Map())).toBe('<b>bold</b> and <i>it</i> and <s>gone</s>')
    expect(inline('a `x *y* <z>` b', new Map())).toBe('a <code>x *y* &lt;z&gt;</code> b')
    expect(inline('snake_case_name and 2*3*4', new Map())).toBe('snake_case_name and 2*3*4')
    expect(inline('* not bold *', new Map())).toBe('* not bold *')
    expect(inline('(*yes*)', new Map())).toBe('(<b>yes</b>)')
  })
  it('links: bare URLs (trailing punctuation outside) and [text](url); never javascript:', () => {
    expect(inline('see https://example.com/a?b=1.', new Map())).toBe('see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a>.')
    expect(inline('[the docs](https://example.com/x_y)', new Map())).toBe('<a href="https://example.com/x_y">the docs</a>')
    expect(inline('[x](javascript:alert(1))', new Map())).toBe('[x](javascript:alert(1))')
  })
  it('lists, numbered lists, quotes and code blocks', () => {
    expect(composeBody('- one\n- two\nafter')).toBe('<ul><li>one</li><li>two</li></ul><p>after</p>')
    expect(composeBody('1. a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(composeBody('> said\n> this')).toBe('<blockquote>said<br>this</blockquote>')
    expect(composeBody('```\nconst a = 1 < 2\n```')).toBe('<pre>const a = 1 &lt; 2</pre>')
    expect(composeBody('```one```')).toBe('<pre>one</pre>')
  })
  it('mentions become spans with the picked user id, longest names first; @channel', () => {
    const html = composeBody('@Asha Rao and @Asha, @channel', M({ Asha: 'u1', 'Asha Rao': 'u2', channel: 'channel' }))
    expect(html).toBe('<p><span data-mention="u2">@Asha Rao</span> and <span data-mention="u1">@Asha</span>, <span data-mention="channel">@channel</span></p>')
    expect(mentionIds(html)).toEqual(['u2', 'u1', 'channel'])
    // the server's sanitiser keeps exactly this
    expect(sanitizeRichText(html)).toBe(html)
  })
  it('everything it writes survives the server sanitiser unchanged (apart from link attributes)', () => {
    const html = composeBody('*b* _i_ ~s~ `c`\n- l\n1. n\n> q\n```\npre\n```\nhttps://x.example', M({ Ravi: 'u9' }))
    expect(sanitizeRichText(html).replace(/ rel="noopener noreferrer" target="_blank"/g, '')).toBe(html)
  })
})

describe('rich text -> composer text (editing)', () => {
  it('round-trips what the composer writes, with its mentions', () => {
    for (const text of ['plain', '*bold* _it_ ~s~ `code`', '- a\n- b', '1. a\n2. b', '> q1\n> q2', '```\nx < 1\ny\n```', 'see https://example.com and [docs](https://example.com/d)', 'hi @Asha Rao']) {
      const mentions = M({ 'Asha Rao': 'u2' })
      const html = sanitizeRichText(composeBody(text, mentions))
      const back = bodyToText(html)
      expect(composeBody(back.text, back.mentions), text).toBe(composeBody(text, mentions))
    }
    expect(bodyToText('<p><span data-mention="u2">@Asha Rao</span> hi</p>').mentions.get('Asha Rao')).toBe('u2')
  })
})

describe('the mention being typed', () => {
  it('finds "@que" before the caret, at a word start; Devanagari names too', () => {
    expect(mentionQuery('hello @as', 9)).toEqual({ q: 'as', at: 6 })
    expect(mentionQuery('@', 1)).toEqual({ q: '', at: 0 })
    expect(mentionQuery('mail@example', 12)).toBeNull()
    expect(mentionQuery('नमस्ते @रवि', 11)).toEqual({ q: 'रवि', at: 7 })
    expect(mentionQuery('done @x ', 8)).toBeNull()
  })
  it('inserts the picked name and drops mentions whose text was removed', () => {
    expect(insertMention('hi @as there', 3, 'as', 'Asha Rao')).toEqual({ text: 'hi @Asha Rao there', caret: 13 })
    expect([...liveMentions('hi @Asha', M({ Asha: 'u1', Ravi: 'u2' })).keys()]).toEqual(['Asha'])
  })
  it('marks my mentions and @channel for display only', () => {
    expect(markMentions('<span data-mention="me">@Me</span><span data-mention="u2">@R</span><span data-mention="channel">@channel</span>', 'me'))
      .toBe('<span data-mention="me" data-me="">@Me</span><span data-mention="u2">@R</span><span data-mention="channel" data-me="">@channel</span>')
  })
})

describe('shortcuts and display helpers', () => {
  it('Ctrl+B wraps and unwraps the selection', () => {
    expect(wrapSelection('make bold here', 5, 9, '*')).toEqual({ text: 'make *bold* here', start: 6, end: 10 })
    expect(wrapSelection('make *bold* here', 5, 11, '*')).toEqual({ text: 'make bold here', start: 5, end: 9 })
  })
  it('day labels, grouping, sizes, initials', () => {
    const now = new Date(2026, 10, 20, 15, 0)
    expect(dayLabel(new Date(2026, 10, 20, 9).toISOString(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 19, 23).toISOString(), now)).toBe('Yesterday')
    const a = { sender: { id: 'u1' }, createdOn: new Date(2026, 10, 20, 9, 0).toISOString(), kind: 'message' }
    expect(continues(a, { ...a, createdOn: new Date(2026, 10, 20, 9, 3).toISOString() })).toBe(true)
    expect(continues(a, { ...a, createdOn: new Date(2026, 10, 20, 9, 9).toISOString() })).toBe(false)
    expect(continues(a, { ...a, sender: { id: 'u2' } })).toBe(false)
    expect(continues(a, { ...a, kind: 'system' })).toBe(false)
    expect(fileSize(500)).toBe('1 KB')
    expect(fileSize(3 * 1_048_576)).toBe('3.0 MB')
    expect(initials('Asha Rao')).toBe('AR')
    expect(initials('')).toBe('?')
  })
})
