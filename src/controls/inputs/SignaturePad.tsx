/**
 * SignaturePad UI component (docs/guide/maker/phone-apps.md "Signatures"): draw with a finger, a stylus or the mouse
 * on a 3:1 pad (src/phone/SignatureCanvas.tsx); Clear starts again.
 *
 * Outputs
 *  - Image: the signature as a PNG data URL ("" when empty): show it in an Image UI component.
 *  - FileToken: the same PNG as a file handle (src/runtime/attachments.ts), for an image or file column:
 *    `Patch(Visits, ThisItem, {Signature: SignaturePad1.FileToken})` stores the row, then uploads the PNG into the
 *    column (offline: both wait in the outbox, the PNG after its row, like a photo).
 *  - HasSignature / IsEmpty: enough ink to count as signed (a stray tap does not).
 * OnSign runs after every stroke that leaves the pad signed. Reset(SignaturePad1) clears it.
 * Inside a Form, list image columns in the Form's SignatureFields instead: the field is a pad of its own.
 */
import { useEffect, useRef } from 'react'
import { Eraser, Signature } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Button } from '@/components/ui/button'
import { registerFiles } from '@/runtime/attachments'
import { SignatureCanvas, type SignatureHandle } from '@/phone/SignatureCanvas'
import { displayModeProp, toBool, toColor, toDisplayMode, toNum, toText } from '../util'

function SignaturePadRender({ props, mode, outputs, setOutput, fire }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const editable = !design && dm === 'Edit'
  const pad = useRef<SignatureHandle>(null)
  const token = useRef('')
  const exported = useRef('')
  const seq = useRef(0)

  // Reset(): the runtime puts the outputs back to their initial values; the drawing follows
  const image = outputs.Image == null ? '' : toText(outputs.Image)
  useEffect(() => {
    if (image === '' && exported.current !== '') {
      exported.current = ''
      pad.current?.clear()
    }
  }, [image])
  useEffect(
    () => () => {
      registerFiles([], token.current)
    },
    [],
  )

  const publish = async (fireSign: boolean) => {
    const n = ++seq.current
    const out = await pad.current?.exportPng(`${toText(props.FileName) || 'signature'}.png`.replace(/\.png\.png$/i, '.png'))
    if (n !== seq.current) return // a newer stroke or a Clear won
    if (!out) {
      token.current = registerFiles([], token.current)
      exported.current = ''
      setOutput('Image', '')
      setOutput('FileToken', '')
      setOutput('HasSignature', false)
      setOutput('IsEmpty', true)
      return
    }
    token.current = registerFiles([out.file], token.current)
    exported.current = out.dataUrl
    setOutput('Image', out.dataUrl)
    setOutput('FileToken', token.current)
    setOutput('HasSignature', true)
    setOutput('IsEmpty', false)
    if (fireSign) fire('OnSign')
  }

  const showClear = toBool(props.ShowClear, true)
  return (
    <div className="flex size-full flex-col gap-1.5" style={{ pointerEvents: design ? 'none' : undefined, opacity: dm === 'Disabled' ? 0.5 : undefined }} data-testid="signature-pad">
      <div className="relative min-h-0 flex-1">
        <SignatureCanvas
          handle={pad}
          disabled={!editable}
          penColor={toColor(props.PenColor) || '#111827'}
          penWidth={toNum(props.PenWidth, 2.5)}
          placeholder={toText(props.Placeholder)}
          onStrokeEnd={() => void publish(true)}
        />
      </div>
      {showClear && (
        <div className="flex shrink-0 justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 min-w-11"
            disabled={!editable}
            tabIndex={design ? -1 : undefined}
            onClick={() => {
              pad.current?.clear()
              void publish(false)
            }}
            data-testid="signature-clear"
          >
            <Eraser /> {toText(props.ClearText) || 'Clear'}
          </Button>
        </div>
      )}
    </div>
  )
}

export const SignaturePad: ControlType = {
  type: 'SignaturePad',
  label: 'Signature pad',
  icon: Signature,
  category: 'Input',
  props: [
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Sign here"' },
    { name: 'ShowClear', label: 'Clear button', kind: 'boolean', group: 'Content', default: '=true' },
    { name: 'ClearText', label: 'Clear button text', kind: 'text', group: 'Content', default: '="Clear"', simple: false },
    { name: 'FileName', label: 'File name', kind: 'text', group: 'Data', default: '="signature"', simple: false },
    { name: 'OnSign', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'PenColor', label: 'Pen colour', kind: 'color', group: 'Style', default: '=Blank()' },
    { name: 'PenWidth', label: 'Pen width', kind: 'number', group: 'Style', default: '=2.5' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Image', initial: '' },
    { name: 'FileToken', initial: '' },
    { name: 'HasSignature', initial: false },
    { name: 'IsEmpty', initial: true },
  ],
  defaultSize: { width: 360, height: 168 },
  primaryProp: 'OnSign',
  render: SignaturePadRender,
}
