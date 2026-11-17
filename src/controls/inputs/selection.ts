import { useMemo } from 'react'
import type { ControlRenderProps, FxRecord, FxValue } from '@/contracts'
import { isRecord, toRecords, toText } from '../util'
import { itemText, sameRecord, useDefaultApply } from './shared'

interface Opts {
  props: ControlRenderProps['props']
  outputs: ControlRenderProps['outputs']
  setOutput: ControlRenderProps['setOutput']
  multiple: boolean
  /** record field shown as the item text (blank = auto) */
  field?: string
  /** also maintain the SelectedItems output */
  withItems: boolean
}

/**
 * Selection state for Items-based controls (RadioGroup, ToggleGroup, SegmentedControl, ComboBox).
 * Outputs: Selected (first selected record), SelectedText (", "-joined), SelectedItems (when withItems).
 * The Default prop (item text; comma list in multiple mode) is applied on mount, when it changes
 * and when the selection is cleared from outside (Reset).
 */
export function useItemSelection({ props, outputs, setOutput, multiple, field, withItems }: Opts) {
  const items = useMemo(() => toRecords(props.Items), [props.Items])
  const texts = useMemo(() => items.map((r) => itemText(r, field)), [items, field])
  const textsKey = texts.join('\u0001')
  const def = toText(props.Default)

  const current: FxRecord[] = Array.isArray(outputs.SelectedItems)
    ? toRecords(outputs.SelectedItems)
    : isRecord(outputs.Selected)
      ? [outputs.Selected]
      : []
  const selected: number[] = []
  for (const rec of current) {
    let i = items.findIndex((it) => sameRecord(it, rec))
    if (i < 0) i = texts.indexOf(itemText(rec, field))
    if (i >= 0 && !selected.includes(i)) selected.push(i)
  }
  selected.sort((a, b) => a - b)

  const write = (indices: number[]) => {
    const idx = [...new Set(indices)].filter((i) => i >= 0 && i < items.length).sort((a, b) => a - b)
    const recs = idx.map((i) => items[i])
    setOutput('Selected', (multiple ? recs[0] : recs[recs.length - 1]) ?? null)
    setOutput('SelectedText', idx.map((i) => texts[i]).join(', '))
    if (withItems) setOutput('SelectedItems', recs)
  }

  const sync = useDefaultApply(def + '\u0002' + textsKey + '\u0002' + String(multiple), selected.length === 0, () => {
    if (def === '') return
    const wanted = multiple ? def.split(',').map((s) => s.trim()).filter((s) => s !== '') : [def]
    const idx = wanted.map((w) => texts.indexOf(w)).filter((i) => i >= 0)
    if (idx.length > 0) write(multiple ? idx : [idx[0]])
  })

  return {
    items,
    texts,
    selected,
    /** user-initiated change */
    set(indices: number[]) {
      sync.markBlank(indices.length === 0)
      write(indices)
    },
  }
}

export function toRecordValue(v: FxValue | undefined): FxRecord | null {
  return isRecord(v) ? v : null
}
