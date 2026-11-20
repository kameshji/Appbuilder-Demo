/**
 * The Email connector (kind `email`): action `send` through the install's SMTP relay (Admin console > Email; the mail
 * service queues it as a `mail.send` job with retries).
 *
 * Settings: fromName (sender name; the address is the relay's), replyTo, perHour, perDay (this connection's limits,
 * never above the environment's). No secret: the relay's credentials belong to the install.
 *
 * Limits per environment (all Email connections together, recipients counted): APPBUILDER_EMAIL_PER_HOUR (default
 * 200) and APPBUILDER_EMAIL_PER_DAY (default 1000). Above them `send` answers `limit` (retryable later).
 * Suppressed addresses (suppressions.ts) are dropped; when no recipient is left the action fails (`denied`).
 * Attachments: attachment ids (the run-as identity must be able to open the row and column, like the download route)
 * or generated files (text or base64 content), at most 10 files and 10 MB in all.
 */
import type { ConnectionRecord } from '../contracts.ts'
import type { ActionProvider } from './service.ts'
import { OutboundError } from './outbound.ts'
import { SEND_ACTION } from './builtin-defs.ts'
export { SEND_ACTION }
import { identity as identityOf } from '../identity/index.ts'
import { safeFileName, validAddress } from '../identity/smtp.ts'
import { suppressedAmong } from './suppressions.ts'
import { visibleAttachment } from '../attachments.ts'
import { currentEnvironment } from '../env-context.ts'
import { richTextToPlain, sanitizeRichText } from '../../../src/platform/system-tables.ts'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_RECIPIENTS = 50

export function environmentEmailLimits(env: NodeJS.ProcessEnv = process.env): { perHour: number; perDay: number } {
  const n = (v: string | undefined, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return { perHour: n(env.APPBUILDER_EMAIL_PER_HOUR, 200), perDay: n(env.APPBUILDER_EMAIL_PER_DAY, 1000) }
}

const num = (v: string | undefined): number | null => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null)

