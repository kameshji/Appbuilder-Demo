/**
 * A strip under the top bar while an environment the user may enter is being restored from a backup (package J). The
 * server refuses every request to it meanwhile ("being restored"); the live hub announces the start and the end
 * (env message state with restoring), and the environment list says "restoring". While one is restoring the list is
 * read again every few seconds, so the strip goes away when it is done even for people who were moved elsewhere.
 */
import { useEffect, useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { useLiveTopic } from '@/platform/useLive'

export function RestoreNotice() {
  const envs = usePlatform((s) => s.environments)
  const server = usePlatform((s) => s.mode) === 'server'
  const [by, setBy] = useState<string | null>(null)
  const restoring = envs.filter((e) => e.state === 'restoring')
  useLiveTopic(server ? 'env' : null, (m) => {
    if (m.t === 'env' && m.kind === 'state' && m.restoring !== undefined) {
      setBy(m.restoring ? m.by?.name ?? null : null)
      void platform.environments.list().catch(() => [])
    }
  })
  useEffect(() => {
    if (!restoring.length) return
    const t = setInterval(() => { void platform.environments.list().catch(() => []) }, 5000)
    return () => clearInterval(t)
  }, [restoring.length])
  if (!restoring.length) return null
  return (
    <div role="status" data-testid="restore-notice" className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-100">
      <ArchiveRestore className="size-3.5 shrink-0" />
      <span>
        {restoring.map((e) => `"${e.name}"`).join(', ')} {restoring.length === 1 ? 'is' : 'are'} being restored from a backup{by ? ` by ${by}` : ''}. Nothing can be read or changed there until it is done; this page updates when it is.
      </span>
    </div>
  )
}
