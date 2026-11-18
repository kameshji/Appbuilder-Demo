import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useAppStore, useAppStoreApi } from '@/runtime/context'
import { cn } from '@/lib/utils'

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert }
const TONE = {
  info: 'text-primary',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
}

/** `contained`: positioned inside the nearest relative parent (an app tab) instead of the window */
export function Toasts({ contained = false }: { contained?: boolean }) {
  const store = useAppStoreApi()
  const toasts = useAppStore((s) => s.runtime.toasts)
  return (
    <div className={cn('pointer-events-none inset-x-0 bottom-12 z-[300] flex flex-col items-center gap-2', contained ? 'absolute' : 'fixed')} data-testid="toasts">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <button
            key={t.id}
            type="button"
            data-testid="toast"
            onClick={() => store.getState().dismissToast(t.id)}
            className="pointer-events-auto flex max-w-[480px] items-center gap-2 rounded-lg border border-border bg-popover px-3.5 py-2 text-left text-sm text-popover-foreground shadow-lg"
          >
            <Icon className={cn('size-4 shrink-0', TONE[t.kind])} />
            <span>{t.message}</span>
          </button>
        )
      })}
    </div>
  )
}
