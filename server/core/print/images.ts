/** PNG and JPEG sniffing for the print engine: type and pixel size from the file header (no decoding). */
export interface ImageInfo { type: 'png' | 'jpeg'; width: number; height: number }

export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR') {
    const width = b.readUInt32BE(16)
    const height = b.readUInt32BE(20)
    return width > 0 && height > 0 ? { type: 'png', width, height } : null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = b.readUInt16BE(i + 2)
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = b.readUInt16BE(i + 5)
        const width = b.readUInt16BE(i + 7)
        return width > 0 && height > 0 ? { type: 'jpeg', width, height } : null
      }
      i += 2 + len
    }
  }
  return null
}

/** a data: URL of a PNG or JPEG -> bytes */
export function fromDataUrl(s: string): Buffer | null {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(s)
  return m ? Buffer.from(m[2], 'base64') : null
}
