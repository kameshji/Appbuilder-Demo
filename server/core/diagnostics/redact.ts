/**
 * Redaction for anything that leaves the machine in a diagnostics bundle or a log download (package L).
 * Text: passwords in connection strings and key=value / JSON pairs, the setup code, session cookies and bearer tokens,
 * API keys, SCRAM verifiers, PEM keys, long hex keys, the sealed-secret format; e-mail addresses are masked (first letter
 * and domain kept). Objects: values of keys that name a secret are replaced. Unit-tested in diagnostics.test.ts.
 */

export const REDACTED = '[redacted]'

const SECRET_KEY_RE = /pass(word|phrase)?|secret|token|api[-_]?key|private|sealed|cookie|authorization|credential|^key$|setup[-_]?code|pgpassword|verifier/i

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM blocks (private keys, certificates are harmless but long)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // user:password@ in URLs (postgres://, mysql://, smtp://, https://)
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // the first-run setup code banner and log line
  [/(SETUP CODE:\s*)[A-Z0-9]{4}-?[A-Z0-9]{4}/gi, `$1${REDACTED}`],
  [/(Setup code:\s*)[A-Z0-9]{4}-?[A-Z0-9]{4}/g, `$1${REDACTED}`],
  [/("?setupCode"?\s*[:=]\s*"?)[A-Za-z0-9-]{4,}/g, `$1${REDACTED}`],
  // session cookies and bearer tokens
  [/(ab_session=)[^;\s"]+/g, `$1${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // API keys abk_<prefix>_<secret>: keep the prefix (it identifies the key, stored in clear)
  [/\b(abk_[A-Za-z0-9]{8}_)[A-Za-z0-9_-]{10,}/g, `$1${REDACTED}`],
  // SCRAM verifiers
  [/SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, REDACTED],
  // sealed secrets (SecretBox: v1.<iv>.<tag>.<data> or similar dotted base64) after a key naming them
  [/("?[A-Za-z_]*[Ss]ealed"?\s*[:=]\s*"?)[^",\s}]+/g, `$1${REDACTED}`],
  // key=value and "key": "value" pairs whose key names a secret
  // (also inside JSON that was itself put into a JSON string: \"password\":\"x\")
  [/(\\?"?(?:[A-Za-z_]*(?:password|passphrase|secret|token|apikey|api_key|PGPASSWORD|privateKey)[A-Za-z_]*)\\?"?\s*[:=]\s*)(\\?"[^"]*"|'[^']*'|[^\s,;}&\\]+)/gi, `$1${REDACTED}`],
  // 64-hex keys (the install key, APPBUILDER_SECRET_KEY) and long hex tokens
  [/\b[0-9a-fA-F]{64}\b/g, REDACTED],
  // e-mail addresses: a***@example.com
  [/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first: string, domain: string) => `${first}***@${domain}`],
]

export function redactText(text: string): string {
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, rep as string)
  return out
}

/** deep copy with secret-named keys replaced and every string value passed through redactText */
export function redactObject<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key && SECRET_KEY_RE.test(key) && v !== null && v !== undefined && v !== '' && typeof v !== 'boolean') return REDACTED
    if (typeof v === 'string') return redactText(v)
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k)
      return o
    }
    return v
  }
  return walk(value) as T
}
