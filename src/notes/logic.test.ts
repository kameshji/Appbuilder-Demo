import { describe, expect, it } from 'vitest'
import { addedMentions, diffShares, highlight, isEmptyDiff, matchesAll, mentionQuery, snippet } from './logic'
import { blocksOf, lcsPairs, mergeNotes } from './merge'
import { NoteConflict, createAutosave, type AutosaveSnapshot, type NoteDraft } from './autosave'

describe('mentions', () => {
  it('finds the @word being typed, in any script', () => {
    expect(mentionQuery('Ask @as')).toBe('as')
    expect(mentionQuery('@')).toBe('')
    expect(mentionQuery('mail a@b')).toBeNull()
    expect(mentionQuery('पूछो @आशा')).toBe('आशा')
    expect(mentionQuery('(@ra')).toBe('ra')
    expect(mentionQuery('@ra done')).toBeNull()
  })
  it('only newly added mentions notify', () => {
    const a = '<p><span data-mention="u1">@A</span></p>'
    const b = '<p><span data-mention="u1">@A</span> <span data-mention="u2">@B</span></p>'
    expect(addedMentions(a, b)).toEqual(['u2'])
    expect(addedMentions(b, a)).toEqual([])
    expect(addedMentions('', a)).toEqual(['u1'])
  })
})

describe('share diffing', () => {
  const cur = [
    { id: 's1', PrincipalType: 'user' as const, Principal: 'ann', Access: 'read' as const },
    { id: 's2', PrincipalType: 'team' as const, Principal: 'qa', Access: 'edit' as const },
    { id: 's3', PrincipalType: 'user' as const, Principal: 'bob', Access: 'read' as const },
    { id: 's4', PrincipalType: 'user' as const, Principal: 'bob', Access: 'read' as const },
  ]
  it('adds, changes and removes the minimum; a duplicate row is removed', () => {
    const d = diffShares(cur, [
      { PrincipalType: 'user', Principal: 'ann', Access: 'edit' },
      { PrincipalType: 'user', Principal: 'bob', Access: 'read' },
      { PrincipalType: 'team', Principal: 'ops', Access: 'read' },
    ])
    expect(d.add).toEqual([{ PrincipalType: 'team', Principal: 'ops', Access: 'read' }])
    expect(d.change).toEqual([{ id: 's1', Access: 'edit' }])
    expect(d.remove.sort()).toEqual(['s2', 's4'])
  })
  it('what is added carries only the share columns (not display fields)', () => {
    const d = diffShares([], [{ PrincipalType: 'user', Principal: 'x', Access: 'edit', name: 'Xi' } as never])
    expect(d.add).toEqual([{ PrincipalType: 'user', Principal: 'x', Access: 'edit' }])
  })
  it('a user and a team with the same id are different principals; no change is an empty diff', () => {
    const d = diffShares([{ id: 'x', PrincipalType: 'user', Principal: 'p', Access: 'read' }], [{ PrincipalType: 'team', Principal: 'p', Access: 'read' }])
    expect(d.add).toHaveLength(1)
    expect(d.remove).toEqual(['x'])
    expect(isEmptyDiff(diffShares(cur.slice(0, 3), cur.slice(0, 3)))).toBe(true)
  })
})

