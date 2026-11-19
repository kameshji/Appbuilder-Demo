# Notification delivery (channels, email, digests)

P1 package D, decision D26. `services.notifications.notify(target, input)` (package H, [live.md](live.md)) stays the single
entry point: flows, table events (`NotifyUser`), approvals, mentions and comments, tasks and backups all call it. Since P1
a **delivery module** decides, per recipient and kind, which channels get the notification, sends email through the mail
service, and records why. Maker and user view: [notifications](../guide/maker/notifications.md); administrators:
[connections and email](../admin/connections.md#email-limits-and-the-suppression-list).

| File | What |
| --- | --- |
| `server/core/notifications.ts` | `notify()`: asks the delivery module for a plan, stores the in-app row only when the plan says so, hands the item to `deliver()` |
| `server/core/notifications-delivery.ts` | Policy, effective channels, quiet hours and digest slots (`digestDue`, `latestDigestSlot`, `quietEnd`), email rendering, signed unsubscribe tokens, the digest and retention jobs, routes |
| `src/platform/live-protocol.ts` | `NotificationSettings` gained `email`, `digest`, `timeZone`, `quietEmail` (parsed by `parseNotificationSettings`); kinds `mention` and `task` listed |
| `src/portal/NotificationChannels.tsx`, `AdminNotifications.tsx` | Settings > Notifications (server mode) and Admin console > Email (defaults, locks, suppression list, delivery log) |

## Channels and rules

| Channel | When |
| --- | --- |
| In the app | Stored and pushed unless switched off for the kind (user, or a locked administrator default) |
| Email | `off`, `immediate` or `digest` per kind |
| WhatsApp | Placeholder: listed as P2, never delivered |

Effective choice per kind (`effectiveChannels`): an administrator's **locked** default wins (users cannot change it, and
the unsubscribe link answers "required"); otherwise the user's choice; otherwise the administrator's default; otherwise
in-app on and email off. Out of the box approvals are emailed right away (not locked). Administrator policy lives in
`ab.settings` key `notifications.policy`: `{ kinds: { <kind>: { inApp?, email?, lock? } }, logoUrl (https only),
perRecipientPerHour (default 20) }`.

Before email: the relay must be set up (otherwise the log says so) and the address must not be on the suppression list.

**Immediate**: inside the user's do-not-disturb hours (in their `timeZone`, default UTC; unless `quietEmail: false`) the
email is queued in `ab.notification_digest` with `hold_until` = the end of the quiet hours. More than
`perRecipientPerHour` immediate emails in the last hour: queued with `hold_until` = the next full hour. Otherwise one email
now (`mail.send`, template `notification`).

**Digest**: queued in `ab.notification_digest` without `hold_until`. The built-in install schedule
`notifications.digest` (every 5 minutes, Default environment) sends per user:

- everything waiting, when a digest slot is due: `digestDue(prefs, lastSent, oldestItem, now)` is true when the latest slot
  (hourly at :00, or daily at the user's time, in their time zone; `latestDigestSlot`) is after the last digest sent and
  at least one waiting item is older than that slot, and the user is not in quiet hours;
- otherwise only held items whose `hold_until` passed (not in quiet hours).

One email lists every item; the delivery rows of the items become `sent` with the email's id; `lastSent` is kept in
`ab.user_settings` key `notifications.digest_state`. Unit tests: `actions.test.ts` "notification delivery rules"; end to
end: `actions.integration.test.ts` "quiet hours hold emails; digests collect them".

## The email

Branded with the install name (Admin console > Email) and the optional logo; each item has its title, body, sender and an
**Open in <install>** button to `<public URL>/<#link>` (the public URL is the relay setting "public address"; without it
there is no button and no unsubscribe link). The footer says why the email came (the delivery reason) and links to the
unsubscribe page. Headers `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).

## Unsubscribe without signing in

Token: `base64url(JSON {u, k})` + `.` + HMAC-SHA256 with a key derived from the install's secret key
(`HMAC(secretKey, "appbuilder.unsubscribe.v1")`); `k: '*'` for a digest of several kinds; reports use `{u, r, e}`.
`GET /api/v1/notifications/unsubscribe?t=` shows a small page (CSP `default-src 'none'`) with a button;
`POST` (the form, or a mail client's one-click POST) sets email to `off` for the kind (locked kinds excepted), or adds the
user to a report's `optOut`. Both are `auth: 'none'`; the POST is `csrfExempt` (the token is the proof). Audited in the
install audit (`notifications.unsubscribe`, `report.unsubscribe`).

## Delivery log

`ab.notification_deliveries`: one row per notification, recipient and channel with `status` (`delivered`, `skipped`,
`queued`, `digest`, `sent`, `failed`) and a reason in plain words. Users read their own (`GET /notifications/deliveries`,
Settings > Notifications > "Why did I get this?"); install administrators anyone's (`GET /admin/notifications/deliveries`).
Retention 90 days (`notifications.delivery-retention`).

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /notifications/channels` | user | Effective channels per kind with locks and reasons, digest, time zone, quiet-hours flag, whether email works |
| `PUT /notifications/settings` | user | As before; accepts `email`, `digest`, `timeZone`, `quietEmail` |
| `GET /notifications/deliveries` | user | Own delivery log |
| `GET/PUT /admin/notifications/policy` | install administrator | Defaults, locks, logo, per-recipient limit (audited) |
| `GET /admin/notifications/deliveries?userId` | install administrator | Anyone's delivery log |
| `GET/POST /admin/mail-suppressions`, `DELETE /admin/mail-suppressions/:address` | install administrator | Suppression list |
| `GET/POST /notifications/unsubscribe?t=` | anyone with the link | Mute email of a kind or a report |

## Limits and what is not done

- Bounces are not detected (Appbuilder receives no mail); the suppression list is manual.
- WhatsApp delivery is Phase 2.
- The digest job runs every 5 minutes, so a daily digest at 08:00 leaves between 08:00 and 08:05.
- Rate limits and breaker state of connector actions are per process (D19); the delivery limits are counted in the
  database and survive restarts.
