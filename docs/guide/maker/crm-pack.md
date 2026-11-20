# The CRM pack

A ready-made solution for a small sales team (3 to 15 people): leads, the deals they turn into, quotes with a printable
quotation, the calls, meetings and messages around a deal, and a pipeline dashboard. It installs from **Templates >
Solutions > CRM** like any solution template ([Templates](templates.md)): Linked (upgradable) by default, through the
binding step and the plan screen, in one step that either completes or changes nothing.

It reuses the common business model: **Accounts, Contacts, Products, Price lists and Price list items** are shared with
it (it is installed first when you do not have it), so a customer you add here is the customer the ERP-lite and other
packs see.

## No tax is computed

**Quotes and quote lines have no tax column and no tax calculation.** A quote's total is the lines' total less the
discount, nothing more, and the printed quotation says so ("No tax has been computed on this quotation"). Tax rules
depend on what is sold, to whom and where; get them set up with your accountant before you put a tax line on a quote.
(The business model has a Tax codes table you can use when you do.)

## What it contains

| Part | What |
| --- | --- |
| Tables (8 + 5 shared) | **Leads**, **Opportunities**, **Quotes**, **Quote lines**, **Touchpoints** (an email or WhatsApp message sent from a deal), and the lists **Lead sources**, **Loss reasons**, **Sales stages**. Shared with the business model: Accounts, Contacts, Products, Price lists, Price list items. |
| Apps (2) | **Sales** (desktop: deals, leads, quotes with lines, accounts, contacts, touchpoints) and **Sales on the go** (phone: my deals, a deal with its stage and timeline, **Log a call** / **Log a meeting**, accounts). |
| Flows (7, arrive off) | New lead (tell its owner and the managers); Convert a lead; Stale opportunity reminder (a follow-up task, 09:00 India time, Monday to Saturday); Quote discount approval; Keep the quote subtotal; Won or lost (tell the owner and the managers); Send and log a touchpoint. |
| Approval policy (1) | **Quote discount**: a sales manager approves a discount above 10%; the rep who made the quote is never asked; a reminder after 8 hours, due in 2 days. |
| Dashboard (1) | **Sales pipeline**: open pipeline, weighted forecast, won value, win rate, pipeline by stage, open pipeline by owner, won and lost, forecast by month. Each viewer sees only the rows they may read. |
| Print template (1) | **Quote**: your quotation with its lines, the discount and the total. |
| Roles (3) | Sales rep, Sales manager, Sales viewer (below). |
| Number sequence (1) | Quotes: `QT/2026-27/0001`, restarting every financial year (April to March). |
| Reference rows | 6 sales stages with their win chance (Prospect 10, Qualified 25, Proposal 50, Negotiation 75, Won 100, Lost 0), 8 lead sources, 7 loss reasons. They are data: change them to your wording. |
| SAMPLE rows (optional) | A fictional pipeline: 10 opportunities across every stage, 6 leads, 3 quotes with 5 lines. Names start with `SAMPLE`. **Remove sample data** (Templates) removes exactly these and nothing you added. |

## Who sees what

| Role | Leads, accounts, contacts, opportunities, quotes, touchpoints | Reference lists, products, price lists | Quote approval columns |
| --- | --- | --- | --- |
| Sales rep | **Own rows only**: they create, read and change what they made; no delete. | Read | Read only (they cannot approve their own discount) |
| Sales manager | **The team's rows** (people in the same teams as the manager) | Read; keeps lead sources, loss reasons and stages | Reads; answers the approval |
| Sales viewer | **All rows**, read only | Read | Read |

Accounts, contacts and opportunities made by a flow (a converted lead) belong to the **rep who owned the lead**, not to
the administrator the flows run as. Activities (calls, meetings, emails) are visible to whoever can read the deal they
are about.

Roles are assigned and **teams are made by you** after the install (Admin console > Users and Teams): put the manager
and the reps they manage in one team. Without a team, a manager sees only their own rows.

## The first day

1. **Install** (an administrator, best in a sandbox environment first): Templates > Solutions > CRM > Use. If you have a
   table called `Leads` (or another name the pack uses), choose the pack's prefixed name (`CrmLeads`) or map it. A role
   with the same name as the pack's gets `(2)`. Tick **Add the SAMPLE rows** to try it out. Review the plan, **Install**.
2. **Switch on the flows** you want (the last step of the install, or Flows later). They run as the administrator who
   installed the pack, but what they create belongs to the person who caused it.
3. **Give people roles** and make the team.
4. **Email**: an administrator creates the environment's **Email connection** (Admin console > Connections) if people
   will send email from a deal. Without it nothing fails: the touchpoint is marked **Not sent** and is still logged on
   the deal.
5. Set your own default **price list** (mark one as the default: a quote picks it up) and, in Products, your prices.
6. Change the stage names, lead sources and loss reasons into your words (they are plain tables).

## How it works

- **Leads** are captured by anyone with the rep role. Set the lead's status to **Converted** and a flow makes an account
  (an existing one with the same name is reused), a contact and an opportunity, once, and links them back on the lead.
- **Opportunities** take their win chance from the stage and set the closing date when they become Won or Lost. A lost
  deal needs a loss reason. The **weighted forecast** is the amount times the chance.
- **Quotes** are numbered from the sequence, take the opportunity's account and the default price list, and fill each
  line's price from the product. The subtotal is kept by the "Keep the quote subtotal" flow (switch it on); the printed
  quotation always sums the lines itself.
- **Discount approval**: above **10%** the quote is marked Pending and asked of the sales managers; it cannot be sent
  (or accepted) until the discount is approved, and the rep is told the answer. The limit is in the table rule and the
  flow (`> 10`); change both together.
- **Touchpoints**: from a deal, write an email or a WhatsApp message to its contact. Every touchpoint is logged as an
  activity on the deal's timeline. See the next section for WhatsApp.

## WhatsApp: add the connection step yourself

The pack **does not send WhatsApp messages**. A WhatsApp touchpoint is logged on the timeline as "Logged only", and the
flow says so. To really send, an administrator creates a WhatsApp connection and opt-ins ([WhatsApp in flows](whatsapp.md)),
then you open the flow **Send and log a touchpoint**, and in the branch for WhatsApp add an **action** step with the
connection's *send template message* action before the "Logged" update (To: the contact's mobile number, Template: the
name Meta approved). Pack upgrades keep a flow you changed, and tell you when both sides changed it.

## Upgrades

The pack is Linked: a newer version of it shows an **Upgrade** button. The screen lists what you changed here (an app, a
dashboard, a reference row such as a renamed lead source) and keeps it unless you choose to replace it.

## Limits

No tax, no price-list rules beyond the default list, no territory or round-robin assignment, no email inbox sync, no sending
of WhatsApp without the step above. The phone app needs a connection to save a call log (it does not queue it offline).
