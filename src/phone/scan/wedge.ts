/**
 * Hardware "keyboard wedge" scanners (P2-A): a handheld or ring scanner paired as a keyboard types the code very
 * fast and ends it with Enter. A burst is: at least `minLength` printable characters, each within `maxGapMs` of the
 * previous one (people type 80-250 ms apart; scanners 1-30 ms), ending with Enter within `maxGapMs` of the last
 * character. Pure state machine (unit-tested); ScanInput feeds it from keydown.
 */
export interface WedgeOptions {
  maxGapMs?: number
  minLength?: number
}

export class WedgeDetector {
  private buf = ''
  private last = -Infinity
  private fast = true
  private readonly gap: number
  private readonly min: number
  constructor(o: WedgeOptions = {}) {
    this.gap = o.maxGapMs ?? 45
    this.min = o.minLength ?? 3
  }
  /** feed a key; returns the scanned code when this key (Enter) completes a burst, else null */
  feed(key: string, at: number): string | null {
    const dt = at - this.last
    if (key === 'Enter' || key === 'Tab') {
      const code = this.buf
      const ok = this.fast && code.length >= this.min && dt <= this.gap
      this.reset()
      return ok ? code : null
    }
    if (key.length !== 1) return null
    if (dt > this.gap) {
      // a slow key: start a new candidate burst with it
      this.buf = key
      this.fast = true
    } else this.buf += key
    this.last = at
    return null
  }
  reset() {
    this.buf = ''
    this.last = -Infinity
    this.fast = true
  }
}
