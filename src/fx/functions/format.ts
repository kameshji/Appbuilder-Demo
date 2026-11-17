import { pad } from '../values'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function roundHalfAway(x: number, digits: number): number {
  const sign = x < 0 ? -1 : 1
  const abs = Math.abs(x)
  const s = String(abs)
  if (s.includes('e')) {
    const f = Math.pow(10, digits)
    return (sign * Math.round(abs * f)) / f
  }
  const shifted = Number(s + 'e' + digits)
  return sign * Number(Math.round(shifted) + 'e' + -digits)
}

export function looksLikeDateFormat(fmt: string): boolean {
  return !/[0#]/.test(fmt) && /[ymdhs]/i.test(fmt)
}

export function formatNumber(n: number, fmt: string): string {
  const firstDigit = fmt.search(/[0#.]/)
  if (firstDigit < 0) return fmt
  let lastDigit = -1
  for (let i = fmt.length - 1; i >= 0; i--) {
    if ('0#.,'.includes(fmt[i]!)) { lastDigit = i; break }
  }
  const prefix = fmt.slice(0, firstDigit)
  const body = fmt.slice(firstDigit, lastDigit + 1)
  const suffix = fmt.slice(lastDigit + 1)
  const pct = (prefix + suffix).includes('%')
  const [intPart = '', decPart = ''] = body.split('.')
  const grouping = intPart.includes(',')
  const minInt = (intPart.match(/0/g) ?? []).length
  const maxDec = (decPart.match(/[0#]/g) ?? []).length
  const minDec = (decPart.match(/0/g) ?? []).length
  let v = pct ? n * 100 : n
  const neg = v < 0
  v = roundHalfAway(Math.abs(v), maxDec)
  let [ip = '0', dp = ''] = v.toFixed(maxDec).split('.')
  while (dp.length > minDec && dp.endsWith('0')) dp = dp.slice(0, -1)
  if (ip === '0' && minInt === 0 && (dp.length > 0 || !body.includes('0'))) ip = ''
  if (ip.length < minInt) ip = ip.padStart(minInt, '0')
  if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const isZero = ip.replace(/[0,]/g, '') === '' && dp.replace(/0/g, '') === ''
  return (neg && !isZero ? '-' : '') + prefix + ip + (dp ? '.' + dp : '') + suffix
}

type Tok = { kind: string; text: string }

export function formatDate(d: Date, fmt: string): string {
  if (Number.isNaN(d.getTime())) return ''
  const toks: Tok[] = []
  let i = 0
  const lower = fmt.toLowerCase()
  while (i < fmt.length) {
    const ch = lower[i]!
    if (fmt[i] === '\\' && i + 1 < fmt.length) { toks.push({ kind: 'lit', text: fmt[i + 1]! }); i += 2; continue }
    if (lower.startsWith('am/pm', i)) { toks.push({ kind: 'ampm', text: fmt.slice(i, i + 5) }); i += 5; continue }
    if (lower.startsWith('a/p', i)) { toks.push({ kind: 'ap', text: fmt.slice(i, i + 3) }); i += 3; continue }
    if ('ymdhsn'.includes(ch)) {
      let j = i
      while (j < fmt.length && lower[j] === ch) j++
      toks.push({ kind: ch, text: fmt.slice(i, j) })
      i = j
      continue
    }
    toks.push({ kind: 'lit', text: fmt[i]! })
    i++
  }
  const twelve = toks.some((t) => t.kind === 'ampm' || t.kind === 'ap')
  // m after h, or before s, is minutes
  const sig = toks.filter((t) => t.kind !== 'lit')
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k]!
    if (t.kind === 'm' && t.text.length <= 2) {
      const prev = sig[k - 1]
      const nxt = sig[k + 1]
      if ((prev && prev.kind === 'h') || (nxt && nxt.kind === 's')) t.kind = 'n'
    }
  }
  const h24 = d.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  let out = ''
  for (const t of toks) {
    const n = t.text.length
    switch (t.kind) {
      case 'y': out += n <= 2 ? pad(d.getFullYear() % 100) : pad(d.getFullYear(), 4); break
      case 'm': out += n === 1 ? String(d.getMonth() + 1) : n === 2 ? pad(d.getMonth() + 1) : n === 3 ? MONTHS[d.getMonth()]!.slice(0, 3) : MONTHS[d.getMonth()]!; break
      case 'd': out += n === 1 ? String(d.getDate()) : n === 2 ? pad(d.getDate()) : n === 3 ? DAYS[d.getDay()]!.slice(0, 3) : DAYS[d.getDay()]!; break
      case 'h': { const h = twelve ? h12 : h24; out += n === 1 ? String(h) : pad(h); break }
      case 'n': out += n === 1 ? String(d.getMinutes()) : pad(d.getMinutes()); break
      case 's': out += n === 1 ? String(d.getSeconds()) : pad(d.getSeconds()); break
      case 'ampm': { const s = h24 < 12 ? 'AM' : 'PM'; out += t.text === t.text.toLowerCase() ? s.toLowerCase() : s; break }
      case 'ap': { const s = h24 < 12 ? 'A' : 'P'; out += t.text === t.text.toLowerCase() ? s.toLowerCase() : s; break }
      default: out += t.text
    }
  }
  return out
}
