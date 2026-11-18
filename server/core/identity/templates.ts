/**
 * System email templates: plain text plus a simple HTML version branded with the install name. Every value is escaped
 * in HTML; subjects never contain codes or links (the delivery log stores subjects).
 */
export type MailTemplate =
  | 'test' | 'password_reset' | 'invitation' | 'email_change' | 'email_changed' | 'signin_code' | 'new_device' | 'password_changed'

export interface Brand { installName: string }

export interface Rendered { subject: string; text: string; html: string }

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

interface Block { p?: string; code?: string; link?: { href: string; label: string }; small?: string }

function layout(brand: Brand, heading: string, blocks: Block[]): { text: string; html: string } {
  const text = [heading, '', ...blocks.flatMap((b) => {
    if (b.p) return [b.p, '']
    if (b.code) return [`    ${b.code}`, '']
    if (b.link) return [`${b.link.label}: ${b.link.href}`, '']
    if (b.small) return [b.small, '']
    return []
  }), '--', `${brand.installName} (sent automatically; replies may not be read)`].join('\n')
  const body = blocks.map((b) => {
    if (b.p) return `<p style="margin:0 0 14px;line-height:1.5">${esc(b.p)}</p>`
    if (b.code) return `<p style="margin:0 0 14px"><span style="display:inline-block;font:600 20px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:3px;padding:10px 14px;border-radius:8px;background:#f1f5f9;color:#0f172a">${esc(b.code)}</span></p>`
    if (b.link) return `<p style="margin:0 0 14px"><a href="${esc(b.link.href)}" style="display:inline-block;padding:9px 16px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600">${esc(b.link.label)}</a></p><p style="margin:0 0 14px;font-size:12px;color:#64748b;word-break:break-all">${esc(b.link.href)}</p>`
    if (b.small) return `<p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#64748b">${esc(b.small)}</p>`
    return ''
  }).join('\n')
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
<div style="font-weight:700;font-size:15px;margin-bottom:16px;color:#4f46e5">${esc(brand.installName)}</div>
<h1 style="font-size:18px;margin:0 0 14px">${esc(heading)}</h1>
${body}
</div>
<p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:14px">${esc(brand.installName)}: sent automatically; replies may not be read.</p>
</body></html>`
  return { text, html }
}

export interface TemplateVars {
  name?: string
  email?: string
  link?: string
  code?: string
  minutes?: number
  days?: number
  invitedBy?: string
  when?: string
  device?: string
  ip?: string
  newEmail?: string
}

export function renderTemplate(kind: MailTemplate, v: TemplateVars, brand: Brand): Rendered {
  const hi = v.name ? `Hello ${v.name},` : 'Hello,'
  const notYou = 'If this was not you, sign in, change your password and tell your administrator.'
  let subject: string
  let r: { text: string; html: string }
  switch (kind) {
    case 'test':
      subject = `${brand.installName}: test email`
      r = layout(brand, 'Email works', [{ p: 'This is a test message from the Admin console. Outgoing email (password resets, invitations, sign-in codes) is set up correctly.' }])
      break
    case 'password_reset':
      subject = `${brand.installName}: reset your password`
      r = layout(brand, 'Reset your password', [
        { p: hi },
        { p: `Someone asked to reset the password of your ${brand.installName} account (${v.email ?? ''}). The link works once, for ${v.minutes ?? 15} minutes.` },
        ...(v.link ? [{ link: { href: v.link, label: 'Choose a new password' } }] : []),
        { small: 'If you did not ask for this, ignore this email: your password stays the same.' },
      ])
      break
    case 'invitation':
      subject = `You are invited to ${brand.installName}`
      r = layout(brand, `Welcome to ${brand.installName}`, [
        { p: hi },
        { p: `${v.invitedBy ? `${v.invitedBy} created` : 'An administrator created'} an account for you (${v.email ?? ''}). Choose your password to start. The link works once and expires in ${v.days ?? 7} days.` },
        ...(v.link ? [{ link: { href: v.link, label: 'Set my password' } }] : []),
        { small: 'If you did not expect this, you can ignore this email.' },
      ])
      break
    case 'email_change':
      subject = `${brand.installName}: confirm your new email address`
      r = layout(brand, 'Confirm your new email address', [
        { p: hi },
        { p: `Confirm that ${v.newEmail ?? 'this address'} should become the sign-in address of your ${brand.installName} account. The link works once, for ${v.minutes ? `${v.minutes} minutes` : '24 hours'}.` },
        ...(v.link ? [{ link: { href: v.link, label: 'Confirm this address' } }] : []),
        { small: 'If you did not ask for this, ignore this email; nothing changes.' },
      ])
      break
    case 'email_changed':
      subject = `${brand.installName}: your sign-in email is changing`
      r = layout(brand, 'Your sign-in email is changing', [
        { p: hi },
        { p: `A change of your sign-in address to ${v.newEmail ?? ''} was requested${v.when ? ` on ${v.when}` : ''}. It takes effect when the new address is confirmed.` },
        { small: notYou },
      ])
      break
    case 'signin_code':
      subject = `${brand.installName}: your sign-in code`
      r = layout(brand, 'Your sign-in code', [
        { p: hi },
        { p: `Use this code to finish signing in. It works once, for ${v.minutes ?? 10} minutes.` },
        ...(v.code ? [{ code: v.code }] : []),
        { small: `Someone who knows your password is signing in. ${notYou}` },
      ])
      break
    case 'new_device':
      subject = `${brand.installName}: new sign-in to your account`
      r = layout(brand, 'New sign-in to your account', [
        { p: hi },
        { p: `Your account (${v.email ?? ''}) was signed in on a device it was not signed in on before${v.when ? `, on ${v.when}` : ''}.` },
        { p: `Device: ${v.device ?? 'unknown'}${v.ip ? `, address ${v.ip}` : ''}.` },
        { small: `${notYou} You can end sessions in Settings > Profile > Active sessions.` },
      ])
      break
    case 'password_changed':
      subject = `${brand.installName}: your password was changed`
      r = layout(brand, 'Your password was changed', [
        { p: hi },
        { p: `The password of your account (${v.email ?? ''}) was changed${v.when ? ` on ${v.when}` : ''}. Every session was signed out.` },
        { small: 'If this was not you, tell your administrator now.' },
      ])
      break
  }
  return { subject, ...r }
}