describe('search highlighting', () => {
  it('marks every word, case-insensitive, in any script', () => {
    expect(highlight('Bolt order for Pune', 'pune bolt')).toEqual([{ text: 'Bolt', hit: true }, { text: ' order for ', hit: false }, { text: 'Pune', hit: true }])
    expect(highlight('नमस्ते दुनिया', 'दुनिया')).toEqual([{ text: 'नमस्ते ', hit: false }, { text: 'दुनिया', hit: true }])
    expect(highlight('a+b (c)', '(c)')).toEqual([{ text: 'a+b ', hit: false }, { text: '(c)', hit: true }])
    expect(highlight('plain', '')).toEqual([{ text: 'plain', hit: false }])
  })
  it('a snippet around the first match, on word boundaries', () => {
    const long = `${'word '.repeat(60)}the needle is here ${'tail '.repeat(60)}`
    const s = snippet(long, 'needle', 80)
    expect(s).toContain('needle')
    expect(s.startsWith('...')).toBe(true)
    expect(s.endsWith('...')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(90)
    expect(snippet('short text', 'x')).toBe('short text')
  })
  it('every word must match the title or the text', () => {
    expect(matchesAll('Plant visit', 'bolts and nuts', 'plant nuts')).toBe(true)
    expect(matchesAll('Plant visit', 'bolts', 'plant nuts')).toBe(false)
    expect(matchesAll('x', 'y', '  ')).toBe(true)
  })
})

describe('three-way merge of note blocks', () => {
  const base = '<p>one</p><p>two</p><p>three</p>'
  it('edits of different paragraphs merge', () => {
    const mine = '<p>one!</p><p>two</p><p>three</p>'
    const theirs = '<p>one</p><p>two</p><p>three?</p>'
    expect(mergeNotes(base, mine, theirs)).toEqual({ ok: true, html: '<p>one!</p><p>two</p><p>three?</p>' })
  })
  it('additions on both sides at different places merge; the same edit on both sides is taken once', () => {
    expect(mergeNotes(base, '<p>zero</p>' + base, base + '<p>four</p>')).toEqual({ ok: true, html: '<p>zero</p>' + base + '<p>four</p>' })
    expect(mergeNotes(base, '<p>one</p><p>2</p><p>three</p>', '<p>one</p><p>2</p><p>three</p>')).toEqual({ ok: true, html: '<p>one</p><p>2</p><p>three</p>' })
  })
  it('the same paragraph changed differently is a conflict (the person chooses)', () => {
    expect(mergeNotes(base, '<p>one</p><p>TWO</p><p>three</p>', '<p>one</p><p>deux</p><p>three</p>')).toEqual({ ok: false, reason: 'overlap' })
  })
  it('a deletion on one side and an unrelated edit on the other merge', () => {
    expect(mergeNotes(base, '<p>one</p><p>three</p>', '<p>one</p><p>two</p><p>three</p><p>x</p>')).toEqual({ ok: true, html: '<p>one</p><p>three</p><p>x</p>' })
  })
  it('blocks and LCS basics', () => {
    expect(blocksOf('<h1>a</h1>text<ul><li>x</li></ul>')).toEqual(['<h1>a</h1>', 'text', '<ul><li>x</li></ul>'])
    expect(lcsPairs(['a', 'b', 'c'], ['a', 'c'])).toEqual([[0, 0], [2, 1]])
  })
})

describe('autosave', () => {
  function harness(save: (d: NoteDraft, v: string) => Promise<string>) {
    let now = 0
    const timers: { at: number; fn: () => void; id: number }[] = []
    let seq = 0
    const states: AutosaveSnapshot[] = []
    const a = createAutosave({ subject: 'T', body: '<p>a</p>' }, 'v0', {
      delayMs: 800, maxWaitMs: 5000, save,
      setTimer: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id },
      clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
      now: () => now,
      onChange: (s) => states.push(s),
    })
    const advance = async (ms: number) => {
      const end = now + ms
      for (;;) {
        timers.sort((x, y) => x.at - y.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
        await new Promise((r) => setTimeout(r, 0))
      }
      now = end
      await new Promise((r) => setTimeout(r, 0))
    }
    return { a, advance, states, pending: () => timers.length }
  }

  it('saves once after a pause in typing, with the version it started from', async () => {
    const calls: [NoteDraft, string][] = []
    const h = harness(async (d, v) => { calls.push([d, v]); return `v${calls.length}` })
    h.a.change({ body: '<p>ab</p>' })
    await h.advance(500)
    h.a.change({ body: '<p>abc</p>' })
    await h.advance(500)
    expect(calls).toHaveLength(0)
    await h.advance(400)
    expect(calls).toEqual([[{ subject: 'T', body: '<p>abc</p>' }, 'v0']])
    expect(h.a.snapshot().state).toBe('saved')
    h.a.change({ subject: 'T2' })
    await h.advance(1000)
    expect(calls[1]).toEqual([{ subject: 'T2', body: '<p>abc</p>' }, 'v1'])
  })

  it('typing without a pause still saves within maxWait', async () => {
    let n = 0
    const h = harness(async () => `v${++n}`)
    for (let i = 0; i < 20; i++) {
      h.a.change({ body: `<p>${'x'.repeat(i + 2)}</p>` })
      await h.advance(300)
    }
    expect(n).toBeGreaterThanOrEqual(1)
  })

  it('edits during a save are saved after it; flush saves at once; undoing an edit needs no save', async () => {
    let release: (() => void) | null = null
    const calls: string[] = []
    const h = harness((d) => new Promise((r) => { calls.push(d.body); release = () => r(`v${calls.length}`) }))
    h.a.change({ body: '<p>1</p>' })
    await h.advance(800)
    expect(h.a.snapshot().state).toBe('saving')
    h.a.change({ body: '<p>2</p>' })
    release!()
    await h.advance(0)
    expect(h.a.snapshot().state).toBe('dirty')
    await h.advance(800)
    expect(calls).toEqual(['<p>1</p>', '<p>2</p>'])
    release!()
    await h.advance(0)
    h.a.change({ body: '<p>3</p>' })
    const f = h.a.flush()
    await h.advance(0)
    release!()
    await f
    expect(calls).toEqual(['<p>1</p>', '<p>2</p>', '<p>3</p>'])
    h.a.change({ body: '<p>4</p>' })
    h.a.change({ body: '<p>3</p>' })
    expect(h.a.snapshot().state).toBe('saved')
    await h.advance(2000)
    expect(calls).toHaveLength(3)
  })

  it('a stale version stops autosave and holds the other version until the person chooses', async () => {
    let n = 0
    const saves: string[] = []
    const h = harness(async (d, v) => {
      saves.push(`${d.body}@${v}`)
      if (v === 'v0' && n++ === 0) throw new NoteConflict({ subject: 'T', body: '<p>theirs</p>', version: 'v9', by: 'Bo' })
      return 'v10'
    })
    h.a.change({ body: '<p>mine</p>' })
    await h.advance(800)
    const s = h.a.snapshot()
    expect(s.state).toBe('conflict')
    expect(s.conflict).toMatchObject({ body: '<p>theirs</p>', version: 'v9', by: 'Bo' })
    expect(s.saved.body).toBe('<p>a</p>') // the merge base
    h.a.change({ body: '<p>mine more</p>' })
    await h.advance(5000)
    expect(saves).toHaveLength(1) // nothing overwrites while the choice is open
    h.a.resolve({ subject: 'T', body: '<p>mine more</p>' })
    await h.advance(0)
    expect(saves[1]).toBe('<p>mine more</p>@v9')
    expect(h.a.snapshot().state).toBe('saved')
  })

  it('an error stops autosave until it is retried', async () => {
    let fail = true
    const saves: string[] = []
    const h = harness(async (_d, v) => {
      saves.push(v)
      if (fail) throw new Error('The server cannot be reached.')
      return 'v1'
    })
    h.a.change({ body: '<p>x</p>' })
    await h.advance(800)
    expect(h.a.snapshot()).toMatchObject({ state: 'error', error: 'The server cannot be reached.' })
    fail = false
    h.a.retry()
    await h.advance(800)
    expect(h.a.snapshot().state).toBe('saved')
    expect(saves).toEqual(['v0', 'v0'])
  })

  it('adopt: a version saved elsewhere replaces a clean tab, never one with unsaved edits', async () => {
    const h = harness(async () => 'v1')
    expect(h.a.adopt({ subject: 'T', body: '<p>theirs</p>', version: 'v7' })).toBe(true)
    expect(h.a.current().body).toBe('<p>theirs</p>')
    expect(h.a.snapshot()).toMatchObject({ state: 'saved', version: 'v7' })
    h.a.change({ body: '<p>mine</p>' })
    expect(h.a.adopt({ subject: 'T', body: '<p>other</p>', version: 'v8' })).toBe(false)
    expect(h.a.current().body).toBe('<p>mine</p>')
  })

  it('rebase: a version change without a body change is taken quietly; otherwise it is a conflict', () => {
    const h = harness(async () => 'v1')
    expect(h.a.rebase({ subject: 'T', body: '<p>a</p>', version: 'v5' })).toBe(true)
    expect(h.a.snapshot().version).toBe('v5')
    expect(h.a.rebase({ subject: 'T', body: '<p>changed</p>', version: 'v6' })).toBe(false)
    expect(h.a.snapshot().state).toBe('conflict')
  })
})
