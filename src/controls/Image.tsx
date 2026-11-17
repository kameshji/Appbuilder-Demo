import { useEffect, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { imageSource } from '@/runtime/attachments'
import { toNum, toText } from './util'

function fitOf(v: string): 'cover' | 'contain' | 'fill' | 'none' {
  switch (v.trim().toLowerCase()) {
    case 'contain': case 'fit': return 'contain'
    case 'fill': case 'stretch': return 'fill'
    case 'none': case 'tile': return 'none'
    default: return 'cover'
  }
}

function ImageRender({ props }: ControlRenderProps) {
  // attachment ids (att_..., a JSON array of ids, or a bare id) resolve through the platform
  const src = imageSource(toText(props.Image))
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const radius = toNum(props.Radius, 0)
  const showImg = src !== '' && !failed
  return (
    <div
      className="flex size-full items-center justify-center overflow-hidden bg-muted text-muted-foreground"
      style={{ borderRadius: radius }}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="size-full select-none"
          style={{ objectFit: fitOf(toText(props.Fit)) }}
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageIcon className="size-1/3 max-h-10 max-w-10 min-h-4 min-w-4 opacity-60" strokeWidth={1.5} />
      )}
    </div>
  )
}

export const Image: ControlType = {
  type: 'Image',
  label: 'Image',
  icon: ImageIcon,
  category: 'Display',
  props: [
    { name: 'Image', kind: 'text', group: 'Content', default: '=""' },
    {
      name: 'Fit',
      kind: 'enum',
      group: 'Style',
      default: '="Cover"',
      options: ['"Cover"', '"Contain"', '"Fill"'],
    },
    { name: 'Radius', kind: 'number', group: 'Style', default: '=0' },
  ],
  outputs: [],
  defaultSize: { width: 160, height: 120 },
  primaryProp: 'Image',
  render: ImageRender,
}
