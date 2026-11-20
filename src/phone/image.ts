/**
 * Photos for attachment columns (P2-A, docs/dev/phone.md "Camera"): before a photo is kept (and uploaded or queued in
 * the offline outbox) it is turned upright by its EXIF orientation, scaled so its longer side is at most `maxDimension`
 * (default 1600 px) and re-encoded as JPEG (quality 0.85). Phone photos of 3-8 MB become ~200-500 KB, which matters on
 * plant Wi-Fi and in the size-capped offline store. Files that are not JPEG/PNG/WebP photos, or that cannot be decoded,
 * are kept unchanged. Re-encoding drops the EXIF block (GPS position and camera details are not uploaded).
 *
 * The orientation and size maths are pure and unit-tested; the canvas part runs in browsers only.
 */

/** EXIF orientation (1-8) of a JPEG, 1 when absent or not a JPEG */
export function exifOrientation(buf: ArrayBuffer): number {
  const v = new DataView(buf)
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1
  let off = 2
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off)
    const size = v.getUint16(off + 2)
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966 /* Exif */) {
      const tiff = off + 10
      if (tiff + 8 > v.byteLength) return 1
      const little = v.getUint16(tiff) === 0x4949
      const u16 = (p: number) => v.getUint16(p, little)
      const u32 = (p: number) => v.getUint32(p, little)
      const ifd = tiff + u32(tiff + 4)
      if (ifd + 2 > v.byteLength) return 1
      const n = u16(ifd)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (e + 12 > v.byteLength) return 1
        if (u16(e) === 0x0112) {
          const o = u16(e + 8)
          return o >= 1 && o <= 8 ? o : 1
        }
      }
      return 1
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1
    off += 2 + size
  }
  return 1
}

/** orientations 5-8 swap width and height */
export const swapsSides = (o: number) => o >= 5 && o <= 8

/** output size for a decoded (not yet rotated) image of w x h: upright, longer side at most max */
export function targetSize(w: number, h: number, orientation: number, max: number): { w: number; h: number; scale: number } {
  const [uw, uh] = swapsSides(orientation) ? [h, w] : [w, h]
  const scale = Math.min(1, max / Math.max(uw, uh))
  return { w: Math.max(1, Math.round(uw * scale)), h: Math.max(1, Math.round(uh * scale)), scale }
}

/** the canvas transform (a, b, c, d, e, f) that draws an image of drawn size dw x dh upright for an orientation */
export function orientationTransform(o: number, dw: number, dh: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2: return [-1, 0, 0, 1, dw, 0]
    case 3: return [-1, 0, 0, -1, dw, dh]
    case 4: return [1, 0, 0, -1, 0, dh]
    case 5: return [0, 1, 1, 0, 0, 0]
    case 6: return [0, 1, -1, 0, dh, 0]
    case 7: return [0, -1, -1, 0, dh, dw]
    case 8: return [0, -1, 1, 0, 0, dw]
    default: return [1, 0, 0, 1, 0, 0]
  }
}

export interface PhotoOptions {
  maxDimension?: number
  quality?: number
}

const PHOTO = /^image\/(jpeg|png|webp)$/i

/** resize + orient a photo; returns the original file when it is not a photo or cannot be processed */
export async function preparePhoto(file: File, opts: PhotoOptions = {}): Promise<File> {
  const max = opts.maxDimension && opts.maxDimension >= 64 ? opts.maxDimension : 1600
  if (!PHOTO.test(file.type) || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  try {
    const buf = await file.arrayBuffer()
    const orientation = /jpeg/i.test(file.type) ? exifOrientation(buf) : 1
    // decode WITHOUT the browser's own EXIF rotation, so the rotation is applied exactly once (here)
    const bmp = await createImageBitmap(new Blob([buf], { type: file.type }), { imageOrientation: 'none' } as ImageBitmapOptions)
    const t = targetSize(bmp.width, bmp.height, orientation, max)
    if (t.scale === 1 && orientation === 1 && file.size < 400_000) {
      bmp.close()
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = t.w
    canvas.height = t.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    const dw = Math.round(bmp.width * t.scale)
    const dh = Math.round(bmp.height * t.scale)
    ctx.setTransform(...orientationTransform(orientation, dw, dh))
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, dw, dh)
    bmp.close()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', opts.quality ?? 0.85))
    if (!blob || blob.size >= file.size) return file
    const name = file.name.replace(/\.(png|webp|jpe?g|heic)$/i, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  }
}
