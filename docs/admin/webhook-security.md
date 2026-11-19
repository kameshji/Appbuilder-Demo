# Webhook security

A **webhook** lets another system start a flow by calling Appbuilder over HTTPS: a payment provider when a payment
arrives, a form tool when a form is filled in, a Tally add-on when a voucher is saved. Makers create the address on the
flow (see [webhooks for makers](../guide/maker/webhooks.md)); this page is what an administrator should know.

## How a call is checked

`POST https://<public address>/api/v1/hooks/<environment>/<flow id>/<token>` needs no sign-in. Appbuilder checks, in order:

1. **The token in the address**: 32 random bytes. Only its SHA-256 is stored, so nobody (administrators included) can read
   it later. A wrong environment, flow or token answers the same `404 Not found`.
2. **The rate limit of the webhook** (default 60 calls a minute): above it `429` with `Retry-After`.
3. **The body size** (default 256 KB, at most 1 MB): the body is read only after steps 1 and 2; above the limit `413` and
   the connection is closed.
4. **The signature** (required by default): header `X-Appbuilder-Signature: t=<unix seconds>,v1=<hex>` where `v1` is the
   HMAC-SHA256 of `<t>.<raw body>` with the webhook's signing secret. The time must be within the tolerance (default 5
   minutes) of the server's clock, and each signature is accepted once (a replayed call answers `409`). A webhook may be
   switched to "token only" for systems that cannot sign; the address then is the only secret, like a password in a URL.
5. **The content type**: JSON, form fields (`application/x-www-form-urlencoded`) or text. Others answer `415`.
6. The verified call is handed to the flow, which answers `202 Accepted` with the run id at once; the flow runs in the
   background. If the flow cannot take it (switched off), `409`; if the server is busy, `503` (the sender should retry).

The flow sees the parsed body, the query string and a safe subset of headers (content type, user agent and `X-` headers,
never signature, token, key, auth or cookie headers).

## Secrets: shown once, rotated, revoked

The address with its token and the signing secret are shown **once**, when the webhook is created, and again only when
they are rotated. **Rotate** the token (the old address stops at once) or the secret (old signatures stop at once);
**revoke** deletes the webhook. In this version these are API calls ([maker guide](../guide/maker/webhooks.md)); the
flow designer shows them when it arrives. Creating, changing, rotating and revoking are audited
(`webhook.create`, `webhook.update`, `webhook.rotate`, `webhook.revoke`); the audit never contains the token or secret.
Calls and rejected calls are counted per webhook.

## Network

- The sender must reach the server's **public address** (Admin console > Email > public address; it is also used to show
  the address to makers). Put Appbuilder behind HTTPS (Caddy, see [installation](installation.md)) before exposing it.
- The host name the sender uses must be one of the server's allowed host names (`APPBUILDER_ALLOWED_HOSTS`).
- Only the `/api/v1/hooks/...` path needs to be reachable from outside if you publish Appbuilder through a reverse proxy
  that filters paths.

## For the sending system (example)

```js
const body = JSON.stringify({ voucher: 'SV-1001', amount: 12500 })
const t = Math.floor(Date.now() / 1000)
const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')
await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Appbuilder-Signature': `t=${t},v1=${v1}`, 'X-Appbuilder-Delivery': 'SV-1001' }, body })
```

`X-Appbuilder-Delivery` (or `Idempotency-Key`) is optional: the same value twice starts the flow once.

## What is not done

- No IP allow-list per webhook (use the reverse proxy).
- No signing schemes of other vendors (Stripe, GitHub): those senders need a small relay or "token only".
