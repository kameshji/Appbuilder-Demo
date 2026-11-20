import { Printer } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button as UiButton } from '@/components/ui/button'
import { isRecord } from '@/fx/values'
import { printCall } from '@/print/runtime'
import { displayModeProp, toDisplayMode, toNum, toText } from '../util'

/** P2-B: prints a record with a print template (the PDF opens in a new tab; on a phone it is downloaded) */
function PrintButtonRender({ props, mode, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const rec = props.Record
  const recordId = isRecord(rec) ? (typeof rec.__id === 'string' ? rec.__id : typeof rec.id === 'string' ? rec.id : null) : typeof rec === 'string' && rec ? rec : null
  return (
    <UiButton
      variant="outline"
      tabIndex={design ? -1 : undefined}
      disabled={dm === 'Disabled' || !toText(props.Template).trim()}
      className="size-full min-w-0 gap-1.5 overflow-hidden px-3 py-0"
      style={{ fontSize: toNum(props.Size, 14), borderRadius: toNum(props.Radius, 8), pointerEvents: design ? 'none' : undefined }}
      data-testid="print-button"
      onClick={() => {
        if (design || dm !== 'Edit') return
        void printCall(toText(props.Template).trim(), recordId)
        fire('OnSelect')
      }}
    >
      <Printer className="size-4 shrink-0" />
      <span className="truncate">{toText(props.Text)}</span>
    </UiButton>
  )
}

export const PrintButton: ControlType = {
  type: 'PrintButton',
  label: 'Print button',
  icon: Printer,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Print"' },
    { name: 'Template', kind: 'text', group: 'Data', default: '=""' },
    { name: 'Record', kind: 'record', group: 'Data', default: '=Blank()', simple: false },
    { name: 'OnSelect', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=8' },
    displayModeProp,
  ],
  outputs: [],
  defaultSize: { width: 120, height: 40 },
  primaryProp: 'Template',
  render: PrintButtonRender,
}
