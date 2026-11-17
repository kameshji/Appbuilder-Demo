import { describe, expect, it, vi } from 'vitest'

const platformMock = vi.hoisted(() => ({
  attachments: { url: (id: string) => `/api/v1/attachments/${id}`, resolve: async () => [] },
}))
vi.mock('@/platform', async (orig) => ({ ...(await orig<typeof import('@/platform')>()), platform: platformMock }))

import {
  acceptsFile, attachmentIds, fileProblem, filesForToken, formatAttachmentCell, imageSource, looksLikeImage, pendingFilesOf, registerFiles, releaseFiles,
} from './attachments'

describe('attachment ids in cells', () => {
  it('reads a single id, a JSON array text and a real array', () => {
    expect(attachmentIds('att_abc123')).toEqual(['att_abc123'])
    expect(attachmentIds('["att_a","att_b"]')).toEqual(['att_a', 'att_b'])
    expect(attachmentIds(['att_a', 'x y', 5])).toEqual(['att_a'])
  })
  it('ignores ordinary text, blanks and broken JSON', () => {
    expect(attachmentIds('Pending')).toEqual([])
    expect(attachmentIds('')).toEqual([])
    expect(attachmentIds(null)).toEqual([])
    expect(attachmentIds('[att_a')).toEqual([])
    expect(attachmentIds('["hello"]')).toEqual([])
    expect(attachmentIds('att_a and more')).toEqual([])
  })
  it('formats a cell for single and multiple columns', () => {
    expect(formatAttachmentCell([], true)).toBe('')
    expect(formatAttachmentCell(['att_a'], false)).toBe('att_a')
    expect(formatAttachmentCell(['att_a', 'att_b'], true)).toBe('["att_a","att_b"]')
  })
})

describe('Image control source', () => {
  it('resolves attachment ids through the platform and leaves URLs alone', () => {
    expect(imageSource('att_abc123')).toBe('/api/v1/attachments/att_abc123')
    expect(imageSource('["att_a","att_b"]')).toBe('/api/v1/attachments/att_a')
    expect(imageSource('a1b2c3d4e5f6')).toBe('/api/v1/attachments/a1b2c3d4e5f6')
    expect(imageSource('https://example.com/x.png')).toBe('https://example.com/x.png')
    expect(imageSource('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(imageSource('/img/logo.png')).toBe('/img/logo.png')
    expect(imageSource('logo.png')).toBe('logo.png')
    expect(imageSource('Logo')).toBe('Logo')
    expect(imageSource('  ')).toBe('')
  })
  it('recognises images by MIME or extension', () => {
    expect(looksLikeImage({ mime: 'image/png', fileName: 'x' })).toBe(true)
    expect(looksLikeImage({ mime: 'application/octet-stream', fileName: 'photo.JPG' })).toBe(true)
    expect(looksLikeImage({ mime: 'application/pdf', fileName: 'a.pdf' })).toBe(false)
    expect(looksLikeImage(null)).toBe(false)
  })
})

describe('file checks', () => {
  const f = (name: string, type: string, size = 10) => ({ name, type, size }) as File
  it('matches accept patterns', () => {
    expect(acceptsFile(f('a.png', 'image/png'), ['image/*'])).toBe(true)
    expect(acceptsFile(f('a.pdf', 'application/pdf'), ['image/*'])).toBe(false)
    expect(acceptsFile(f('a.PDF', ''), ['.pdf'])).toBe(true)
    expect(acceptsFile(f('a.txt', 'text/plain'), [])).toBe(true)
  })
  it('reports type and size problems', () => {
    expect(fileProblem(f('a.pdf', 'application/pdf'), { accept: ['image/*'] })).toMatch(/not allowed/)
    expect(fileProblem(f('big.png', 'image/png', 3 * 1024 * 1024), { maxSizeMB: 2 })).toMatch(/larger than 2 MB/)
    expect(fileProblem(f('ok.png', 'image/png'), { accept: ['image/*'], maxSizeMB: 2 })).toBeNull()
  })
})

describe('pending files registry', () => {
  const file = (n: string) => new File(['x'], n)
  it('hands the original File objects back by token and releases the previous token', () => {
    const a = file('a.txt')
    const t1 = registerFiles([a])
    expect(filesForToken(t1)).toEqual([a])
    const t2 = registerFiles([a, file('b.txt')], t1)
    expect(filesForToken(t1)).toEqual([])
    expect(filesForToken(t2)).toHaveLength(2)
    expect(registerFiles([], t2)).toBe('')
    expect(filesForToken(t2)).toEqual([])
  })
  it('reads a Form __files output', () => {
    const t = registerFiles([file('p.png')])
    expect(pendingFilesOf({ Photo: t, Gone: 'files_missing', __x: t })).toEqual([{ column: 'Photo', files: filesForToken(t) }])
    expect(pendingFilesOf(null)).toEqual([])
    releaseFiles(t)
    expect(pendingFilesOf({ Photo: t })).toEqual([])
  })
})
