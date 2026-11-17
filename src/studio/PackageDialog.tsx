import { useEffect, useRef, useState } from 'react'
import { Copy, Download, FileUp, Loader2 } from 'lucide-react'
import { platform } from '@/platform'
import { go } from '@/router'
import { useStore } from '@/runtime/store'
import { useUi } from '@/runtime/ui'
import { copyText } from '@/runtime/host'
import { downloadText, safeFileName } from '@/runtime/persist'
import { errorMessage } from '@/runtime/data'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function PackageDialog() {
  const open = useUi((s) => s.packageOpen)
  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && useUi.setState({ packageOpen: null })}>
      {open === 'export' && <ExportBody />}
      {open === 'import' && <ImportBody />}
    </Dialog>
  )
}

function ExportBody() {
  const appId = useStore((s) => s.appId)
  const name = useStore((s) => s.app.name)
  const [includeData, setIncludeData] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!appId) return
    let alive = true
    setText(null)
    // flush the latest edit first so the package matches what is on screen
    void platform.apps
      .save(appId, JSON.parse(JSON.stringify(useStore.getState().app)))
      .then(() => platform.apps.exportPackage(appId, { includeData }))
      .then((t) => alive && setText(t))
      .catch((e: unknown) => alive && setError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [appId, includeData])
  return (
    <DialogContent className="max-w-[720px]" data-testid="export-dialog">
      <DialogHeader>
        <DialogTitle>Export package</DialogTitle>
        <DialogDescription>A YAML package with the app and the schemas of the tables it uses.</DialogDescription>
      </DialogHeader>
      <label className="flex items-center gap-2 text-xs">
        <Switch checked={includeData} onCheckedChange={setIncludeData} /> Include table rows
      </label>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : text === null ? (
        <div className="grid h-64 place-items-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : (
        <Textarea readOnly value={text} rows={16} className="font-mono text-[11px]" data-testid="export-text" />
      )}
      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          disabled={!text}
          data-testid="export-copy"
          onClick={() => {
            if (!text) return
            copyText(text)
            useStore.getState().notify('Package copied to the clipboard', 'success')
          }}
        >
          <Copy /> Copy
        </Button>
        <Button size="sm" disabled={!text} onClick={() => text && downloadText(`${safeFileName(name)}.app.yaml`, text, 'application/yaml')}>
          <Download /> Download
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function ImportBody() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const meta = await platform.apps.importPackage(text)
      useUi.setState({ packageOpen: null })
      useStore.getState().notify(`Imported "${meta.name}"`, 'success')
      go({ page: 'studio', id: meta.id })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogContent className="max-w-[720px]" data-testid="import-dialog">
      <DialogHeader>
        <DialogTitle>Import package</DialogTitle>
        <DialogDescription>Paste an app package (YAML) or choose a file. Importing creates a new app and opens it.</DialogDescription>
      </DialogHeader>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} placeholder="kind: appbuilder/app" className="font-mono text-[11px]" data-testid="import-text" />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <input
          ref={file}
          type="file"
          accept=".yaml,.yml,text/yaml"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f) setText(await f.text())
            e.target.value = ''
          }}
        />
        <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
          <FileUp /> Choose file
        </Button>
        <Button size="sm" disabled={!text.trim() || busy} onClick={() => void run()} data-testid="import-run">
          {busy && <Loader2 className="animate-spin" />} Import
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
