import { useRef, useState } from 'react'
import { FileUp, Upload, X } from 'lucide-react'
import type { ControlRenderProps, ControlType, FxRecord } from '@/contracts'
import { filesForToken, registerFiles } from '@/runtime/attachments'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { displayModeProp, toBool, toDisplayMode, toNum, toRecords, toText } from '../util'
import { Shell, useFocusToken } from './shared'

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '')
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(file)
  })
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Does `file` satisfy an accept list like ".png,.jpg,image/*"? Blank accepts everything. */
function accepted(file: File, accept: string): boolean {
  const list = accept.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
  if (list.length === 0) return true
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return list.some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a))
}

function FileUploadRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const editable = !design && dm === 'Edit'
  const multiple = toBool(props.Multiple, false)
  const accept = toText(props.Accept)
  const maxMb = Math.max(0, toNum(props.MaxSizeMB, 5))
  const files = toRecords(outputs.Files)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useFocusToken(root, focusToken, design)
  const error = outputs.Error == null ? '' : toText(outputs.Error)
  // The original File objects live in a module-level registry; the FileToken output is the handle a Form
  // (or any runtime code) uses to upload them without base64 round-trips. Reset() clears Files and the token.
  const token = toText(outputs.FileToken)
  const heldFiles = () => {
    const held = filesForToken(token)
    return held.length === files.length ? held : []
  }

  const take = async (list: FileList | File[]) => {
    if (!editable) return
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    const problems: string[] = []
    const ok: File[] = []
    for (const f of incoming) {
      if (!accepted(f, accept)) problems.push(`${f.name}: type not allowed`)
      else if (maxMb > 0 && f.size > maxMb * 1024 * 1024) problems.push(`${f.name}: larger than ${maxMb} MB`)
      else ok.push(f)
    }
    setOutput('Error', problems.join('; '))
    if (ok.length === 0) return
    setBusy(true)
    try {
      const recs: FxRecord[] = []
      const picked = multiple ? ok : ok.slice(0, 1)
      for (const f of picked) {
        recs.push({ Name: f.name, Size: f.size, Type: f.type, DataUrl: await readAsDataUrl(f) })
      }
      const held = multiple ? heldFiles() : []
      setOutput('FileToken', registerFiles(multiple ? [...held, ...picked] : picked, token))
      setOutput('Files', multiple ? [...files, ...recs] : recs)
      fire('OnChange')
    } catch {
      setOutput('Error', 'Could not read the file')
    } finally {
      setBusy(false)
    }
  }

  const remove = (i: number) => {
    if (!editable) return
    const held = heldFiles()
    setOutput('FileToken', registerFiles(held.filter((_, k) => k !== i), token))
    setOutput('Files', files.filter((_, k) => k !== i))
    setOutput('Error', '')
    fire('OnChange')
  }

  return (
    <Shell design={design} rootRef={root}>
      <div
        className={cn(
          'flex size-full flex-col rounded-lg border-2 border-dashed border-input bg-transparent p-3 transition-colors',
          dragging && 'border-primary bg-primary/5',
          dm === 'Disabled' && 'opacity-50',
        )}
        onDragOver={(e) => {
          if (!editable) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!editable) return
          e.preventDefault()
          setDragging(false)
          void take(e.dataTransfer.files)
        }}
      >
        <input
          ref={input}
          type="file"
          hidden
          multiple={multiple}
          accept={accept || undefined}
          onChange={(e) => {
            if (e.target.files) void take(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          disabled={dm !== 'Edit'}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-md text-center text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => input.current?.click()}
        >
          <Upload className="size-5" />
          <span className="font-medium text-foreground">{busy ? 'Reading...' : toText(props.Label)}</span>
          {toText(props.Hint) !== '' && <span className="text-xs">{toText(props.Hint)}</span>}
        </button>
        {error !== '' && <p className="mt-1 truncate text-xs text-destructive">{error}</p>}
        {files.length > 0 && (
          <ul className="mt-2 max-h-[45%] min-h-0 space-y-1 overflow-y-auto">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                <FileUp className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{toText(f.Name)}</span>
                <span className="shrink-0 text-muted-foreground">{sizeText(toNum(f.Size, 0))}</span>
                {dm === 'Edit' && (
                  <Button type="button" variant="ghost" size="icon-sm" className="size-5" aria-label={`Remove ${toText(f.Name)}`} onClick={() => remove(i)}>
                    <X className="size-3" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  )
}

export const FileUpload: ControlType = {
  type: 'FileUpload',
  label: 'File upload',
  icon: FileUp,
  category: 'Input',
  props: [
    { name: 'Label', kind: 'text', group: 'Content', default: '="Drop files here or click to browse"' },
    { name: 'Hint', kind: 'text', group: 'Content', default: '=""', simple: false },
    { name: 'Accept', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Multiple', kind: 'boolean', group: 'Content', default: '=false' },
    { name: 'MaxSizeMB', label: 'Max size (MB)', kind: 'number', group: 'Content', default: '=5' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    displayModeProp,
  ],
  outputs: [
    { name: 'Files', initial: [] },
    { name: 'Error', initial: '' },
    // handle to the original File objects (see src/runtime/attachments.ts); empty when nothing is selected
    { name: 'FileToken', initial: '' },
  ],
  defaultSize: { width: 360, height: 140 },
  primaryProp: 'OnChange',
  render: FileUploadRender,
}
