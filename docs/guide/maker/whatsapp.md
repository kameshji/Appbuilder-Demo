# WhatsApp in flows

With a **WhatsApp connection** (an administrator creates it and gives you **use** access) a flow can send WhatsApp
messages to customers and staff who opted in. Attach the connection to the flow (Connections), then add an **action**
step with one of its actions. The list of actions and their inputs: [connector actions](../../reference/connector-actions.md).

## Send a template message

Most messages are **template messages**: text that Meta approved in advance, with placeholders `{{1}}`, `{{2}}` ...
Business-initiated messages (an order update, a reminder) must be templates.

| Input | Example |
| --- | --- |
| To | `ThisRecord.Phone` or `"+91 00000 00001"`. Without a country code, the connection's default (for example 91) is used |
| Template | `"order_update"` (the name in WhatsApp Manager) |
| Language | `"en"` or `"hi"` (the template's language) |
| Body values | `[Trigger.Record.CustomerName, Trigger.Record.Number, "shipped"]` in the order of `{{1}}`, `{{2}}`, `{{3}}` |

The step's output has `messageId` (the message log entry), `providerMessageId` (Meta's id), the masked number and the
status `accepted`. Delivery and reading arrive later in the message log; they do not hold the flow up.

## Opt-in first

**Nothing is sent to a number without a current opt-in.** The step fails with "has no current WhatsApp opt-in" and
nothing is sent. Opt-ins are recorded by administrators (Admin console > WhatsApp), by people themselves in Settings, by
STOP / START messages people send, or by your flow with the action **Record an opt-in or opt-out**: give the number, the
status, the source (`form` or `import`; "inbound keyword" is recorded only when the person writes START or STOP) and evidence, for example
`"Ticked 'Send me order updates on WhatsApp' on order " & Trigger.Record.Number`. Record only consent the person really
gave: your business is responsible for it. **Check a number's opt-in** tells you whether a number may be messaged, so a
flow can choose email instead.

## Replies (24-hour window)

**Reply with a text message** sends free text, but only within 24 hours of the person's last message to your WhatsApp
number (as received by Appbuilder). Outside that window the step fails with the reason; send a template instead.

To react to messages people send, an administrator can name a flow with a **webhook trigger** as the connection's inbound
flow: it runs once per message with `Trigger.Body.From` (the number), `Trigger.Body.Text`, `Trigger.Body.Name`,
`Trigger.Body.MessageId` and `Trigger.Body.Keyword` (`stop` or `start` when the message was a keyword, already applied).

## Retries never send twice

Each step has its own idempotency key: when the flow retries a step after a network error, the message that Meta
already accepted is not sent again. When Meta answers "rate limit", the step is retried later by itself. Other errors
(template not approved, wrong number of values, no opt-in) fail the step at once with a plain message.

## What you can see

Numbers are masked in flow run history (`+91 •••••••001`). The full message log is for administrators. Message text is
not stored by Appbuilder.
