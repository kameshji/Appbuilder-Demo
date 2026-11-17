import { useRef } from 'react'
import { CalendarDays } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { displayModeProp, toBool, toDisplayMode, toNum, toText } from '../util'
import { Shell, dateKey, startOfDay, toDate, useDefaultApply, useFocusToken } from './shared'
import { DatePopover } from './DatePopover'

function DatePickerRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const defRaw = toDate(props.Default)
  const def = defRaw ? startOfDay(defRaw) : null
  const sync = useDefaultApply(dateKey(def), outputs.SelectedDate == null, () => setOutput('SelectedDate', def))
  const stored = toDate(outputs.SelectedDate)
  const value = outputs.SelectedDate == null ? (sync.isUserBlank() ? null : def) : stored
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  return (
    <Shell design={design} rootRef={root}>
      <DatePopover
        value={value}
        min={toDate(props.Min)}
        max={toDate(props.Max)}
        format={toText(props.Format)}
        placeholder={toText(props.Placeholder)}
        disabled={dm === 'Disabled'}
        readOnly={design || dm === 'View'}
        clearable={toBool(props.Clearable, true)}
        fontSize={toNum(props.Size, 14)}
        onChange={(d) => {
          if (design) return
          sync.markBlank(d == null)
          setOutput('SelectedDate', d)
          fire('OnChange')
        }}
      />
    </Shell>
  )
}

export const DatePicker: ControlType = {
  type: 'DatePicker',
  label: 'Date picker',
  icon: CalendarDays,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'any', group: 'Content', default: '=Blank()' },
    { name: 'Min', kind: 'any', group: 'Content', default: '=Blank()' },
    { name: 'Max', kind: 'any', group: 'Content', default: '=Blank()' },
    { name: 'Format', kind: 'text', group: 'Content', default: '="yyyy-mm-dd"' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Pick a date"' },
    { name: 'Clearable', kind: 'boolean', group: 'Content', default: '=true', simple: false },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'SelectedDate', initial: null }],
  defaultSize: { width: 240, height: 40 },
  primaryProp: 'Default',
  render: DatePickerRender,
}
