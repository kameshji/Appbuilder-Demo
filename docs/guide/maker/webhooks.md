# Webhooks: let other systems start a flow

A flow with the **webhook** trigger runs when another system calls its secret address, for example a payment provider
when a payment arrives, a form tool when someone submits a form, or a Tally add-on when a voucher is saved.

## Create the address

In the flow designer, click the trigger card ("When a web request arrives") and **Create the web address** (you need to be
able to change the flow). The panel shows the **address** (with its secret token) and the **signing secret** with copy
buttons. Copy both now: they are not shown again. Give them to the other system. The same panel lists the address (its
first characters only), its calls and refusals, and has **New address**, **New secret**, **Require signature** /
**Allow unsigned**, **Turn off** and **Revoke** ([flows](flows.md#the-trigger)).

The same through the API:

```
POST /api/v1/flows/<flow id>/webhooks      { "requireSignature": true }
```

Settings you can change (`PATCH /api/v1/webhooks/<id>`): `requireSignature` (default on), `toleranceSeconds` (5 minutes),
`maxBodyKB` (256, at most 1,024), `perMinute` (60), `enabled`, `name`.

- **Rotate** (`POST /api/v1/webhooks/<id>/rotate` with `{ "token": true }` and/or `{ "secret": true }`): the old address or
  secret stops working at once; the new one is shown once.
- **Revoke** (`DELETE /api/v1/webhooks/<id>`).
- List: `GET /api/v1/flows/<flow id>/webhooks` (never shows the token or secret, only its first characters).

## What the other system sends

```
POST <address>
Content-Type: application/json            (or form fields, or text)
X-Appbuilder-Signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>" in hex, with the signing secret>
X-Appbuilder-Delivery: <its own id, optional: the same id twice starts the flow once>
```

Appbuilder answers `202 Accepted` with `{ "accepted": true, "id": "<run id>" }` right away and runs the flow in the
background. Errors: `404` (wrong address), `401` (missing, wrong or too old signature), `409` (the same signed call again,
or the flow is off), `413` (body too large), `415` (unsupported content type), `429` (too many calls: retry after the
`Retry-After` seconds), `503` (busy: retry). A code example and the rules are in
[webhook security](../../admin/webhook-security.md).

Systems that cannot sign (some form tools) can use "token only" (`requireSignature: false`): then the address alone is the
secret; keep it like a password.

## In the flow

The trigger gives the flow the parsed **body** (JSON, or form fields by name), the **query** string, a safe subset of the
**headers** and the delivery id, for example `Trigger.Body.voucher`.