export function createEmailProvider(): ActionProvider {
  return {
    kind: 'email',
    label: 'Email',
    description: 'Sends email through the install\'s mail relay (Admin console > Email), with sending limits and the suppression list.',
    tables: false,
    builtin: () => [SEND_ACTION],
    checkSettings(st) {
      const out: string[] = []
      if (st.replyTo && !validAddress(st.replyTo)) out.push('The reply-to address is not valid.')
      if (st.fromName && (/[\r\n]/.test(st.fromName) || st.fromName.length > 100)) out.push('The sender name is one line of at most 100 characters.')
      for (const k of ['perHour', 'perDay']) if (st[k] && num(st[k]) === null) out.push(`${k} must be a whole number above 0.`)
      return out
    },
    secrets: () => [],
    limits: () => ({ perMinute: 120, maxConcurrent: 4, maxTimeoutMs: 30_000, maxInputBytes: 15 * 1024 * 1024 }),
    async test({ services }) {
      const ok = await identityOf(services).mail.configured()
      return ok ? { ok: true, message: 'The mail relay is set up; messages are queued and sent with retries.' } : { ok: false, message: 'Email is not set up: an install administrator sets up the SMTP relay in Admin console > Email.' }
    },
    async invoke(call) {
      const { services, inputs, connection } = call
      const mail = identityOf(services).mail
      if (!(await mail.configured())) throw new OutboundError('unavailable', 'Email is not set up: an install administrator sets up the SMTP relay in Admin console > Email.', true)
      const db = services.state.db
      if (!db) throw new OutboundError('unavailable', 'The database is not available.', true)
      const lower = (list: unknown): string[] => (Array.isArray(list) ? list : list ? [list] : []).map((a) => String(a).trim().toLowerCase()).filter(Boolean)
      const to = lower(inputs.to)
      const cc = lower(inputs.cc)
      const bcc = lower(inputs.bcc)
      const all = [...new Set([...to, ...cc, ...bcc])]
      if (all.length > MAX_RECIPIENTS) throw new OutboundError('invalid_input', `At most ${MAX_RECIPIENTS} recipients per email.`)
      const suppressed = await suppressedAmong(db, all)
      const keep = (l: string[]) => l.filter((a) => !suppressed.has(a))
      const [t2, c2, b2] = [keep(to), keep(cc), keep(bcc)]
      const count = new Set([...t2, ...c2, ...b2]).size
      call.note({ recipients: count, ...(suppressed.size ? { suppressed: suppressed.size } : {}) })
      if (!count) throw new OutboundError('denied', 'Every recipient is on the suppression list; nothing was sent.')
      // limits: the environment's, and this connection's when lower (recipients counted over all Email connections)
      const envLim = environmentEmailLimits()
      const perHour = Math.min(envLim.perHour, num(connection.settings?.perHour) ?? envLim.perHour)
      const perDay = Math.min(envLim.perDay, num(connection.settings?.perDay) ?? envLim.perDay)
      const schema = `"${currentEnvironment().schema}"`
      const used = await db.query<{ h: number; d: number }>(
        `SELECT COALESCE(sum((r.details->>'recipients')::int) FILTER (WHERE r.at > now() - interval '1 hour'), 0)::int AS h,
                COALESCE(sum((r.details->>'recipients')::int), 0)::int AS d
           FROM ${schema}."ab_action_runs" r JOIN ${schema}."ab_connections" c ON c.id = r.connection_id
          WHERE c.connector = 'email' AND r.status = 'ok' AND NOT r.replayed AND r.at > now() - interval '1 day'`,
      )
      const h = Number(used[0]?.h ?? 0)
      const d = Number(used[0]?.d ?? 0)
      if (h + count > perHour) throw new OutboundError('limit', `The email limit of this environment is ${perHour} recipients an hour (${h} used); the message was not sent. Try again later.`, true)
      if (d + count > perDay) throw new OutboundError('limit', `The email limit of this environment is ${perDay} recipients a day (${d} used); the message was not sent.`, true)
      // attachments
      const files: { fileName: string; contentType: string; content: Buffer }[] = []
      let total = 0
      for (const a of (inputs.attachments as Record<string, unknown>[] | undefined) ?? []) {
        let f: { fileName: string; contentType: string; content: Buffer }
        if (typeof a.attachmentId === 'string' && a.attachmentId) {
          const rec = await services.meta.attachments.get(a.attachmentId)
          const ok = rec && (call.identity ? await visibleAttachment(services, call.identity, rec) : await services.meta.tables.get(rec.tableId))
          if (!rec || !ok) throw new OutboundError('denied', `The attachment "${a.attachmentId.slice(0, 40)}" was not found or may not be opened by ${call.identity ? call.identity.user.name : 'the system'}.`)
          if (rec.sizeBytes > MAX_ATTACHMENT_BYTES) throw new OutboundError('too_large', `"${rec.fileName}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
          const chunks: Buffer[] = []
          for await (const c of services.attachments.open(rec.storageKey) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
          f = { fileName: typeof a.fileName === 'string' && a.fileName ? a.fileName : rec.fileName, contentType: rec.mime || 'application/octet-stream', content: Buffer.concat(chunks) }
        } else if (typeof a.fileToken === 'string' && a.fileToken) {
          // P2-B: a generated document (print templates: GeneratePdf, the flow step document.generate), its creator only
          const print = (services as { print?: { fileFor(t: string, who: unknown): Promise<{ row: Record<string, unknown>; bytes: Buffer }> } }).print
          if (!print) throw new OutboundError('unavailable', 'Generated documents are not available on this server.')
          const g = await print.fileFor(a.fileToken, call.identity ?? null).catch((e: Error) => { throw new OutboundError('denied', `The generated file was not found or may not be sent by ${call.identity ? call.identity.user.name : 'the system'}: ${e.message}`) })
          if (g.bytes.length > MAX_ATTACHMENT_BYTES) throw new OutboundError('too_large', `"${String(g.row.file_name)}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
          f = { fileName: typeof a.fileName === 'string' && a.fileName ? a.fileName : String(g.row.file_name), contentType: String(g.row.mime || 'application/pdf'), content: g.bytes }
        } else if (typeof a.text === 'string' || typeof a.base64 === 'string') {
          if (typeof a.fileName !== 'string' || !a.fileName.trim()) throw new OutboundError('invalid_input', 'A generated attachment needs a file name.')
          const content = typeof a.text === 'string' ? Buffer.from(a.text, 'utf8') : Buffer.from(String(a.base64), 'base64')
          f = { fileName: a.fileName, contentType: typeof a.contentType === 'string' && a.contentType ? a.contentType : typeof a.text === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream', content }
        } else throw new OutboundError('invalid_input', 'An attachment needs an attachmentId, a fileToken (a generated document), or a fileName with text or base64 content.')
        total += f.content.length
        if (total > MAX_ATTACHMENT_BYTES) throw new OutboundError('too_large', `Attachments may be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in all.`)
        files.push({ ...f, fileName: safeFileName(f.fileName), contentType: f.contentType.split(';')[0].trim() || 'application/octet-stream' })
      }
      // the flow step email passes `body` (P2-B fix: the action refused it as an unknown input): HTML when it has tags, else text
      const bodyIn = typeof inputs.body === 'string' && inputs.body && inputs.html === undefined && inputs.text === undefined ? inputs.body : ''
      const htmlIn = typeof inputs.html === 'string' ? inputs.html : /<[a-z][^>]*>/i.test(bodyIn) ? bodyIn : ''
      const html = htmlIn.trim() ? sanitizeRichText(htmlIn, 500_000) : undefined
      const text = typeof inputs.text === 'string' && inputs.text ? inputs.text : bodyIn && !html ? bodyIn : html ? richTextToPlain(html) : ''
      const replyTo = (inputs.replyTo as string | undefined) || connection.settings?.replyTo || undefined
      const base = {
        subject: String(inputs.subject), text, html: html ? emailShell(html) : undefined, replyTo,
        fromName: connection.settings?.fromName || undefined, attachments: files, template: 'action:send', userId: call.identity?.user.id ?? null,
      }
      const queue = async (m: { to: string[]; cc?: string[]; bcc?: string[] }) => mail.send({ ...base, ...m }).catch((e) => {
        throw new OutboundError('invalid_input', e instanceof Error ? e.message : 'The email could not be queued.')
      })
      let r: { id: string }
      if (t2.length || c2.length) r = await queue(t2.length ? { to: t2, cc: c2, bcc: b2 } : { to: c2, bcc: b2 })
      else {
        // only blind copies are left: one message each, so nobody sees the others' addresses
        const ids: string[] = []
        for (const a of b2) ids.push((await queue({ to: [a] })).id)
        r = { id: ids[0] }
      }
      return { mailId: r.id, recipients: count, suppressed: suppressed.size }
    },
  }
}

/** a minimal HTML document around a body fragment */
function emailShell(fragment: string): string {
  return `<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5">${fragment}</body></html>`
}

export type { ConnectionRecord }
