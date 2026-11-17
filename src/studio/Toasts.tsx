import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useStore } from '@/runtime/store'
import { cn } from '@/lib/utils'

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert }
const TONE = {
  info: 'text-primary',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
}

export function Toasts() {
  const toasts = useStore((s) => s.runtime.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-12 z-[300] flex flex-col items-center gap-2" data-testid="toasts">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <button
            key={t.id}
            type="button"
            data-testid="toast"
            onClick={() => useStore.getState().dismissToast(t.id)}
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
