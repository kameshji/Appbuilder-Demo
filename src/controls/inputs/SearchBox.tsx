import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import type { ControlRenderProps, ControlType } from '@/contracts'
import { Input } from '@/components/ui/input'
import { displayModeProp, toBool, toDisplayMode, toNum, toText, useDefaultSync } from '../util'
import { Shell, useFocusToken } from './shared'

function SearchBoxRender({ props, mode, outputs, setOutput, fire, focusToken }: ControlRenderProps) {
  const design = mode === 'design'
  const dm = toDisplayMode(props.DisplayMode)
  const def = toText(props.Default)
  useDefaultSync(def, outputs.Value, '', (v) => setOutput('Value', v))
  const value = outputs.Value == null ? def : toText(outputs.Value)
  const root = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useFocusToken(root, focusToken, design)
  const searchOnType = toBool(props.SearchOnType, false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const editable = !design && dm === 'Edit'

  const change = (v: string) => {
    setOutput('Value', v)
    fire('OnChange')
    if (searchOnType) {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => fire('OnSearch'), 300)
    }
  }

  return (
    <Shell design={design} rootRef={root} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={toText(props.Placeholder)}
        readOnly={design || dm === 'View'}
        disabled={dm === 'Disabled'}
        className="h-full w-full pl-9 pr-9"
        style={{ fontSize: toNum(props.Size, 14) }}
        onChange={(e) => {
          if (!editable) return
          change(e.target.value)
        }}
        onKeyDown={(e) => {
          if (!editable) return
          if (e.key === 'Enter') {
            clearTimeout(timer.current)
            fire('OnSearch')
          } else if (e.key === 'Escape' && value !== '') {
            change('')
            fire('OnSearch')
          }
        }}
      />
      {value !== '' && dm === 'Edit' && (
        <button
          type="button"
          tabIndex={design ? -1 : undefined}
          aria-label="Clear search"
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (!editable) return
            change('')
            fire('OnSearch')
            inputRef.current?.focus()
          }}
        >
          <X className="size-4" />
        </button>
      )}
    </Shell>
  )
}

export const SearchBox: ControlType = {
  type: 'SearchBox',
  label: 'Search box',
  icon: Search,
  category: 'Input',
  props: [
    { name: 'Default', kind: 'text', group: 'Content', default: '=""' },
    { name: 'Placeholder', kind: 'text', group: 'Content', default: '="Search..."' },
    { name: 'OnChange', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'OnSearch', kind: 'action', group: 'Behaviour', default: '=false' },
    { name: 'SearchOnType', label: 'Search while typing', kind: 'boolean', group: 'Behaviour', default: '=false', simple: false },
    { name: 'Size', kind: 'number', group: 'Style', default: '=14' },
    displayModeProp,
  ],
  outputs: [{ name: 'Value', initial: '' }],
  defaultSize: { width: 280, height: 40 },
  primaryProp: 'OnSearch',
  render: SearchBoxRender,
}
