/**
 * renderChartSvg (P2-C): a chart spec and its rows -> one standalone SVG document (string). Pure: no React, DOM or
 * packages, so the server can call it in Node (PDF documents of package B, dashboard email snapshots). It draws the same
 * geometry as the interactive UI components (geometry.ts), with concrete colours of the light or dark palette, the
 * title and the legend inside the SVG, a <title>/<desc> for screen readers, and nothing interactive.
 *
 * Contract (docs/dev/dashboards.md "renderChartSvg"):
 *   renderChartSvg(spec: ChartSpec, rows: Record<string, unknown>[], opts?: { theme?: 'light' | 'dark'; font?: string; background?: boolean }): string
 * - width / height are spec.width / spec.height in CSS px (the SVG has the same viewBox; scale it freely);
 * - values: numbers (or numeric text), dates as Date or "YYYY-MM-DD", blanks as null;
 * - text is escaped; no script, no external reference, no foreignObject; fonts: opts.font (default a system sans stack).
 */
import type { ChartSpec, LegendItem, Mark } from './geometry.ts'
import { chartScene } from './geometry.ts'
import type { ThemeName } from './palette.ts'
import { resolveHex } from './palette.ts'
import { fitText, textWidth } from './scales.ts'

export interface SvgOptions {
  theme?: ThemeName
  font?: string
  /** paint the background (default true) */
  background?: boolean
}

/** legend lines drawn at most; entries beyond them are left out */
const LEGEND_LINES = 3
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const n = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0')

function markSvg(m: Mark, theme: ThemeName): string {
  const c = (p: string | undefined) => resolveHex(p, theme)
  const op = (o: number | undefined) => (o !== undefined && o !== 1 ? ` opacity="${n(o)}"` : '')
  switch (m.t) {
    case 'rect': return `<rect x="${n(m.x)}" y="${n(m.y)}" width="${n(Math.max(0, m.w))}" height="${n(Math.max(0, m.h))}"${m.rx ? ` rx="${n(m.rx)}"` : ''} fill="${c(m.fill)}"${m.stroke ? ` stroke="${c(m.stroke)}"` : ''}${op(m.opacity)}/>`
    case 'path': return `<path d="${esc(m.d)}" fill="${m.fill ? c(m.fill) : 'none'}"${m.stroke ? ` stroke="${c(m.stroke)}" stroke-width="${n(m.width ?? 1)}"` : ''}${m.dash ? ` stroke-dasharray="${esc(m.dash)}"` : ''}${m.cap ? ` stroke-linecap="${m.cap}" stroke-linejoin="round"` : ''}${op(m.opacity)}/>`
    case 'circle': return m.r > 0 ? `<circle cx="${n(m.cx)}" cy="${n(m.cy)}" r="${n(m.r)}" fill="${c(m.fill)}"${m.stroke ? ` stroke="${c(m.stroke)}" stroke-width="${n(m.width ?? 1)}"` : ''}${op(m.opacity)}/>` : ''
    case 'line': return `<line x1="${n(m.x1)}" y1="${n(m.y1)}" x2="${n(m.x2)}" y2="${n(m.y2)}" stroke="${c(m.stroke)}" stroke-width="${n(m.width ?? 1)}"${m.dash ? ` stroke-dasharray="${esc(m.dash)}"` : ''}${op(m.opacity)}/>`
    case 'text': {
      const base = m.baseline === 'middle' ? ' dominant-baseline="central"' : m.baseline === 'hanging' ? ' dominant-baseline="hanging"' : ''
      return `<text x="${n(m.x)}" y="${n(m.y)}" font-size="${n(m.size)}" fill="${c(m.fill)}"${m.anchor && m.anchor !== 'start' ? ` text-anchor="${m.anchor}"` : ''}${base}${m.weight ? ` font-weight="${m.weight}"` : ''}${m.rotate ? ` transform="rotate(${n(m.rotate)} ${n(m.x)} ${n(m.y)})"` : ''}>${esc(m.text)}</text>`
    }
  }
}

export function renderChartSvg(spec: ChartSpec, rows: Record<string, unknown>[], opts: SvgOptions = {}): string {
  const theme: ThemeName = opts.theme === 'dark' ? 'dark' : 'light'
  const W = Math.max(40, Math.round(spec.width))
  const H = Math.max(30, Math.round(spec.height))
  const titleH = spec.title && spec.kind !== 'kpi' ? 22 : 0
  // legend: one line of items above the plot (only when there is more than one entry)
  const probe = chartScene({ ...spec, width: W, height: H }, rows)
  const showLegend = spec.legend !== false && probe.legend.length > 1
  // items that do not fit on one line wrap onto the next (at most LEGEND_LINES; never dropped silently before that)
  const legendLines: { label: string; color: LegendItem['color']; x: number }[][] = []
  if (showLegend) {
    let line: { label: string; color: LegendItem['color']; x: number }[] = []
    let x = 4
    for (const it of probe.legend) {
      if (it.hidden) continue
      const label = fitText(it.label, 11, Math.min(160, Math.max(20, W - 8 - 26)))
      const w = 14 + textWidth(label, 11) + 12
      if (line.length && x + w > W) {
        legendLines.push(line)
        line = []
        x = 4
      }
      line.push({ label, color: it.color, x })
      x += w
    }
    if (line.length) legendLines.push(line)
    legendLines.length = Math.min(legendLines.length, LEGEND_LINES)
  }
  const legendH = showLegend ? 20 + Math.max(0, legendLines.length - 1) * 15 : 0
  const scene = chartScene({ ...spec, width: W, height: Math.max(30, H - titleH - legendH) }, rows)
  const parts: string[] = []
  const font = opts.font ?? "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Devanagari', Arial, sans-serif"
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" font-family="${esc(font)}">`)
  parts.push(`<title>${esc(spec.title ?? scene.summary)}</title><desc>${esc(scene.summary)}</desc>`)
  if (opts.background !== false) parts.push(`<rect width="${W}" height="${H}" fill="${resolveHex('bg', theme)}"/>`)
  if (titleH) parts.push(`<text x="4" y="15" font-size="13" font-weight="600" fill="${resolveHex('text', theme)}">${esc(fitText(spec.title!, 13, W - 8))}</text>`)
  if (showLegend) {
    legendLines.forEach((line, i) => {
      const y = titleH + 10 + i * 15
      for (const { label, color, x } of line) {
        parts.push(`<rect x="${n(x)}" y="${n(y - 4)}" width="9" height="9" rx="2" fill="${resolveHex(color, theme)}"/><text x="${n(x + 13)}" y="${n(y)}" font-size="11" dominant-baseline="central" fill="${resolveHex('muted', theme)}">${esc(label)}</text>`)
      }
    })
  }
  parts.push(`<g transform="translate(0 ${titleH + legendH})">`)
  if (scene.empty) parts.push(`<text x="${n(W / 2)}" y="${n(scene.height / 2)}" font-size="12" text-anchor="middle" fill="${resolveHex('muted', theme)}">${esc(scene.empty)}</text>`)
  for (const m of scene.marks) parts.push(markSvg(m, theme))
  parts.push('</g></svg>')
  return parts.join('')
}

export type { ChartSpec } from './geometry.ts'
