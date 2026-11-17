import { useEffect, type ReactNode } from 'react'

export interface MenuItem { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', close)
    }
  }, [onClose])
  const left = Math.min(x, window.innerWidth - 190)
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16)
  return (
    <div
      className="fixed z-[200] min-w-[170px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          disabled={it.disabled}
          onClick={() => {
            onClose()
            it.onSelect()
          }}
          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent hover:text-accent-foreground disabled:opacity-40 ${it.danger ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : ''}`}
        >
          <span className="size-3.5 shrink-0 [&_svg]:size-3.5">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  )
}
