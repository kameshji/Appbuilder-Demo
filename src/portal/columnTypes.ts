import { AtSign, Calendar, CalendarClock, CircleDot, DollarSign, Hash, Image as ImageIcon, Link as LinkIcon, ListChecks, Phone, Pilcrow, Search, ToggleLeft, Type, Binary, Paperclip, Percent, type LucideIcon } from 'lucide-react'
import type { ColumnType } from '@/platform'

export const TYPE_INFO: Record<ColumnType, { label: string; icon: LucideIcon }> = {
  text: { label: 'Single line of text', icon: Type },
  multiline: { label: 'Multiple lines of text', icon: Pilcrow },
  email: { label: 'Email', icon: AtSign },
  url: { label: 'URL', icon: LinkIcon },
  phone: { label: 'Phone', icon: Phone },
  number: { label: 'Whole number', icon: Hash },
  decimal: { label: 'Decimal number', icon: Percent },
  currency: { label: 'Currency', icon: DollarSign },
  boolean: { label: 'Yes / No', icon: ToggleLeft },
  date: { label: 'Date', icon: Calendar },
  datetime: { label: 'Date and time', icon: CalendarClock },
  choice: { label: 'Choice', icon: ListChecks },
  lookup: { label: 'Lookup (link to table)', icon: Search },
  image: { label: 'Image', icon: ImageIcon },
  file: { label: 'File attachment', icon: Paperclip },
  autonumber: { label: 'Autonumber', icon: Binary },
}

export const TYPE_GROUPS: { label: string; types: ColumnType[] }[] = [
  { label: 'Text', types: ['text', 'multiline', 'email', 'url', 'phone'] },
  { label: 'Numbers', types: ['number', 'decimal', 'currency', 'autonumber'] },
  { label: 'Date and time', types: ['date', 'datetime'] },
  { label: 'Other', types: ['boolean', 'choice', 'lookup', 'image', 'file'] },
]

export const FallbackIcon = CircleDot
