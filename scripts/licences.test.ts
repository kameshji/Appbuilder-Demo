// Tests for the licence classifier shared by `npm run licences` and `npm run notices`.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script modules have no type declarations
import { classify, licenceOf, reliesOnChoice, versionInRange, findException } from './lib/licences.mjs'
// @ts-expect-error plain .mjs script modules have no type declarations
import { denyReasonForName, findForbiddenImports } from './check-licences.mjs'

describe('classify', () => {
  it.each(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'PSF-2.0', 'Zlib', 'CC-BY-4.0', 'MPL-2.0'])(
    'allows %s',
    (id) => expect(classify(id).status).toBe('allowed'),
  )

  it('is case-insensitive for SPDX ids', () => expect(classify('mit').status).toBe('allowed'))

  it('allows a dual licence when one side is allowed and records which', () => {
    const c = classify('(MIT OR GPL-3.0-or-later)')
    expect(c.status).toBe('allowed')
    expect(c.relied).toEqual(['MIT'])
    expect(reliesOnChoice(c)).toBe(true)
  })

  it('relies on the allowed side wherever it is written', () => {
    expect(classify('GPL-2.0 OR Apache-2.0').relied).toEqual(['Apache-2.0'])
    expect(classify('(AGPL-3.0 OR (BSD-3-Clause OR LGPL-2.1))').relied).toEqual(['BSD-3-Clause'])
  })

  it('refuses a dual licence when no side is allowed', () => {
    expect(classify('GPL-2.0 OR LGPL-3.0').status).toBe('denied')
  })

  it('needs both sides of AND', () => {
    expect(classify('MIT AND Zlib').status).toBe('allowed')
    expect(classify('MIT AND CC-BY-3.0').status).toBe('unknown')
    expect(classify('MIT AND GPL-3.0').status).toBe('denied')
  })

  it('judges "X WITH exception" on X', () => {
    expect(classify('Apache-2.0 WITH LLVM-exception').status).toBe('allowed')
    expect(classify('GPL-2.0-only WITH Classpath-exception-2.0').status).toBe('denied')
  })

  it.each([
    ['AGPL-3.0-only', /AGPL/],
    ['GPL-3.0', /GPL/],
    ['LGPL-2.1', /LGPL/],
    ['SSPL-1.0', /SSPL/],
    ['BUSL-1.1', /BUSL/],
    ['Elastic-2.0', /Elastic/],
    ['Commons Clause', /Commons/],
    ['Sustainable Use License', /Sustainable/],
    ['fair-code', /fair-code/],
    ['UNLICENSED', /UNLICENSED/],
  ])('denies %s', (expr, why) => {
    const c = classify(expr)
    expect(c.status).toBe('denied')
    expect(c.reason).toMatch(why)
  })

  it('treats "SEE LICENSE IN ..." as unresolved, not allowed', () => {
    const c = classify('SEE LICENSE IN LICENSE.md')
    expect(c.status).toBe('unknown')
    expect(c.reason).toMatch(/file reference/)
  })

  it('denies a missing licence', () => {
    for (const v of [undefined, null, '', '   ']) expect(classify(v).status).toBe('denied')
    expect(licenceOf({})).toBe('UNKNOWN')
  })

  it('does not accept unlisted ids or malformed expressions', () => {
    expect(classify('WTFPL').status).toBe('unknown')
    expect(classify('(MIT').status).not.toBe('allowed')
    expect(classify('MIT OR').status).not.toBe('allowed')
  })

  it('flags MPL-2.0 and CC-BY-4.0 with their conditions', () => {
    expect(classify('MPL-2.0').notes[0]).toMatch(/do not modify in place/)
    expect(classify('CC-BY-4.0').notes[0]).toMatch(/data and fonts only/)
    expect(classify('MIT').notes).toEqual([])
  })
})

describe('licenceOf (package.json shapes)', () => {
  it('reads strings, {type} objects and legacy arrays', () => {
    expect(licenceOf({ license: 'MIT' })).toBe('MIT')
    expect(licenceOf({ license: { type: 'ISC', url: 'x' } })).toBe('ISC')
    expect(licenceOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(licenceOf({ license: ['MIT', 'GPL-3.0'] })).toBe('MIT OR GPL-3.0')
  })
  it('classifies the array forms', () => {
    expect(classify(licenceOf({ licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }] })).relied).toEqual(['MIT'])
    expect(classify(licenceOf({ licenses: [{ type: 'GPL-2.0' }] })).status).toBe('denied')
  })
})

describe('exceptions', () => {
  const list = [{ name: 'foo', versions: '>=1.2.0 <2.0.0', reason: 'r', approvedBy: 'x' }]
  it('matches version ranges', () => {
    expect(versionInRange('1.5.0', '^1.2.0')).toBe(true)
    expect(versionInRange('2.0.0', '^1.2.0')).toBe(false)
    expect(versionInRange('1.2.9', '~1.2.0')).toBe(true)
    expect(versionInRange('1.3.0', '~1.2.0')).toBe(false)
    expect(versionInRange('3.1.4', '*')).toBe(true)
    expect(versionInRange('1.9.9', '1.x')).toBe(true)
    expect(versionInRange('1.0.0', '1.0.0 || 2.0.0')).toBe(true)
  })
  it('finds an exception by name and version', () => {
    expect(findException(list, 'foo', '1.4.0')).toBe(list[0])
    expect(findException(list, 'foo', '2.0.0')).toBeUndefined()
    expect(findException(list, 'bar', '1.4.0')).toBeUndefined()
  })
})

describe('do-not-embed names and forbidden imports', () => {
  it.each(['n8n', 'n8n-core', '@n8n/db', 'nocodb', 'nocodb-sdk', '@directus/sdk', 'handsontable', 'tldraw', '@tldraw/editor', 'pm2', '@univerjs-pro/sheets'])(
    'denies package %s',
    (name) => expect(denyReasonForName(name)).toBeTruthy(),
  )
  it('does not deny look-alikes', () => {
    for (const n of ['n8nx', 'react', 'pm2-like', 'handsontable-lite']) expect(denyReasonForName(n)).toBeNull()
  })
  it('finds imports of non-open edition paths', () => {
    const src = [
      "import a from 'lib/ee/feature'",
      "export * from '../enterprise/x'",
      "const b = await import('@univerjs-pro/sheets')",
      "const c = require('foo/enterprise')",
      "import ok from 'react'",
      "import fine from './employee/list'",
    ].join('\n')
    expect(findForbiddenImports(src).map((h: { specifier: string }) => h.specifier)).toEqual([
      'lib/ee/feature',
      '../enterprise/x',
      '@univerjs-pro/sheets',
      'foo/enterprise',
    ])
  })
})
