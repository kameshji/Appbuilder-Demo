# WhatsApp

Appbuilder sends WhatsApp messages through **Meta's WhatsApp Business Cloud API** (no unofficial services): template
messages from flows and table events, short replies inside the 24-hour customer service window, and notifications to
people who choose WhatsApp. It sends **only to numbers that have a current opt-in** recorded in this environment.

What the software does: it records who opted in or out, when, how and with what evidence, keeps the full history, and
refuses to send without a current opt-in. What it does not do: decide whether a consent is valid, or approve templates.
Your business is responsible for real consent and for getting its templates approved by Meta in WhatsApp Manager.
Questions about WhatsApp's policies or data protection law are for a lawyer.

## Before you start (in Meta's tools)

1. A Meta business account with a **WhatsApp Business account** and a phone number added to it (WhatsApp Manager).
2. A **system user access token** with the permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
3. The **app secret** of the Meta app (App settings > Basic): Appbuilder uses it to check that webhook calls come from Meta.
4. At least one **approved message template** (for example an order update with values `{{1}}`, `{{2}}`, ...).

## Create the connection

Connections > New connection > **WhatsApp** (administrators only):

| Field | What |
| --- | --- |
| Phone number id, WhatsApp Business account id | From WhatsApp Manager > API setup (digits) |
| Default country code | Used for numbers written without `+` and a country code. Suggested `91` (India); change it for other countries |
| API version | Default `v21.0` |
| Access token, app secret, webhook verify token | Write-only, sealed on the server, never shown, logged or put in messages. Replacing one replaces all three: enter all of them |
| Inbound flow (optional) | The id of a flow with a webhook trigger, started for each message a person sends |
| Sending enabled | Off stops every message of this connection at once (a kill switch) |

There is **no address field**: Appbuilder always calls `https://graph.facebook.com`, so a connection cannot be pointed at
another server. HTTP connections cannot call `graph.facebook.com` either (they would skip the opt-in check).

The **Test** button reads the phone number from Meta and says what is still missing. Give makers **use** access on the
connection's Access tab so they can attach it to flows ([connections](connections.md)).

## Webhook

Admin console > **WhatsApp** shows the webhook address of each WhatsApp connection:
`https://<public address>/api/v1/whatsapp/webhook/<environment>/<connection id>`. In the Meta app's WhatsApp
configuration, enter that address and the same verify token, then subscribe to the **messages** field. The public address
is set in Admin console > Email; the host must be one of the server's allowed host names.

Every call is checked: the environment and connection must exist; at most 600 calls a minute (429); the body at most
512 KB (413); the `X-Hub-Signature-256` signature with the app secret is required (401 without it, or when the connection
has no app secret); each signature is accepted once (a repeat is acknowledged and ignored); JSON only (415); events older
than 7 days and events of another phone number are ignored. See also [webhook security](webhook-security.md) for the
general rules.

What the webhook does: status updates (sent, delivered, read, failed) go to the message log; messages people send are
logged (without their text), open the 24-hour window for replies, and **STOP-style words opt the number out at once**.

## Opt-ins

Admin console > **WhatsApp** > Opt-ins: record an opt-in or opt-out (number, status, source, evidence), search, and open
the full history of a number. Sources: **administrator** (you), **form** (a form or the person themself in Settings),
**import** (a bulk list; `POST /api/v1/whatsapp/optins/import` with a description of where the consents come from) and
**inbound keyword**. The evidence says what the person agreed to, where and when, for example "Ticked 'Send me order
updates on WhatsApp' on order form SO-1001". Who recorded it and when are stored automatically. Flows can record opt-ins
with the action "Record an opt-in or opt-out" (never with the source administrator); those entries name the flow's run-as
identity.

**Keywords** (Admin console > WhatsApp > Keywords): a message that is exactly one of these words (any case, punctuation
ignored) opts out or opts in again. Defaults: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, OPTOUT, BAND,
BAND KARO, बंद, बंद करो, बंद करें, रोकें, रोको; opt in again: START, UNSTOP, SUBSCRIBE, शुरू, चालू. At least one stop
word must stay.

## Message log

Admin console > WhatsApp > Message log: every message sent, refused or received, with its status history, Meta's message
id, the flow or notification it came from and any error. Full numbers are shown to environment administrators only;
everywhere else (flow run history, connection activity, notifications settings) numbers are masked like `+91 •••••••001`.
Message text is not stored. Entries are deleted after 90 days by the schedule "WhatsApp message log retention" (Admin
console > Jobs; change `days` there). Opt-ins and their history are never deleted by it.

## Notifications on WhatsApp

Admin console > WhatsApp > Notifications on WhatsApp: choose the connection, an **approved** template, its language and
what fills its body values (title, body, link, in order). Appbuilder checks the template with Meta when you save. People
then see a WhatsApp switch per kind in Settings > Notifications once their own number (the phone on their user record) is
opted in; they can opt in and out there themselves. Messages are sent right away (no digest) and wait for the end of the
person's do-not-disturb hours. If anything is missing (no mapping, no number, no opt-in, no token) the channel is not
offered and the delivery log says why.

## Copied environments

A copy of an environment gets **no** opt-ins, message log, keywords, notification mapping or people's WhatsApp choices,
its WhatsApp connections lose their secrets, and its flows arrive turned off. A test copy cannot message your customers
until someone enters a token and records opt-ins in it on purpose.

## Error messages you may see

| Message (short) | What to do |
| --- | --- |
| has no current WhatsApp opt-in | Record the opt-in (with evidence) first |
| more than 24 hours ago / has not written | Send a template message instead of a text reply |
| template does not exist in this language or is not approved | Check the name and language in WhatsApp Manager |
| number of values does not match | The flow passes a different number of values than the template has |
| Meta refused the access token | Enter a new token on the connection |
| rate limit ... Try again in N s | Flows retry by themselves; lower the volume if it repeats |
| stopped receiving marketing messages | The person blocked marketing in WhatsApp; respect it |

Developer details: [WhatsApp connector](../dev/whatsapp.md).
