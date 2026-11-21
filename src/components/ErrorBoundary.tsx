/**
 * Error boundaries (P3-D). A render error in one part of the page must not blank the whole page: each boundary catches the
 * errors of its subtree and shows a small fallback in place, with a Reload button for that part only.
 *
 *  - The fallback says "This part of the page could not be shown", the request / error reference when the error has one
 *    (a server request id, as the error toasts show), and, outside production, the message and the component stack. The
 *    stack is never shown in a production build.
 *  - `resetKeys`: when any of them changes (the route, the active app tab) the boundary tries its children again.
 *  - The root logs every caught and uncaught error with its component stack (main.tsx: onCaughtError / onUncaughtError,
 *    `logRenderError` below). Nothing is sent to a server: this install has no client-error endpoint.
 *  - Test hook: `window.__abForceCrash(scope)` makes the boundaries whose `scope` is exactly that string throw on their next
 *    render (through the real catch path); `window.__abForceCrash(scope, false)` clears it, and "Reload" clears it for that
 *    part. It only ever breaks the viewer's own page. The exit checks use it (scripts/exit-check/p3-misc.mjs). In a production
 *    build it is inert unless `ab:test-hooks` is "1" in localStorage (testHooksEnabled).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { referenceOf } from '@/platform/errorMessages'
import { testHooksEnabled } from './testHooks'

const forced = new Set<string>()
const listeners = new Set<() => void>()
declare global {
  interface Window { __abForceCrash?: (scope: string, on?: boolean) => void }
}
if (typeof window !== 'undefined') {
  window.__abForceCrash = (scope, on = true) => {
    if (!testHooksEnabled()) return
    if (on) forced.add(scope)
    else forced.delete(scope)
    for (const l of [...listeners]) l()
  }
}

function Crash({ scope }: { scope: string }): ReactNode {
  throw new Error(`Forced crash (test): ${scope}`)
}

/** one line for the console with the component stack (the root's error callbacks and the boundaries use it) */
export function logRenderError(kind: 'caught' | 'uncaught', error: unknown, componentStack?: string | null, scope?: string): void {
  console.error(`[render ${kind}${scope ? ` in ${scope}` : ''}]`, error, componentStack ? `\nComponent stack:${componentStack}` : '')
}

interface Props {
  /** what this boundary protects, for the log and the test hook ("portal-page", "app-tab:<id>", "tile:<id>") */
  scope: string
  /** a change of any of these retries the children */
  resetKeys?: readonly unknown[]
  children: ReactNode
  /** a smaller fallback for a tile or a single UI component */
  compact?: boolean
  className?: string
}
interface State { error: unknown; info: string | null; attempt: number; crash: boolean }

const same = (a: readonly unknown[] = [], b: readonly unknown[] = []): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, attempt: 0, crash: false }
  private sync = (): void => {
    const want = forced.has(this.props.scope)
    if (want !== this.state.crash) this.setState({ crash: want })
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('Unknown error') }
  }

  componentDidMount(): void {
    listeners.add(this.sync)
    this.sync()
  }

  componentDidCatch(_error: unknown, info: ErrorInfo): void {
    // the root's onCaughtError logs it with the component stack; keep the stack for the development fallback
    this.setState({ info: info.componentStack ?? null })
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && !same(prev.resetKeys, this.props.resetKeys)) this.reset()
    if (prev.scope !== this.props.scope) this.sync()
  }

  componentWillUnmount(): void {
    listeners.delete(this.sync)
  }

  private reset = (): void => {
    forced.delete(this.props.scope)
    this.setState((s) => ({ error: null, info: null, crash: false, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    const { error, info, attempt, crash } = this.state
    if (error) {
      const ref = referenceOf(error)
      const dev = import.meta.env.DEV
      const msg = error instanceof Error ? error.message : String(error)
      return (
        <div role="alert" data-testid="error-boundary" data-scope={this.props.scope}
          className={`flex flex-col items-center justify-center gap-2 p-4 text-center ${this.props.compact ? 'size-full min-h-0 text-xs' : 'min-h-40 text-sm'} ${this.props.className ?? ''}`}>
          <TriangleAlert className="size-5 text-destructive" aria-hidden />
          <p className="font-medium">This part of the page could not be shown</p>
          {ref && <p className="text-xs text-muted-foreground" data-testid="error-boundary-ref">Reference: {ref}</p>}
          <button type="button" className="rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-accent" data-testid="error-boundary-reload" onClick={this.reset}>Reload</button>
          {dev && (
            <details className="max-w-full text-left text-[11px] text-muted-foreground">
              <summary>Details (development only)</summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{msg}{info}</pre>
            </details>
          )}
        </div>
      )
    }
    return <div key={attempt} className="contents">{crash ? <Crash scope={this.props.scope} /> : this.props.children}</div>
  }
}
