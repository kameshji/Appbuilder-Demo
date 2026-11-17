import { useId, useMemo } from 'react'
import { ChartColumn, ChartSpline } from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { ControlRenderProps, ControlType, FxRecord, FxValue } from '@/contracts'
import { cn } from '@/lib/utils'
import { isRecord, recordText, toBool, toColor, toNum, toRecords, toText } from '../util'
import { formatDate, formatNumber, isIsoDateString, lc, pick, seriesColor, sliceColor } from './helpers'

/* ---- data shaping ---- */

interface Shaped {
  rows: Record<string, string | number>[]
  /** series keys (value fields) */
  series: string[]
  category: string
}

const hidden = (k: string) => k.startsWith('__')

function catText(v: FxValue | undefined, fallback: string): string {
  if (v == null || v === '') return fallback
  if (v instanceof Date) return formatDate(v, false)
  if (typeof v === 'string' && isIsoDateString(v) && v.length >= 10) return formatDate(new Date(v), false)
  if (isRecord(v)) return recordText(v)
  return toText(v)
}

function shape(items: FxRecord[], categoryField: string, valueFields: string, maxSeries = 6): Shaped {
  const keys: string[] = []
  for (const r of items.slice(0, 30)) for (const k of Object.keys(r)) if (!hidden(k) && !keys.includes(k)) keys.push(k)
  const firstVal = (k: string) => {
    for (const r of items.slice(0, 30)) {
      const v = r[k]
      if (v != null && v !== '') return v
    }
    return null
  }
  const isNum = (k: string) => typeof firstVal(k) === 'number'
  const cat = categoryField.trim() || keys.find((k) => !isNum(k)) || ''
  let series = valueFields
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (series.length === 0) series = keys.filter((k) => k !== cat && isNum(k)).slice(0, maxSeries)
  if (series.length === 0 && keys.includes('Value') && cat !== 'Value') series = ['Value']
  const rows = items.map((r, i) => {
    const row: Record<string, string | number> = { __cat: cat ? catText(pick(r, cat), String(i + 1)) : String(i + 1), __i: i }
    for (const s of series) row[s] = toNum(pick(r, s), 0)
    return row
  })
  return { rows, series, category: cat }
}

/* ---- shared styling ---- */

const tick = { fontSize: 12, fill: 'var(--muted-foreground)' }
const tooltipProps = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--popover-foreground)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
  },
  labelStyle: { color: 'var(--popover-foreground)', fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: 'var(--popover-foreground)', padding: 0 },
  cursor: { fill: 'color-mix(in oklch, var(--muted) 70%, transparent)', stroke: 'var(--border)' },
  isAnimationActive: false,
  formatter: (v: unknown) => (typeof v === 'number' ? formatNumber(v) : String(v ?? '')),
} as const

