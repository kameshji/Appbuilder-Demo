/**
 * Colour tokens of charts (P2-C). Geometry never names a colour directly: it uses a Paint token, resolved here.
 *  - on screen (resolveCss): CSS variables --viz-* defined for light and dark in src/index.css, with these values as
 *    fallbacks, so the theme switch recolours charts without re-rendering geometry;
 *  - in SVG for PDF / email (resolveHex): the concrete colours of the light or dark palette below.
 * Categorical colours are distinguishable for the common colour-vision deficiencies when used with the legend's labels
 * and the data table (never colour alone); status colours always come with an arrow or a text.
 */
export type Paint = string
export type ThemeName = 'light' | 'dark'

export const SERIES_LIGHT = ['#4f46e5', '#0891b2', '#d97706', '#db2777', '#059669', '#7c3aed', '#64748b', '#ea580c']
export const SERIES_DARK = ['#818cf8', '#22d3ee', '#fbbf24', '#f472b6', '#34d399', '#a78bfa', '#94a3b8', '#fb923c']

export const NEUTRAL: Record<ThemeName, Record<string, string>> = {
  light: { text: '#0f172a', muted: '#64748b', grid: '#e2e8f0', axis: '#cbd5e1', bg: '#ffffff', track: '#eef2f7', good: '#16a34a', warn: '#d97706', bad: '#dc2626' },
  dark: { text: '#f1f5f9', muted: '#94a3b8', grid: '#334155', axis: '#475569', bg: '#1e2433', track: '#2a3142', good: '#4ade80', warn: '#fbbf24', bad: '#f87171' },
}

export const seriesPaint = (i: number): Paint => `series:${((i % SERIES_LIGHT.length) + SERIES_LIGHT.length) % SERIES_LIGHT.length}`

/** a token -> a concrete colour for one theme (SVG output) */
export function resolveHex(p: Paint | undefined, theme: ThemeName = 'light'): string {
  if (!p) return 'none'
  if (p.startsWith('#') || p.startsWith('rgb') || p === 'none' || p === 'transparent') return p
  if (p.startsWith('series:')) {
    const i = Number(p.slice(7)) || 0
    return (theme === 'dark' ? SERIES_DARK : SERIES_LIGHT)[i % SERIES_LIGHT.length]!
  }
  return NEUTRAL[theme][p] ?? NEUTRAL[theme].text!
}

/** a token -> a CSS value for the screen (follows the theme through CSS variables) */
export function resolveCss(p: Paint | undefined): string {
  if (!p) return 'none'
  if (p.startsWith('#') || p.startsWith('rgb') || p === 'none' || p === 'transparent') return p
  if (p.startsWith('series:')) {
    const i = Number(p.slice(7)) || 0
    return `var(--viz-${i % SERIES_LIGHT.length}, ${SERIES_LIGHT[i % SERIES_LIGHT.length]})`
  }
  return `var(--viz-${p}, ${NEUTRAL.light[p] ?? NEUTRAL.light.text})`
}

/** the CSS variable block for src/index.css (kept here so the values have one source; a test compares them) */
export function cssVariables(theme: ThemeName): string {
  const s = theme === 'dark' ? SERIES_DARK : SERIES_LIGHT
  return [...s.map((c, i) => `--viz-${i}: ${c};`), ...Object.entries(NEUTRAL[theme]).map(([k, v]) => `--viz-${k}: ${v};`)].join(' ')
}
