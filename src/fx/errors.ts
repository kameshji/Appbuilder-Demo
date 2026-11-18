import type { FxDiagnostic } from '../contracts.ts'

export interface Span { start: number; end: number }

/** Thrown inside the engine; evaluate() converts it to an FxResult. */
export class FxError extends Error {
  start: number
  end: number
  /** fatal errors (unknown names, behaviour in data property...) are not swallowed by IfError */
  fatal: boolean
  /** already re-pointed at a user-defined function call site */
  remapped = false
  constructor(message: string, at: Span, fatal = false) {
    super(message)
    this.start = at.start
    this.end = at.end
    this.fatal = fatal
  }
  toDiagnostic(): FxDiagnostic {
    return { message: this.message, start: this.start, end: this.end }
  }
}

export function fail(at: Span, message: string, fatal = false): never {
  throw new FxError(message, at, fatal)
}
