import { describe, it, expect } from 'vitest'
import { canShareFile, shareFile, type ShareNavigator } from './share'

const file = new File([new Uint8Array([37, 80, 68, 70])], 'Report.pdf', { type: 'application/pdf' })

describe('sharing a generated PDF', () => {
  it('shares only where the browser says it can share this file', () => {
    expect(canShareFile(undefined, file)).toBe(false)
    expect(canShareFile({}, file)).toBe(false)
    expect(canShareFile({ share: async () => {} }, file)).toBe(false) // no canShare: files may not be accepted
    expect(canShareFile({ share: async () => {}, canShare: () => false }, file)).toBe(false)
    expect(canShareFile({ share: async () => {}, canShare: () => { throw new TypeError('x') } }, file)).toBe(false)
    expect(canShareFile({ share: async () => {}, canShare: (d) => d.files?.[0]?.name === 'Report.pdf' }, file)).toBe(true)
  })
  it('passes the file and its name; a cancelled share sheet is not a failure', async () => {
    let got: unknown = null
    const nav: ShareNavigator = { share: async (d) => { got = d }, canShare: () => true }
    expect(await shareFile(nav, file)).toBe('shared')
    expect(got).toEqual({ files: [file], title: 'Report.pdf' })
    const abort = Object.assign(new Error('cancel'), { name: 'AbortError' })
    expect(await shareFile({ share: async () => { throw abort } }, file)).toBe('cancelled')
    expect(await shareFile({ share: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) } }, file)).toBe('failed')
  })
})
