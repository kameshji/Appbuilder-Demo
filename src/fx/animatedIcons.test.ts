import { describe, expect, it } from 'vitest'
import catalog from 'react-useanimations/catalog.json'
import { enums } from './index.ts'
import { ANIMATED_ICON_IDS } from './animatedIcons.ts'
import { animatedIconMember } from './enums.ts'
import { err, val } from './testutil.ts'

const exportsOf = (catalog as { export: string; id: string }[]).map((c) => c.export)

describe('AnimatedIcon enum', () => {
  it('has one member per catalog icon and nothing else', () => {
    expect([...ANIMATED_ICON_IDS].sort()).toEqual([...exportsOf].sort())
    expect(enums().AnimatedIcon).toHaveLength(300)
    expect(new Set(enums().AnimatedIcon).size).toBe(300)
  })
  it('every member maps to an existing catalog id', () => {
    const known = new Set(exportsOf)
    for (const m of enums().AnimatedIcon!) {
      const id = m.charAt(0).toLowerCase() + m.slice(1)
      expect(known.has(id), m).toBe(true)
      expect(val(`=AnimatedIcon.${m}`), m).toBe(`anim:${id}`)
    }
    for (const id of ANIMATED_ICON_IDS) expect(enums().AnimatedIcon).toContain(animatedIconMember(id))
  })
  it('evaluates AnimatedIcon.Heart to anim:heart', () => {
    expect(val('=AnimatedIcon.Heart')).toBe('anim:heart')
    expect(val('=AnimatedIcon.Loading2')).toBe('anim:loading2')
    expect(val('=AnimatedIcon.Heart & "!"')).toBe('anim:heart!')
  })
  it('reports unknown members', () => {
    expect(err('=AnimatedIcon.NotThere').message).toBe("AnimatedIcon doesn't have a member called NotThere")
  })
  it('catalog ids are unique, loadable module names', () => {
    expect(new Set(exportsOf).size).toBe(exportsOf.length)
    for (const id of exportsOf) expect(id).toMatch(/^[a-z][A-Za-z0-9]*$/)
  })
})
