/**
 * Discussions (P3 package E, spec default 5): the record discussions I follow or was mentioned in, in the page's
 * environment (a record's discussion is its Comments, shown on the record timeline; there is no channel for it).
 * Newest comment first, my unread count (comments by others since I last had the record's timeline open), and a click
 * opens the record in the app it was discussed in. The server reads everything as me: a record I can no longer read
 * is not listed. Live: a change of the Comments table refreshes the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AtSign, Bell, Loader2, MessageSquareText } from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import { cn } from '@/lib/utils'
import { chatApi, errText, type DiscussionItem } from './api'
import { listTime } from './format'

export function Discussions({ className }: { className?: string }) {
  const env = usePlatform((s) => s.environmentId)
  const [items, setItems] = useState<DiscussionItem[] | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const load = useCallback(() => {
    const n = ++seq.current
    chatApi.discussions().then((r) => { if (n === seq.current) { setItems(r.items); setError('') } })
      .catch((e) => { if (n === seq.current) { setItems([]); setError(errText(e)) } })
  }, [])
  useEffect(() => { load() }, [load, env])
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (t) clearTimeout(t)
      t = setTimeout(load, 300)
    }
    const offs = ['table:sys_comments', 'table:sys_follows'].map((topic) => platform.live.subscribe(topic, bump))
    return () => {
      if (t) clearTimeout(t)
      for (const off of offs) off()
    }
  }, [load, env])

  const open = (d: DiscussionItem) => {
    if (!d.link) return
    location.hash = d.link.replace(/^#/, '')
  }

  return (
    <div className={cn('flex min-h-0 flex-col overflow-y-auto overscroll-contain', className)} data-testid="chat-discussions">
      {items === null ? (
        <div className="flex justify-center p-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="chat-discussions-empty">
          <p className="font-medium text-foreground">No discussions yet</p>
          <p className="mt-1 text-xs">Follow a record on its timeline, or be mentioned in a comment, and its discussion shows up here.</p>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <ul className="p-1" aria-label="Record discussions">
          {items.map((d) => (
            <li key={`${d.table}:${d.row}`}>
              <button
                type="button"
                onClick={() => open(d)}
                disabled={!d.link}
                data-testid="chat-discussion"
                data-row={d.row}
                data-unread={d.unread}
                title={d.link ? 'Open the record' : 'Open this record from its app (no comment here says which app it was written in)'}
                className="flex min-h-11 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-md bg-muted"><MessageSquareText className="size-3.5" /></span>
                <span className="min-w-0 flex-1">
                  <span className={cn('flex items-center gap-1 truncate', d.unread > 0 ? 'font-semibold' : 'font-medium')}>
                    <span className="truncate">{d.label || 'A record'}</span>
                    {d.following && <Bell className="size-3 shrink-0 text-muted-foreground" aria-label="Following" />}
                    {d.mentioned && <AtSign className="size-3 shrink-0 text-muted-foreground" aria-label="Mentioned" />}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">{d.tableName}</span>
                  {d.lastText && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{d.lastBy ? `${d.lastBy}: ` : ''}{d.lastText}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="text-[11px] text-muted-foreground">{listTime(d.lastCommentOn)}</span>
                  {d.unread > 0 && <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold text-primary-foreground" data-testid="chat-discussion-unread">{d.unread}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
