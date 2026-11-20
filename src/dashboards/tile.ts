/**
 * A tile and its finished rows -> the ChartSpec the geometry draws (P2-C). Pure: the dashboard viewer and the server's
 * snapshot rendering use the same mapping.
 */
import type { ChartSpec, KpiSpec } from '../charts/geometry.ts'
import type { DateGrain, FormatDefaults } from '../charts/format.ts'
import type { TileDef } from './types.ts'
import type { CalendarSettings } from './dates.ts'
import { DEFAULT_CALENDAR } from './dates.ts'

export function tileChartSpec(tile: TileDef, rows: Record<string, unknown>[], size: { width: number; height: number }, o: { calendar?: CalendarSettings; defaults?: FormatDefaults; selected?: string | null; hidden?: string[] } = {}): ChartSpec {
  const v = tile.visual ?? {}
  const q = tile.query
  const cal = o.calendar ?? DEFAULT_CALENDAR
  const category = v.category ?? (q?.bucket ? '__bucket' : q?.groupBy?.[0])
  const isBucket = category === '__bucket'
  const unit = q?.bucket?.unit
  const series = v.series ?? (q ? [...q.measures.map((m) => ({ key: m.id, label: m.label ?? m.id })), ...(q.computed ?? []).map((c) => ({ key: c.id, label: c.label ?? c.id }))] : [])
  const spec: ChartSpec = {
    kind: tile.kind === 'table' || tile.kind === 'text' ? 'bar' : tile.kind,
    width: size.width, height: size.height,
    category,
    categoryType: isBucket ? (unit === 'weekday' ? 'weekday' : unit === 'hour' ? 'number' : 'date') : 'text',
    categoryGrain: isBucket && unit && unit !== 'weekday' && unit !== 'hour' ? (unit as DateGrain) : undefined,
    series, stack: v.stack, orientation: v.orientation, curve: v.curve, format: v.format, bands: v.bands, min: v.min, max: v.max,
    target: v.target, dataLabels: v.dataLabels, fiscalYearStart: cal.fiscalYearStart, defaults: o.defaults, selected: o.selected ?? null, hidden: o.hidden,
    missing: 'gap',
  }
  if (tile.kind === 'heatmap') {
    spec.row = v.row ?? q?.groupBy?.[0]
    spec.column = category === spec.row ? '__bucket' : category
    spec.rowType = 'text'
  }
  if (tile.kind === 'gauge' && rows.length > 1) rows = rows.slice(0, 1)
  if (tile.kind === 'kpi') {
    const k = v.kpi ?? { measure: series[0]?.key ?? '' }
    const totalRow = rows.length === 1 ? rows[0] : undefined
    const value = totalRow ? numOrNull(totalRow[k.measure]) : rows.length ? sumOf(rows, k.measure) : null
    const kpi: KpiSpec = {
      label: tile.title || series.find((s) => s.key === k.measure)?.label || k.measure,
      value,
      higherIsBetter: k.higherIsBetter,
      rules: k.rules,
      deltaStyle: 'percent',
      showLabel: !tile.title,
    }
    if (k.base === 'compare' && totalRow) { kpi.base = numOrNull(totalRow[`${k.measure}__cmp`]); kpi.baseLabel = q?.compare === 'samePeriodLastYear' ? 'vs same period last year' : 'vs previous period' }
    if (k.base === 'target' && totalRow) { kpi.base = numOrNull(totalRow.__target); kpi.baseLabel = 'vs target' }
    if (k.spark && rows.length > 1) kpi.spark = rows.map((r) => numOrNull(r[k.spark!]))
    spec.kpi = kpi
  }
  return spec
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
function sumOf(rows: Record<string, unknown>[], k: string): number | null {
  let s = 0, any = false
  for (const r of rows) { const v = numOrNull(r[k]); if (v !== null) { s += v; any = true } }
  return any ? s : null
}
