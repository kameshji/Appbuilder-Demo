# Competitive battlecards

Status: working draft, 19 Nov 2026. Prices and features were checked on **19 Nov 2026** on the linked pages unless
marked otherwise. **Unverified** = could not be confirmed on an official page in this session. Third-party sources are
labelled. Re-check every number before putting it in front of a customer, and always say the date you checked.

Our side of every card uses only what [BRIEF.md](../BRIEF.md) lists as built. Planned items are labelled planned.

**Universal "where we win" (today):** Excel-style formula canvas maker; install on the customer's own PC/server with
PostgreSQL; server-enforced role, row and column security with "Test as user"; validation rules, formula columns,
rollups; environments with deploy; scheduled email reports; backups with restore; flat price per install by seat band
(planned model). **Universal "where we lose" (today):** no phone layouts in the field, no approvals/flows released, no
WhatsApp, no PDF, no dashboards, no Tally connector, no outside security review, no customers, one person.

---

## Microsoft Power Platform (Power Apps, Power Automate)

| | |
|---|---|
| **What it is** | Microsoft's low-code platform; canvas and model-driven apps, Dataverse, Power Automate flows, Teams integration |
| **Pricing notes (verified)** | Power Apps Premium **$20/user/month** paid yearly; **$22 from 1 Jan 2027** for new purchases and renewals with terms starting then; $12 → $14 for the 2,000-seat minimum plan ([Microsoft licensing news, 9 Sep 2026](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update); [pricing page](https://www.microsoft.com/en-us/power-platform/products/power-apps/pricing), which says prices are "for marketing purposes only"). Dataverse database capacity add-on $40/GB/month (same page). Premium capabilities (premium connectors, Dataverse, on-premises data gateway, custom APIs) need premium entitlements; from **February 2027** users without an appropriate licence cannot open such apps ([Microsoft Learn licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/powerapps-licensing-faq)). Per-app plan: third-party report says no longer available to new non-CSP buyers, still in CSP; pay-as-you-go cited at $10/active user/app/month ([SAMexpert](https://samexpert.com/power-apps-per-app-plan-retired/), third-party, **verify with a Microsoft partner**). INR prices: **Unverified**. |
| **Where they win** | Customer already on Microsoft 365 and app fits SharePoint + standard connectors; mobile apps today; Teams and Outlook integration; approvals and flows mature; certifications and audits; huge partner ecosystem; "nobody gets fired for buying Microsoft" |
| **Where we win** | Premium-licence cost for many users (shop floor); data must stay on-premise without a gateway; flat price per install; no per-connector or per-flow metering; maker experience familiar to Power Apps users (the founder's own background) |
| **Landmines to set** | "Which data sources: SharePoint only, or SQL Server/Dataverse?" "How many users need premium, at $22 from January?" "Have you read Microsoft's note that unlicensed users can't open premium apps from February 2027?" "Who manages your Dataverse capacity?" |
| **Landmines they will set** | "Is he certified/audited?" (no). "What if he disappears?" "Does it work in Teams/mobile?" (no/not yet). "Microsoft has approvals built in" (ours are in progress). |
| **Questions to ask** | List of apps with users and data sources; M365 plan; existing Power Apps Premium seats; who builds today; on-prem SQL? |
| **Walk away when** | The app fits M365 standard connectors and SharePoint, or they need mobile + approvals now, or IT policy mandates certified vendors. Recommend Power Apps; it earns trust. |

---

## Zoho Creator

| | |
|---|---|
| **What it is** | Zoho's cloud low-code platform; apps run on web and native iOS/Android; part of Zoho's suite |
| **Pricing notes** | Official page (annual billing, per user per month): Standard **US$8** (1 app), Professional **US$20** (unlimited apps), Enterprise **US$25**; 15-day trial; INR shown to Indian visitors, local taxes extra ([Zoho Creator pricing](https://www.zoho.com/creator/pricing.html), checked 19 Nov 2026; INR amounts not captured). A Zoho partner lists about ₹480 / ₹1,200 / ₹1,500 per user per month ([Codroid, Sept 2026](https://codroiditlabs.com/zoho-creator-pricing-india/), partner page, **Unverified** on Zoho). On-premise deployment: not mentioned on the pricing page (**Unverified**). |
| **Where they win** | Native mobile apps today ("every app ... runs natively on the web, and on both iOS and Android", pricing page); workflows mature; Zoho brand and Indian presence; partner network; integrates with Zoho Books/CRM; cloud means no PC to maintain |
| **Where we win** | Data on the customer's own PC/LAN (no internet dependency); per-install price vs per-user for shop-floor headcount; Excel-formula canvas; PostgreSQL export of everything; row/column security with "Test as user" |
| **Landmines to set** | "What does it cost at your user count over three years?" "Where is the data stored and what happens when your internet is down?" "Can a supervisor be restricted to his line's rows and blocked from rate columns? Show me." |
| **Landmines they will set** | "Zoho has a mobile app, he doesn't." (true) "Zoho is a big Indian company; he's one person." (true) |
| **Questions to ask** | Users who need mobile now? Internet reliability? Already on Zoho Books/CRM? |
| **Walk away when** | They are already a Zoho suite customer, need mobile now, and are happy with cloud. |

---

## ERPNext / Frappe

| | |
|---|---|
| **What it is** | Open-source ERP by Frappe (India) on the Frappe Framework (itself a metadata-driven low-code platform); manufacturing (BOM, work orders, job cards), stock, buying, selling, accounts, quality; workflows, print formats, portal ([manufacturing research](../../research/manufacturing.md#7-market-reality-check); [building-blocks](../../research/building-blocks.md#c-direct-competitors)) |
| **Pricing notes** | Software free and open source (GPL-3.0 per [building-blocks](../../research/building-blocks.md#c-direct-competitors)). Frappe Cloud: "Sites" from **₹410/mo ($5/mo)** onwards, "Servers" from **₹3,600/mo ($40/mo)** onwards; compute-based, no per-user rates listed ([Frappe Cloud pricing](https://frappe.io/cloud/pricing), checked 19 Nov 2026). Implementation partner fees: **Unverified**, vary widely. |
| **Where they win** | Free licence; full ERP scope including accounts and GST (India compliance via an app, detail **Unverified**); Indian community and partners; manufacturing module already there; a no-code DocType builder |
| **Where we win** | When they do **not** want to replace Tally or run an ERP project; one app from their own sheet in days; Excel-style formulas for in-house changes; Windows install on an office PC (ERPNext self-hosting is Linux-oriented, **Inference**) |
| **Landmines to set** | "Are you planning to move accounts out of Tally?" "Who will implement and maintain it, and at what day rate?" "How long until the first app is live?" |
| **Landmines they will set** | "ERPNext is free and does everything." "Open source, so no vendor risk." (largely true) |
| **Questions to ask** | ERP appetite; in-house tech person; past ERP attempt? |
| **Walk away when** | They want a full ERP and have (or will pay) an implementer. Say so. |

---

## Odoo

| | |
|---|---|
| **What it is** | Modular ERP (MRP, inventory, accounting, CRM, website); Studio low-code customisation |
| **Pricing notes** | Official [odoo.com/pricing](https://www.odoo.com/pricing) could not be fetched in this session (**Unverified**). Third-party tracker for India: Standard ₹580/user/month (yearly, promotional; ₹725 list; ₹760 monthly), Custom ₹1,080 (yearly, promotional; ₹1,350 list and monthly); Studio only in Custom ("Verified September 24, 2026" per [oec.sh](https://oec.sh/odoo-pricing/india), third-party). |
| **Where they win** | Polished UI, broad modules, website and e-commerce, large partner network, mobile-friendly web client |
| **Where we win** | Studio requires the higher plan per user; one shop-floor app beside Tally without ERP adoption; on-prem PC install with flat price; Excel-formula maker |
| **Landmines to set** | "Is Studio in the plan you were quoted?" "What does it cost per user for all shop-floor users?" "What does the partner charge for customisation?" |
| **Landmines they will set** | "Odoo does everything including accounting and mobile." |
| **Questions to ask** | Who quoted, which plan, which modules, implementation estimate |
| **Walk away when** | They want an integrated ERP with e-commerce/website, or have already signed with an Odoo partner. |

---

## Tally (incumbent, mostly a complement)

| | |
|---|---|
| **What it is** | TallyPrime: accounting, GST, inventory; the default ledger of Indian SMEs; acts as a server for third-party apps over XML/HTTP when running ([Tally help](https://help.tallysolutions.com/tallyprime-as-server/)) |
| **Pricing notes (verified)** | Silver ₹22,500 and Gold ₹67,500 one-time + 18% GST, each with 1 year TSS; rental Silver ₹750/month, Gold ₹2,250/month; TSS renewal ₹4,500 (Silver) / ₹13,500 (Gold) a year + GST ([Tally, 13 Jul 2026](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/)) |
| **Where they win** | Books, GST, statutory reports, stock valuation, CA familiarity: always. Do not compete. |
| **Where we win** | Everything that never enters Tally: production logs, downtime, rejects, inspections, maintenance, dispatch planning, training records |
| **Positioning line** | "Tally stays your books. We're the shop-floor layer next to it." |
| **Landmines to set** | "What do you track outside Tally?" "What do you re-type into Tally every month?" |
| **Landmines they will set** | "Does it integrate with Tally?" (not today; Tally connector is planned as an optional connector) |
| **Questions to ask** | Edition, users, Tally partner name (potential channel), TDL customisations |
| **Walk away when** | The need is accounting, GST or stock valuation. |

---

## Open-source low-code group: Budibase, NocoBase, Appsmith, ToolJet

| | Budibase | NocoBase | Appsmith | ToolJet |
|---|---|---|---|---|
| **Pricing (verified 19 Nov 2026)** | Community $0 self-hosted (no audit logs, no PDF creator, 1 workspace); Cloud from $299/month (2 creators, 20 end users); Enterprise custom ([pricing](https://budibase.com/pricing/)) | Community free; Standard **$800** and Professional **$8,000** one-time with 1 year of upgrades and support; Enterprise on request ([commercial](https://nocode.nocobase.com/en/commercial)) | Free (up to 5 users on cloud); Business **$15/user/month** (up to 99 users); Enterprise **$2,500/month for 100 users** ([pricing](https://www.appsmith.com/pricing)) | Free/Community: 2 builders, 50 end users, 10 apps; Team **$199/builder/month** (SSO, audit logs); Enterprise custom ([pricing](https://www.tooljet.com/pricing)) |
| **Licence** | GPL-3.0 + BSL pro ([building-blocks](../../research/building-blocks.md#c-direct-competitors)) | Apache-2.0 + terms (same) | Apache-2.0 CE (same) | AGPL-3.0 (same) |
| **Strengths** | Automations, RBAC, AI agents roadmap | Plugins, row/field permissions, workflows, "AI employees" | Developer-friendly, JS, Git sync | Workflows, built-in DB, AI app generation |

| | |
|---|---|
| **Where they win** | Free self-hosted editions; global communities; developer extensibility (JavaScript); some have workflows today |
| **Where we win** | Excel-style formulas instead of JavaScript (office staff can maintain apps); Windows one-script install (they mostly assume Docker on Linux, [building-blocks](../../research/building-blocks.md#c-direct-competitors)); audit log and row/column security included rather than enterprise-tier (compare per product); local support and implementation in India |
| **Landmines to set** | "Who on your side writes JavaScript?" "Is the audit log / SSO in the free edition?" "Who installs and patches Docker on your Windows PC?" |
| **Landmines they will set** | "It's free and open source." "It has workflows today." (some do) |
| **Who buys these** | Companies with a developer; IT-led evaluations. Rarely a 60-person plant owner. |
| **Walk away when** | The buyer is a developer who prefers code, or needs workflows today and has someone to run Docker. |

---

## Custom software by a local developer

| | |
|---|---|
| **What it is** | A freelancer or small firm building a PHP/.NET/Access app for a one-time fee; often a relative or the IT vendor |
| **Pricing notes** | No published prices; one-time quotes are common (**Inference**). Ask for the quote. |
| **Where they win** | Exactly the screens the owner asked for; one-time price; personal relationship; sometimes mobile web from day one |
| **Where we win** | Changes later without the developer (Excel-style formulas); security model (row/column rules enforced on the server) instead of hand-coded checks; backups/restore, audit log, environments, upgrades come with the platform; documentation |
| **Landmines to set** | "Who changes it when your process changes, and what does that cost?" "How does it back up, and when was a restore tested?" "Can a supervisor be blocked from the rates column even if he knows the URL?" "Who owns the source code?" |
| **Landmines they will set** | "He's also one person, but he's local and cheaper." (true) |
| **Walk away when** | The developer is family and the owner has decided; or the app is a one-off with no change expected. |

---

## Do nothing (Excel + WhatsApp + paper)

| | |
|---|---|
| **What it is** | The real competitor in most meetings. Free, known, flexible. |
| **Where it wins** | Zero cost, zero training, zero risk of a failed project; WhatsApp reaches everyone's phone |
| **Where we win** | Only where the cost of the current way is visible: hours of re-typing, late MIS, customer audit preparation, lost history when someone leaves, everyone seeing everything |
| **How to fight it** | Use the [ROI model](sales-playbook.md#6-roi-model) with their own numbers; a trigger event (audit, complaint, key person leaving); a small paid pilot with an exit |
| **Landmines to set** | "What did last month's late MIS cost you?" "What happens when your Excel person leaves?" "How long did the last customer audit preparation take?" |
| **Walk away when** | No trigger, no number they care about, and no champion. Put in nurture; check back after their next audit. |
