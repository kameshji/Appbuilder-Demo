import type { FxRecord } from '@/contracts'

const rgba = (r: number, g: number, b: number, a = 1): string => `rgba(${r}, ${g}, ${b}, ${a})`

/** Named colours as [r, g, b, a]. Used by the Color enum, ColorValue and ColorFade. */
export const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  Red: [239, 68, 68, 1],
  Green: [34, 197, 94, 1],
  Blue: [59, 130, 246, 1],
  Black: [0, 0, 0, 1],
  White: [255, 255, 255, 1],
  Gray: [113, 113, 122, 1],
  LightGray: [228, 228, 231, 1],
  DarkGray: [63, 63, 70, 1],
  Orange: [249, 115, 22, 1],
  Yellow: [234, 179, 8, 1],
  Purple: [168, 85, 247, 1],
  Pink: [236, 72, 153, 1],
  Teal: [20, 184, 166, 1],
  Cyan: [6, 182, 212, 1],
  Brown: [146, 64, 14, 1],
  Transparent: [0, 0, 0, 0],
}

function members(names: string[]): FxRecord {
  const r: FxRecord = {}
  for (const n of names) r[n] = n
  return r
}

const colorRecord: FxRecord = {}
for (const [name, c] of Object.entries(NAMED_COLORS)) colorRecord[name] = rgba(c[0], c[1], c[2], c[3])

export const ENUM_RECORDS: Record<string, FxRecord> = {
  Color: colorRecord,
  Align: members(['Left', 'Center', 'Right']),
  FontWeight: members(['Normal', 'Semibold', 'Bold']),
  DisplayMode: members(['Edit', 'View', 'Disabled']),
  SortOrder: members(['Ascending', 'Descending']),
  NotificationType: members(['Information', 'Success', 'Warning', 'Error']),
  ButtonStyle: members(['Primary', 'Secondary', 'Outline', 'Ghost', 'Destructive']),
}

/** Lets the evaluator report "Color has no member Foo" instead of returning blank. */
export const ENUM_SET: WeakSet<object> = new WeakSet(Object.values(ENUM_RECORDS))

export function enums(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(ENUM_RECORDS)) out[k] = Object.keys(v)
  return out
}
