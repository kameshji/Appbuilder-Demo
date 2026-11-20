/**
 * Scanning UI components (P2-A, docs/guide/maker/phone-apps.md):
 *  - BarcodeScanner: a button that opens the camera scanner; Value / Format outputs and OnScan. Continuous mode keeps
 *    the scanner open for stock counts (OnScan runs for every code; the same code again only after 2 s).
 *  - ScanInput: a text field that recognises a hardware keyboard-wedge scanner (a fast burst of keys ending with Enter:
 *    OnScan runs, typing by hand only runs OnChange) and has a camera button that fills it by scanning.
 * Both degrade on desktops: no camera or no permission is said in words; the wedge mode works everywhere.
 */
import { useMemo, useRef, useState } from 'react'
import { ScanBarcode, ScanLine } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { displayModeProp, toBool, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { ScannerSheet } from '@/phone/scan/ScannerSheet'
import { parseFormats, type ScanResult } from '@/phone/scan/scanner'
import { WedgeDetector } from '@/phone/scan/wedge'

function BarcodeScannerRender({ props, mode, setOutput, fire, outputs }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const [open, setOpen] = useState(false)
  const fmtText = toText(props.Formats)
  const formats = useMemo(() => parseFormats(fmtText), [fmtText])
  const continuous = toBool(props.Continuous)
  const close = useMemo(() => () => setOpen(false), [])
  const scanned = (r: ScanResult) => {
    setOutput('Value', r.text)
    setOutput('Format', r.format)
    setOutput('ScanCount', (typeof outputs.ScanCount === 'number' ? outputs.ScanCount : 0) + 1)
    fire('OnScan')
  }
  return (
    <>
      <Button
        type="button"
        className="size-full"
        style={{ fontSize: toNum(props.Size, 14), pointerEvents: design ? 'none' : undefined }}
        tabIndex={design ? -1 : undefined}
        disabled={dm !== 'Edit'}
        onClick={() => !design && setOpen(true)}
        data-testid="barcode-scanner-button"
      >
        <ScanBarcode /> {toText(props.Text)}
      </Button>
      {open && <ScannerSheet formats={formats} continuous={continuous} onScan={scanned} onClose={close} />}
    </>
  )
}

export const BarcodeScanner: ControlType = {
  type: 'BarcodeScanner',
  label: 'Barcode scanner',
  icon: ScanBarcode,
  category: 'Input',
  props: [
    { name: 'Text', kind: 'text', group: 'Content', default: '="Scan"' },
    { name: 'Formats', kind: 'text', group: 'Behaviour', default: '="All"' },
    { name: 'Continuous', kind: 'boolean', group: 'Behaviour', default: '=false' },
    { name: 'OnScan', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=15' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }, { name: 'Format', initial: '' }, { name: 'ScanCount', initial: 0 }],
  defaultSize: { width: 160, height: 48 },
  primaryProp: 'OnScan',
  render: BarcodeScannerRender,
}

function ScanInputRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  const wedge = useRef(new WedgeDetector())
  const [open, setOpen] = useState(false)
  const fmtText = toText(props.Formats)
  const formats = useMemo(() => parseFormats(fmtText), [fmtText])
  const close = useMemo(() => () => setOpen(false), [])
  const camera = toBool(props.ShowCamera)
  const scanned = (text: string) => {
    setOutput('Value', text)
    setOutput('ScanCount', (typeof outputs.ScanCount === 'number' ? outputs.ScanCount : 0) + 1)
    fire('OnScan')
  }
  return (
    <div className="flex size-full items-stretch gap-1" style={{ pointerEvents: design ? 'none' : undefined }}>
      <Input
        value={value}
        placeholder={toText(props.Placeholder)}
        tabIndex={design ? -1 : undefined}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-full min-w-0 flex-1"
        style={{ fontSize: toNum(props.Size, 14) }}
        data-testid="scan-input"
        onKeyDown={(e) => {
          if (design) return
          const code = wedge.current.feed(e.key, e.timeStamp || performance.now())
          if (code !== null) {
            e.preventDefault()
            // the scanner typed into the field too: the value becomes exactly the scanned code
            scanned(code)
          } else if (e.key === 'Enter') {
            fire('OnScan')
          }
        }}
        onChange={(e) => {
          if (design) return
          setOutput('Value', e.target.value)
          fire('OnChange')
        }}
      />
      {camera && (
        <Button type="button" variant="outline" className="h-full aspect-square min-w-11 px-0" aria-label="Scan with the camera" disabled={dm !== 'Edit'} tabIndex={design ? -1 : undefined} onClick={() => !design && setOpen(true)} data-testid="scan-input-camera">
          <ScanLine />
        </Button>
      )}
      {open && <ScannerSheet formats={formats} continuous={false} onScan={(r) => scanned(r.text)} onClose={close} />}
    </div>
  )
}

export const ScanInput: ControlType = {
  type: 'ScanInput',
  label: 'Scan input',
  icon: ScanLine,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Scan or type a code"' },
    { name: 'ShowCamera', label: 'Camera button', kind: 'boolean', group: 'Behaviour', default: '=true' },
    { name: 'Formats', kind: 'text', group: 'Behaviour', default: '="All"' },
    { name: 'OnScan', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'Size', kind: 'number', group: 'Style', default: '=15' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }, { name: 'ScanCount', initial: 0 }],
  defaultSize: { width: 280, height: 48 },
  primaryProp: 'OnScan',
  render: ScanInputRender,
}
