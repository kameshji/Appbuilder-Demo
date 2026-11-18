import type { FxRecord } from '../contracts.ts'
import { ANIMATED_ICON_IDS } from './animatedIcons.ts'

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
  // fuller palette (Tailwind-like 500/600 tones plus the classic CSS names)
  Crimson: [220, 38, 38, 1],
  Maroon: [127, 29, 29, 1],
  Navy: [30, 58, 138, 1],
  Indigo: [99, 102, 241, 1],
  Violet: [139, 92, 246, 1],
  Magenta: [217, 70, 239, 1],
  Fuchsia: [192, 38, 211, 1],
  Rose: [244, 63, 94, 1],
  Coral: [251, 113, 133, 1],
  Salmon: [250, 128, 114, 1],
  Amber: [245, 158, 11, 1],
  Gold: [202, 138, 4, 1],
  Lime: [132, 204, 22, 1],
  Olive: [101, 163, 13, 1],
  Emerald: [16, 185, 129, 1],
  ForestGreen: [21, 128, 61, 1],
  SeaGreen: [5, 150, 105, 1],
  Mint: [167, 243, 208, 1],
  Aqua: [34, 211, 238, 1],
  Turquoise: [45, 212, 191, 1],
  Sky: [14, 165, 233, 1],
  SkyBlue: [125, 211, 252, 1],
  RoyalBlue: [37, 99, 235, 1],
  Azure: [56, 189, 248, 1],
  Lavender: [196, 181, 253, 1],
  Plum: [126, 34, 206, 1],
  Tan: [214, 179, 140, 1],
  Beige: [245, 245, 220, 1],
  Ivory: [255, 255, 240, 1],
  Khaki: [240, 230, 140, 1],
  Silver: [161, 161, 170, 1],
  Slate: [100, 116, 139, 1],
  Zinc: [82, 82, 91, 1],
  Charcoal: [39, 39, 42, 1],
  Snow: [250, 250, 250, 1],
}

function members(names: string[]): FxRecord {
  const r: FxRecord = {}
  for (const n of names) r[n] = n
  return r
}

/** Lucide icon names (PascalCase) offered by the Icon enum. Every one is exported by lucide-react. */
export const ICON_NAMES: string[] = [
  'Plus', 'Minus', 'Trash', 'Edit', 'Pencil', 'Search', 'Check', 'X', 'ChevronRight', 'ChevronLeft', 'ChevronUp', 'ChevronDown',
  'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'Settings', 'User', 'Users', 'Mail', 'Phone', 'Calendar', 'Clock',
  'Bell', 'Star', 'Heart', 'Bookmark', 'Folder', 'File', 'FileText', 'Image', 'Camera', 'Video', 'Music', 'Download', 'Upload',
  'Share', 'Link', 'ExternalLink', 'Copy', 'Save', 'RefreshCw', 'Filter', 'Menu', 'MoreHorizontal', 'MoreVertical', 'Info',
  'AlertTriangle', 'AlertCircle', 'CheckCircle', 'XCircle', 'HelpCircle', 'Lock', 'Unlock', 'Eye', 'EyeOff', 'Globe', 'MapPin',
  'ShoppingCart', 'CreditCard', 'DollarSign', 'Tag', 'Package', 'Truck', 'Building', 'Briefcase', 'BarChart', 'PieChart',
  'LineChart', 'TrendingUp', 'TrendingDown', 'Zap', 'Sun', 'Moon', 'Cloud', 'Database', 'Table', 'List', 'Grid', 'Layout',
  'Send', 'MessageSquare', 'LogIn', 'LogOut', 'Play', 'Pause', 'Printer', 'Wifi', 'Flag', 'Gift',
]

/** AnimatedIcon.Heart -> "anim:heart". Member = PascalCase of the animated icon id, value = "anim:<id>". */
export const animatedIconMember = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)
const animatedIconRecord: FxRecord = {}
for (const id of ANIMATED_ICON_IDS) animatedIconRecord[animatedIconMember(id)] = `anim:${id}`

const colorRecord: FxRecord = {}
for (const [name, c] of Object.entries(NAMED_COLORS)) colorRecord[name] = rgba(c[0], c[1], c[2], c[3])

function matchPatterns(): FxRecord {
  return {
    Any: '.', Comma: ',', Digit: '\\d', Email: '.+@.+\\.[^\\.]{2,}', Hyphen: '-', LeftParen: '\\(', Letter: '\\p{L}',
    MultipleDigits: '\\d+', MultipleLetters: '\\p{L}+', MultipleNonSpaces: '\\S+', MultipleSpaces: '\\s+',
    NonSpace: '\\S', OptionalDigits: '\\d*', OptionalLetters: '\\p{L}*', OptionalNonSpaces: '\\S*', OptionalSpaces: '\\s*',
    Period: '\\.', RightParen: '\\)', Space: '\\s',
  }
}

export const ENUM_RECORDS: Record<string, FxRecord> = {
  Color: colorRecord,
  Align: members(['Left', 'Center', 'Right']),
  FontWeight: members(['Normal', 'Semibold', 'Bold']),
  DisplayMode: members(['Edit', 'View', 'Disabled']),
  SortOrder: members(['Ascending', 'Descending']),
  NotificationType: members(['Information', 'Success', 'Warning', 'Error']),
  ButtonStyle: members(['Primary', 'Secondary', 'Outline', 'Ghost', 'Destructive']),
  Anchor: members(['Start', 'End', 'Stretch', 'Center', 'Scale']),
  Layout: members(['Manual', 'Row', 'Column', 'Grid']),
  Justify: members(['Start', 'Center', 'End', 'SpaceBetween', 'SpaceAround']),
  AlignItems: members(['Auto', 'Start', 'Center', 'End', 'Stretch']),
  FormMode: members(['Edit', 'New', 'View']),
  Fit: members(['Cover', 'Contain', 'Fill']),
  Orientation: members(['Horizontal', 'Vertical']),
  Variant: members(['Default', 'Secondary', 'Outline', 'Ghost', 'Destructive']),
  Size: members(['Small', 'Medium', 'Large']),
  Side: members(['Left', 'Right', 'Top', 'Bottom']),
  ChartType: members(['Bar', 'Line', 'Area', 'Pie', 'Donut']),
  TextMode: members(['SingleLine', 'MultiLine', 'Password', 'Number']),
  SelectionMode: members(['None', 'Single', 'Multiple']),
  Icon: members(ICON_NAMES),
  /** Animated (Lottie) icons: AnimatedIcon.Heart is "anim:heart". Accepted wherever an icon name is. */
  AnimatedIcon: animatedIconRecord,
  /** Patterns for IsMatch / Match / MatchAll (regular-expression text). */
  Match: matchPatterns(),
  /** Options for IsMatch / Match / MatchAll. Combine with &, like MatchOptions.Contains & MatchOptions.IgnoreCase. */
  MatchOptions: members(['Complete', 'Contains', 'BeginsWith', 'EndsWith', 'IgnoreCase', 'Multiline']),
}

/** Lets the evaluator report "Color has no member Foo" instead of returning blank. */
export const ENUM_SET: WeakSet<object> = new WeakSet(Object.values(ENUM_RECORDS))

export function enums(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(ENUM_RECORDS)) out[k] = Object.keys(v)
  return out
}
