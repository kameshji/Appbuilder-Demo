import { describe, expect, it } from 'vitest'
import { frameChoices, frameLayout, frameCaption, initialFrame, screenSize, MIN_FRAME_SCALE } from './phoneFrame'

describe('phone preview frames', () => {
  it('has no frame for desktop designs', () => {
    expect(frameChoices(1920, 1080)).toBeNull()
    expect(initialFrame(1920, 1080)).toBeNull()
  })
  it('lists the three phone presets and one tablet preset (landscape is a rotation)', () => {
    expect(frameChoices(360, 800)!.map((c) => `${c.w}x${c.h}`)).toEqual(['360x800', '390x844', '412x915'])
    expect(frameChoices(800, 1280)!.map((c) => `${c.w}x${c.h}`)).toEqual(['800x1280'])
    expect(frameChoices(1280, 800)!.map((c) => `${c.w}x${c.h}`)).toEqual(['800x1280'])
  })
  it('adds the app size when it is not a preset', () => {
    const c = frameChoices(375, 667)!
    expect(c.at(-1)).toMatchObject({ id: 'design', w: 375, h: 667 })
  })
  it('starts at the app size and orientation', () => {
    expect(initialFrame(390, 844)).toEqual({ id: 'phone-390', rotated: false })
    expect(initialFrame(1280, 800)).toEqual({ id: 'tablet-portrait', rotated: true })
  })
  it('rotates by swapping the sides', () => {
    expect(screenSize({ w: 360, h: 800 }, true)).toEqual({ w: 800, h: 360 })
  })
  it('does not scale up and fits the bezelled frame', () => {
    const l = frameLayout('Phone', { w: 360, h: 800 }, false, { w: 2000, h: 2000 })
    expect(l.scale).toBe(1)
    expect(l.outer).toEqual({ w: 384, h: 824 })
    const s = frameLayout('Phone', { w: 360, h: 800 }, false, { w: 1000, h: 412 })
    expect(s.scale).toBe(0.5)
    expect(s.shown.h).toBeLessThanOrEqual(412)
    expect(s.shown.w).toBeLessThanOrEqual(1000)
  })
  it('fits a rotated tablet by its width', () => {
    const l = frameLayout('Tablet', { w: 800, h: 1280 }, true, { w: 700, h: 900 })
    expect(l.screen).toEqual({ w: 1280, h: 800 })
    expect(l.shown.w).toBeLessThanOrEqual(700)
    expect(l.scale).toBeLessThan(0.55)
  })
  it('never goes below the minimum scale and survives an empty area', () => {
    expect(frameLayout('Phone', { w: 360, h: 800 }, false, { w: 0, h: 0 }).scale).toBe(MIN_FRAME_SCALE)
  })
  it('captions with the scale only when scaled', () => {
    expect(frameCaption('Phone', frameLayout('Phone', { w: 360, h: 800 }, false, { w: 5000, h: 5000 }))).toBe('Phone 360×800')
    expect(frameCaption('Phone', frameLayout('Phone', { w: 360, h: 800 }, false, { w: 5000, h: 412 }))).toBe('Phone 360×800, shown at 50%')
  })
})
