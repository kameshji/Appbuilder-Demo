/**
 * The note sanitiser against a corpus of hostile inputs (P3-N): whatever comes in, what comes out contains only
 * NOTE_TAGS with their allowed attributes, no script, no event handler, no javascript: / data: / vbscript: URL, no style,
 * no SVG or iframe, balanced tags, and it is idempotent. The same function cleans every note Body on the server.
 */
import { describe, expect, it } from 'vitest'
import { MAX_DEPTH, NOTE_TAGS, noteImageIds, noteMentionIds, noteRecordRefs, noteToPlain, parseNoteHtml, sanitizeNoteHtml, serializeNote } from './sanitize'

const S = sanitizeNoteHtml

/** every tag in the output is allowed, every attribute is one of the allowed ones with a safe value, tags balance */
function assertSafe(out: string) {
  const allowedAttrs: Record<string, RegExp> = {
    href: /^(https?:\/\/|mailto:|#)/i, rel: /^noopener noreferrer$/, target: /^_blank$/, 'data-mention': /^[A-Za-z0-9_-]+$/, 'data-record': /^[A-Za-z0-9_]+:[A-Za-z0-9_-]+$/,
    'data-type': /^checklist$/, 'data-checked': /^(true|false)$/, 'data-att': /^att_[A-Za-z0-9_-]+$/,
  }
  const stack: string[] = []
  for (const m of out.matchAll(/<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*>/g)) {
    const [, close, tag, attrs] = m
    expect(NOTE_TAGS as readonly string[], `tag ${tag} in ${out}`).toContain(tag)
    for (const a of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      expect(Object.keys(allowedAttrs), `attribute ${a[1]} in ${out}`).toContain(a[1])
      expect(a[2], `${a[1]} value in ${out}`).toMatch(allowedAttrs[a[1]])
    }
    if (tag === 'br' || tag === 'img') continue
    if (close) expect(stack.pop(), `unbalanced </${tag}> in ${out}`).toBe(tag)
    else stack.push(tag)
  }
  expect(stack, `unclosed in ${out}`).toEqual([])
  // nothing that looks like markup survives outside the allowed tags
  const stripped = out.replace(/<\/?(p|br|b|i|u|s|ul|ol|li|a|code|pre|blockquote|span|h1|h2|h3|table|thead|tbody|tr|th|td|img)(\s+[a-z-]+="[^"]*")*\s*>/g, '')
  expect(stripped, out).not.toMatch(/[<>]/)
  // the markup (text is escaped, so a "<" in text can never start a tag)
  const markup = (out.match(/<[^>]*>/g) ?? []).join('')
  expect(markup).not.toMatch(/\bon[a-z]+\s*=/i)
  expect(markup).not.toMatch(/javascript:|vbscript:|data:|style=/i)
  expect(out).not.toMatch(/<(script|style|iframe|svg|math|object|embed|template|form|input|textarea|link|meta|base)/i)
  // idempotent
  expect(S(out)).toBe(out)
}

const CORPUS: string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<script>document.write("<p>x</p>")</script><p>after</p>',
  '<img src=x onerror=alert(1)>',
  '<img src="javascript:alert(1)">',
  '<img data-att="att_ok" src=x onerror="alert(1)">',
  '<img data-att="att_ok&quot; onerror=&quot;alert(1)">',
  '<p onclick="alert(1)" style="color:red">click</p>',
  '<b onmouseover=alert(1)>x</b>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="jav&#x61;script:alert(1)">x</a>',
  '<a href="jav&#97;script&#58;alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="https://ok.example/&quot; onclick=&quot;alert(1)">x</a>',
  '<a href="https://ok.example/" onclick="alert(1)">ok</a>',
  '<a href=\'https://ok.example/x>y\' onfocus=alert(1) autofocus>z</a>',
  '<svg><script>alert(1)</script></svg>',
  '<svg onload=alert(1)><circle r="5"/></svg>after',
  '<svg><svg><g/></svg><p>still svg</p></svg><p>out</p>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>">',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<link rel=stylesheet href=//evil.example/x.css><meta http-equiv=refresh content="0;url=javascript:alert(1)"><base href=//evil.example/>',
  '<form action=//evil.example><input name=x><button>go</button></form>',
  '<template><script>alert(1)</script></template>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<!-- <script>alert(1)</script> -->text',
  '<!--><script>alert(1)</script>-->',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<?xml version="1.0"?><p>x</p>',
  '<!DOCTYPE html><html><head><title>t</title></head><body><p>b</p></body></html>',
  '<p>unclosed <b>bold <i>italic',
  '</p></b>stray closers</i></ul>',
  '<b><p>block in inline</p></b>',
  '<p><p><p>nested paragraphs',
  '<ul>text in a list<li>item</li><p>para in list</p></ul>',
  '<li>orphan item</li>',
  '<table><tr><td>a<table><tr><td>nested</td></tr></table></td></tr></table>',
  '<table>stray<tr>row text<td>cell</td></tr><td>no row</td></table>',
  '<td>cell without a table</td><tr><th>head</th></tr>',
  '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td><ul><li>in cell</li></ul></td></tr></tbody></table>',
  '<span data-mention="u1" onclick=x>@Asha<script>alert(1)</script><b>bold</b></span>',
  '<span data-mention="u1&quot; onclick=&quot;x">@Asha</span>',
  '<span data-record="tbl_orders:9f0c">Secret customer name</span>',
  '<span data-record="bad record">x</span>',
  '<ul data-type="checklist" onclick=x><li data-checked="true">done</li><li data-checked="yes">bad</li></ul>',
  '<a href="#u-notes?n=1"><a href="https://x.example">nested link</a></a>',
  '<h1>one</h1><h4>four</h4><h6>six</h6>',
  '<div><div>divs</div></div>',
  '<font color=red face="x" onmouseover=x>font</font>',
  '<p title="a>b" onclick="x">attribute with a bracket</p>',
  '<p a=1 b=2 c=3 d=4 e=5 f=6 g=7 h=8 i=9 j=10 k=11 l=12 m=13 n=14 o=15 p=16 q=17 r=18 s=19 t=20 u=21 v=22 w=23 x=24 y=25 z=26 aa=1 bb=2 cc=3 dd=4 ee=5 ff=6 gg=7>many attributes</p>',
  '<<p>>double brackets<</p>>',
  '< script>not a tag</ script>',
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  '<p>&#0;&#x0;&#xD800;&#1114112;&#x1F600;</p>',
  '<p>\u0000nul\u0001ctrl sep</p>',
  '<p>a < b and c > d & e</p>',
  '<b',
  '<a href="https://x.example',
  '<p title="unterminated',
  '<img',
  '<',
  '',
  '<marquee onstart=alert(1)>m</marquee><blink>b</blink><details open ontoggle=alert(1)>d</details>',
  '<video><source onerror=alert(1)></video><audio src=x onerror=alert(1)>',
  '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
  '<a href="mailto:a@example.com">mail</a><a href="https://ok.example/path?q=1&amp;r=2">ok</a>',
]

describe('the note sanitiser: hostile corpus', () => {
  for (const [i, input] of CORPUS.entries()) {
    it(`case ${i + 1}: ${JSON.stringify(input).slice(0, 70)}`, () => assertSafe(S(input)))
  }

  it('drops scripts, styles, svg and iframes WITH their content', () => {
    expect(S('<p>a</p><script>alert("x")</script><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(S('<style>p{color:red}</style>x')).toBe('x')
    expect(S('<svg><text>in svg</text></svg>after')).toBe('after')
    expect(S('<svg><svg><g/></svg><p>still svg</p></svg><p>out</p>')).toBe('<p>out</p>')
    expect(S('<iframe src="x">inside</iframe>after')).toBe('after')
    expect(S('<template><p>t</p></template>z')).toBe('z')
  })

  it('keeps safe links, drops unsafe ones (the text stays)', () => {
    expect(S('<a href="https://example.com/a?b=1">x</a>')).toBe('<a href="https://example.com/a?b=1" rel="noopener noreferrer" target="_blank">x</a>')
    expect(S('<a href="#u-notes?n=abc">in app</a>')).toBe('<a href="#u-notes?n=abc">in app</a>')
    expect(S('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(S('<a href="jav&#x61;script:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(S('<a href="data:text/html,x">x</a>')).toBe('<a>x</a>')
  })

  it('images keep only a file id; anything else drops the image', () => {
    expect(S('<img data-att="att_abc" src="x" alt="y" onerror="z">')).toBe('<img data-att="att_abc">')
    expect(S('<img src="https://example.com/x.png">')).toBe('')
    expect(S('<img data-att="javascript:x">')).toBe('')
    expect(noteImageIds('<p><img data-att="att_a"><img data-att="att_b"><img data-att="att_a"></p>')).toEqual(['att_a', 'att_b'])
  })

  it('mentions keep the user id and plain text; record cards are stored empty (no record value in a note)', () => {
    expect(S('<span data-mention="user_1"><b>@Asha</b></span>')).toBe('<span data-mention="user_1">@Asha</span>')
    expect(S('<span data-record="tbl_orders:9f0c">Secret customer</span>')).toBe('<span data-record="tbl_orders:9f0c"></span>')
    expect(noteMentionIds('<p><span data-mention="a">@A</span> <span data-mention="b">@B</span><span data-mention="a">@A</span></p>')).toEqual(['a', 'b'])
    expect(noteRecordRefs('<p><span data-record="t:1"></span><span data-record="t:2"></span></p>')).toEqual(['t:1', 't:2'])
    expect(S('<span class="x">plain span</span>')).toBe('plain span')
  })

  it('checklists, headings, tables and aliases', () => {
    expect(S('<ul data-type="checklist"><li data-checked="true">a</li><li data-checked="false">b</li></ul>')).toBe('<ul data-type="checklist"><li data-checked="true">a</li><li data-checked="false">b</li></ul>')
    expect(S('<h1>a</h1><h2>b</h2><h3>c</h3><h5>d</h5>')).toBe('<h1>a</h1><h2>b</h2><h3>c</h3><h3>d</h3>')
    expect(S('<strong>s</strong><em>e</em><del>d</del>')).toBe('<b>s</b><i>e</i><s>d</s>')
    expect(S('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>')).toBe('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>')
  })

  it('repairs nesting: no table in a table, list items in lists, blocks out of inline elements', () => {
    expect(S('<table><tr><td>a<table><tr><td>b</td></tr></table>c</td></tr></table>')).toBe('<table><tr><td>abc</td></tr></table>')
    expect(S('<li>x</li>')).toBe('<p>x</p>')
    expect(S('<ul>t<li>i</li></ul>')).toBe('<ul><li>t</li><li>i</li></ul>')
    expect(S('<b>x<p>y</p></b>')).toBe('<b>x</b><p>y</p>')
    expect(S('<p>a<p>b')).toBe('<p>a</p><p>b</p>')
    expect(S('<td>c</td>')).toBe('c')
    expect(S('<table><td>c</td></table>')).toBe('<table><tr><td>c</td></tr></table>')
    expect(S('<p>unclosed <b>bold')).toBe('<p>unclosed <b>bold</b></p>')
  })

  it('escapes text: entities are decoded once and written back safely', () => {
    expect(S('<p>&lt;script&gt;</p>')).toBe('<p>&lt;script&gt;</p>')
    expect(S('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(S('<p>&#x1F600; &rupee; &unknown;</p>')).toBe('<p>\u{1F600} ₹ &amp;unknown;</p>')
    expect(S('<p>&#0;x&#xD800;</p>')).toBe('<p>x</p>')
  })

  it('keeps Devanagari and other scripts as they are', () => {
    const hi = '<p>नमस्ते <b>दुनिया</b> — क्षत्रिय</p>'
    expect(S(hi)).toBe(hi)
    expect(noteToPlain(hi)).toBe('नमस्ते दुनिया — क्षत्रिय')
  })

  it('limits nesting depth and survives huge inputs in linear time', () => {
    const deep = '<b>'.repeat(5000) + 'x' + '</b>'.repeat(5000)
    const out = S(deep)
    assertSafe(out)
    expect((out.match(/<b>/g) ?? []).length).toBeLessThanOrEqual(MAX_DEPTH)
    const lists = '<ul><li>'.repeat(3000) + 'y'
    assertSafe(S(lists))
    const big = '<p>' + 'x'.repeat(400_000) + '</p>' + '<script>'.repeat(10_000)
    const t = Date.now()
    const outBig = S(big)
    expect(Date.now() - t).toBeLessThan(5000)
    expect(outBig.length).toBe(400_007)
    const many = '<p onclick=x>a</p>'.repeat(20_000)
    expect(S(many)).toBe('<p>a</p>'.repeat(20_000))
  })

  it('is idempotent on well-formed notes and round-trips the tree', () => {
    const note = '<h2>Visit</h2><p>Met <span data-mention="u_asha">@Asha</span> about <span data-record="tbl_orders:o1"></span>.</p><ul data-type="checklist"><li data-checked="false">Call back</li></ul><table><tr><th>Item</th><th>Qty</th></tr><tr><td>Bolts</td><td>40</td></tr></table><p><img data-att="att_photo"></p><blockquote><p>quote</p></blockquote><pre>code</pre>'
    expect(S(note)).toBe(note)
    expect(serializeNote(parseNoteHtml(note))).toBe(note)
    expect(noteToPlain(note)).toContain('Met @Asha about [record].')
  })
})
