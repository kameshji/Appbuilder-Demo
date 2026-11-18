/**
 * QR code as an SVG string (for the authenticator-app enrolment). Encoding: qrcode-generator (MIT, Kazuhiko Arase);
 * the SVG is drawn here as one path (no scripts, no inline styles, so it is safe under the page's CSP).
 */
import qrcode from 'qrcode-generator'

export function qrSvg(text: string, o: { margin?: number; label?: string } = {}): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const m = o.margin ?? 4
  const size = n + m * 2
  let d = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`
  }
  const label = (o.label ?? 'QR code').replace(/[<>&"]/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${size}" height="${size}" fill="#ffffff"/><path fill="#000000" d="${d}"/></svg>`
}