type Kind = 'bar' | 'line' | 'area' | 'pie' | 'donut'
function kindOf(v: FxValue | undefined): Kind {
  const s = lc(v)
  return s === 'line' || s === 'area' || s === 'pie' || s === 'donut' ? s : 'bar'
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <ChartColumn className="size-7 opacity-60" strokeWidth={1.5} />
      <span className="text-sm">{text}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ Chart */

function ChartRender({ props, mode, setOutput, fire }: ControlRenderProps) {
  const run = mode === 'run'
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const kind = kindOf(props.Type)
  const showLegend = toBool(props.ShowLegend, true)
  const showGrid = toBool(props.ShowGrid, true)
  const stacked = toBool(props.Stacked, false)
  const title = toText(props.Title)
  const { rows, series } = useMemo(
    () => shape(items, toText(props.CategoryField), toText(props.ValueFields), kind === 'pie' || kind === 'donut' ? 1 : 6),
    [items, props.CategoryField, props.ValueFields, kind],
  )

  const choose = (i: unknown) => {
    if (!run) return
    const idx = Number(i)
    const rec = Number.isInteger(idx) ? items[idx] : undefined
    if (!rec) return
    setOutput('Selected', rec)
    fire('OnSelect')
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fromDatum = (d: any) => choose(d?.payload?.__i ?? d?.__i)
  const fromState = (s: any) => {
    const ai = s?.activeIndex ?? s?.activeTooltipIndex
    if (ai == null) return
    choose(rows[Number(ai)]?.__i)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let body: React.ReactNode
  if (rows.length === 0 || series.length === 0) {
    body = <Placeholder text={rows.length === 0 ? 'No data' : 'No numeric fields'} />
  } else if (kind === 'pie' || kind === 'donut') {
    const key = series[0]
    const data = rows.map((r) => ({ name: r.__cat, value: Math.max(0, Number(r[key])), __i: r.__i }))
    body = (
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={kind === 'donut' ? '58%' : 0}
            outerRadius="82%"
            paddingAngle={kind === 'donut' ? 2 : 0}
            stroke="var(--card)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={fromDatum}
            style={{ cursor: run ? 'pointer' : undefined, outline: 'none' }}
          >
            {data.map((_, i) => <Cell key={i} fill={sliceColor(i)} />)}
          </Pie>
          <Tooltip {...tooltipProps} />
          {showLegend && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
        </PieChart>
      </ResponsiveContainer>
    )
  } else {
    const axes = (
      <>
        {showGrid && <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />}
        <XAxis dataKey="__cat" tick={tick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" />
        <YAxis tick={tick} tickLine={false} axisLine={false} width="auto" tickFormatter={(v: number) => formatNumber(v)} />
        <Tooltip {...tooltipProps} />
        {showLegend && series.length > 0 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
      </>
    )
    const margin = { top: 8, right: 12, left: 0, bottom: 0 }
    if (kind === 'line') {
      body = (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={rows} margin={margin} onClick={fromState} style={{ cursor: run ? 'pointer' : undefined }}>
            {axes}
            {series.map((s, i) => (
              <Line key={s} type="monotone" dataKey={s} stroke={seriesColor(i)} strokeWidth={2} dot={{ r: 3, fill: seriesColor(i), strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )
    } else if (kind === 'area') {
      body = (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={rows} margin={margin} onClick={fromState} style={{ cursor: run ? 'pointer' : undefined }}>
            {axes}
            {series.map((s, i) => (
              <Area key={s} type="monotone" dataKey={s} stackId={stacked ? 'a' : undefined} stroke={seriesColor(i)} strokeWidth={2} fill={seriesColor(i)} fillOpacity={0.2} isAnimationActive={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )
    } else {
      body = (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={rows} margin={margin} barCategoryGap="22%">
            {axes}
            {series.map((s, i) => (
              <Bar
                key={s}
                dataKey={s}
                stackId={stacked ? 'a' : undefined}
                fill={seriesColor(i)}
                radius={stacked ? 0 : [4, 4, 0, 0]}
                isAnimationActive={false}
                onClick={fromDatum}
                style={{ cursor: run ? 'pointer' : undefined }}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )
    }
  }

  return (
    <div className={cn('flex size-full min-h-0 min-w-0 flex-col', !run && 'pointer-events-none')}>
      {title !== '' && <div className="shrink-0 px-1 pb-2 text-sm font-medium">{title}</div>}
      <div className="min-h-0 min-w-0 flex-1">{body}</div>
    </div>
  )
}

export const Chart: ControlType = {
  type: 'Chart',
  label: 'Chart',
  icon: ChartColumn,
  category: 'Charts',
  props: [
    {
      name: 'Items',
      kind: 'table',
      group: 'Data',
      default:
        '=Table({Month: "Jan", Sales: 120, Costs: 80}, {Month: "Feb", Sales: 160, Costs: 95}, {Month: "Mar", Sales: 140, Costs: 90}, {Month: "Apr", Sales: 210, Costs: 120}, {Month: "May", Sales: 190, Costs: 110}, {Month: "Jun", Sales: 260, Costs: 140})',
    },
    { name: 'Type', kind: 'enum', group: 'Style', default: '=ChartType.Bar', options: ['ChartType.Bar', 'ChartType.Line', 'ChartType.Area', 'ChartType.Pie', 'ChartType.Donut'] },
    { name: 'CategoryField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'ValueFields', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Title', kind: 'text', group: 'Content', default: '=""' },
    { name: 'ShowLegend', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'ShowGrid', kind: 'boolean', group: 'Style', default: '=true' },
    { name: 'Stacked', kind: 'boolean', group: 'Style', default: '=false' },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
  ],
  outputs: [{ name: 'Selected', initial: null }],
  defaultSize: { width: 520, height: 320 },
  primaryProp: 'Items',
  render: ChartRender,
}

/* ------------------------------------------------------------------ Sparkline */

function SparklineRender({ props }: ControlRenderProps) {
  const gid = useId().replace(/:/g, '')
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const kind = ['line', 'bar'].includes(lc(props.Kind)) ? lc(props.Kind) : 'area'
  const color = toColor(props.Color) ?? 'var(--primary)'
  const field = toText(props.ValueField).trim()
  const { rows, series } = useMemo(() => shape(items, '', field, 1), [items, field])
  if (rows.length === 0 || series.length === 0) {
    return <div className="size-full rounded-md border border-dashed border-muted-foreground/30" />
  }
  const key = series[0]
  const last = rows[rows.length - 1]
  const margin = { top: 4, right: 4, left: 4, bottom: 4 }
  const domain: [string, string] = ['dataMin', 'dataMax']
  const common = (
    <>
      <XAxis dataKey="__i" hide />
      <YAxis hide domain={kind === 'bar' ? [0, 'dataMax'] : domain} />
    </>
  )
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      {kind === 'bar' ? (
        <BarChart data={rows} margin={margin} barCategoryGap="15%">
          {common}
          <Bar dataKey={key} fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      ) : kind === 'line' ? (
        <LineChart data={rows} margin={margin}>
          {common}
          <Line type="monotone" dataKey={key} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          {toBool(props.ShowDot, true) && <ReferenceDot x={last.__i} y={last[key]} r={3} fill={color} stroke="var(--card)" strokeWidth={1.5} />}
        </LineChart>
      ) : (
        <AreaChart data={rows} margin={margin}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {common}
          <Area type="monotone" dataKey={key} stroke={color} strokeWidth={2} fill={`url(#${gid})`} dot={false} isAnimationActive={false} />
          {toBool(props.ShowDot, true) && <ReferenceDot x={last.__i} y={last[key]} r={3} fill={color} stroke="var(--card)" strokeWidth={1.5} />}
        </AreaChart>
      )}
    </ResponsiveContainer>
  )
}

export const Sparkline: ControlType = {
  type: 'Sparkline',
  label: 'Sparkline',
  icon: ChartSpline,
  category: 'Charts',
  props: [
    { name: 'Items', kind: 'table', group: 'Data', default: '=[3, 5, 4, 8, 6, 9, 7, 12]' },
    { name: 'ValueField', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Kind', kind: 'enum', group: 'Style', default: '="Area"', options: ['"Area"', '"Line"', '"Bar"'] },
    { name: 'Color', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'ShowDot', kind: 'boolean', group: 'Style', default: '=true', simple: false },
  ],
  outputs: [],
  defaultSize: { width: 160, height: 48 },
  primaryProp: 'Items',
  render: SparklineRender,
}
