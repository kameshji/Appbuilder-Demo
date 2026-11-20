/**
 * A Form field that is signed instead of uploaded (Form `SignatureFields`, docs/dev/phone.md "Signature pad"): an image
 * (or file) column gets a 3:1 signature pad. The signature becomes the field's pending file (signature.png), uploaded
 * after the row is saved exactly like a photo, so offline it waits in the outbox after its row. An existing signature
 * (or a restored draft's) is shown as a picture with "Sign again".
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eraser, PenLine } from 'lucide-react'
import type { ColumnDef } from '@/platform/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { attachmentIds, attachmentUrl, useAttachmentRefs } from '@/runtime/attachments'
import { SignatureCanvas, type SignatureHandle } from '@/phone/SignatureCanvas'
import { useDevice } from '@/phone/env'

interface Props {
  col: ColumnDef
  id: string
  existing: string
  pending: File[]
  invalid: boolean
  onPendingChange(files: File[]): void
  onTouch(): void
}

function Preview({ src, label }: { src: string; label: string }) {
  return <img src={src} alt={label} className="h-full w-full rounded-md border border-input bg-white object-contain" data-testid="signature-preview" />
}

export function SignatureField({ col, id, existing, pending, invalid, onPendingChange, onTouch }: Props) {
  const ids = attachmentIds(existing)
  const refs = useAttachmentRefs(ids.slice(0, 1))
  const pad = useRef<SignatureHandle>(null)
  const [signing, setSigning] = useState(false)
  const touch = useDevice().touch
  const seq = useRef(0)
  const pendingUrl = useMemo(() => (pending[0] ? URL.createObjectURL(pending[0]) : ''), [pending])
  useEffect(() => () => (pendingUrl ? URL.revokeObjectURL(pendingUrl) : undefined), [pendingUrl])

  const existingUrl = ids[0] ? (refs[ids[0]]?.url || attachmentUrl(ids[0])) : ''
  const showPad = signing || (pending.length === 0 && ids.length === 0)
  const label = `${col.displayName || col.name}: signature`

  const take = async () => {
    const n = ++seq.current
    const out = await pad.current?.exportPng(`${col.name}-signature.png`)
    if (n !== seq.current) return
    onPendingChange(out ? [out.file] : [])
    onTouch()
  }

  return (
    <div className={cn('space-y-1.5 rounded-md border border-dashed border-input p-2', invalid && 'border-destructive')} data-testid={`signature-field-${col.name}`}>
      <div className="relative w-full" style={{ aspectRatio: '3 / 1' }} id={id}>
        {showPad ? (
          <SignatureCanvas handle={pad} placeholder="Sign here" testId={`signature-canvas-${col.name}`} onStrokeEnd={() => { setSigning(true); void take() }} />
        ) : (
          <Preview src={pendingUrl || existingUrl} label={label} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {showPad ? (
          <Button type="button" variant="outline" size="xs" className={touch ? 'min-h-9' : undefined} onClick={() => { seq.current++; pad.current?.clear(); onPendingChange([]); onTouch() }} data-testid={`signature-clear-${col.name}`}>
            <Eraser /> Clear
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={touch ? 'min-h-9' : undefined}
            onClick={() => {
              // the old signature stays until a new one is drawn (the Form replaces it on save)
              setSigning(true)
              onPendingChange([])
              onTouch()
            }}
            data-testid={`signature-again-${col.name}`}
          >
            <PenLine /> Sign again
          </Button>
        )}
        {pending.length > 0 && <span className="text-[11px] text-muted-foreground">uploads on save</span>}
      </div>
    </div>
  )
}
