# Go-to-market brief (shared context for launch workstreams)

Status: working draft, 19 Nov 2026. Product facts here are the source of truth for marketing, sales, support
and website work. Do not claim anything that is not in this file or in the product docs.

## Product (working name "Appbuilder" — a real name is still to be chosen)
A self-hosted business app platform for organisations of roughly 20-50 people (up to a few hundred):
one install on the customer's own PC/server or a small VPS. Makers build apps by drag and drop with an
Excel-like formula language. Built-in: database with role-based, row-level and column-level security;
environments (dev/test/production) with deploy between them (connection and people mapping on the plan
screen); validation rules, formula columns, rollups; visual data model designer; live updates; tasks,
comments, mentions, record timelines; notifications in the app and by email (per-person choices, digests);
scheduled reports by email; backup and restore; two-step verification; installers for Windows and Linux.
Workflow automation (version 0.6.0): flows built on a visual designer by clicking (triggers on data changes,
schedules, buttons in apps, web requests, decided approvals; conditions, loops, data steps, delays,
approvals, email, notifications, HTTP calls, connector actions, child flows; templates, drafts, versions,
test runs shown on the canvas, a kill switch), approvals (single, any, all, quorum, sequential stages and
amount thresholds edited visually; delegation, reminders, escalation; answers from an inbox, the bell or an
email link), connector actions (HTTP with OpenAPI import, Email, incoming signed webhooks), health alerts by
email and a heartbeat for an uptime monitor, admin recovery commands on the server for a locked-out
administrator. Apps can be designed at phone and tablet sizes. Planned, NOT built: a phone-optimised
experience for operators (offline, camera, barcode), PDF output, dashboards, WhatsApp, templates
marketplace with CRM / ERP / manufacturing pack, team chat, document / sheet / slide editors, mail client,
AI agents, external portal sites, single sign-on.

## Honest status
Version 0.6.0 (Phase 1 "Automation" closed 19 Nov 2026). No customer yet. No pilot yet. No outside security
review yet (two internal reviews, Phase 0 and Phase 1). The Windows installer was run once on one Windows 11
PC (not yet on a customer machine; HTTPS options, updater, uninstall and the offline bundle not yet exercised on
Windows). Flows and approvals have been tested in simulation (a week of approvals with server restarts) and
headless browsers, not yet by real users. One founder building with AI agents. First pilot target: a small
Indian manufacturer. Pricing not decided (idea: one licence per install by seat band 25/50/100 with user
passes: Full user, Operator, External).

## Positioning hypotheses (to be tested, not facts)
- "Your own Power Platform on your own server, at a flat price": no per-connector fees, no per-flow
  metering, data stays on premises.
- Wedge: shop-floor and approval apps around Tally/Excel for small manufacturers in India; then other
  small organisations that outgrew Excel and WhatsApp but find ERPs rigid and Microsoft licensing confusing.
- Differentiators: Excel-formula maker experience; one-click on-prem install; one security model inherited
  by apps, flows, search and (later) AI.

## Known competitors (see docs/research/)
Microsoft Power Platform, Zoho Creator, ERPNext/Frappe, Odoo, Budibase, NocoBase, Appsmith, ToolJet, Tally.

## Constraints
- India-first, global later. Founder based in Bhopal, India.
- The founder is an employee serving notice at an Indian IT services company with a no-moonlighting policy
  until about end of January 2027; entity and timing questions must account for this.
- No fabricated testimonials, customer logos, case studies, user counts, awards or certifications.
  Mock-ups must be labelled as examples. Comparisons must be factual and sourced.
- Legal content is research for a lawyer/CA to review, not legal advice.
