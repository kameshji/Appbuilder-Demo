# Sales playbook: small Indian manufacturers (and who comes after them)

Status: working draft, 19 Nov 2026. Written for a solo technical founder with no sales team.
Binding rules from [BRIEF.md](../BRIEF.md): nothing fabricated; planned features labelled as planned; no security or
compliance guarantees. Prices are placeholders (`<PRICE_...>`); the launch-plan workstream sets the numbers.
Anything marked **Assumption** is a planning number to replace with your own data after the first 10 conversations.
Legal and tax notes are research for a lawyer or CA to confirm, not advice.

> **Timing rule.** Until your notice period ends (about end of January 2027) and a lawyer has confirmed what you may do,
> every activity in this playbook is **learning and discovery only**: no quotes, no proposals, no pilots, no invoices,
> no signed documents, no product sold or promised. See [README.md](README.md#the-employment-constraint).

---

## 0. The blunt summary

- You are selling a **v0.5 product with no customer, no pilot and no outside security review**. Small manufacturers buy
  outcomes from people they trust, not platforms. Your first three deals are bought on **you**: your process skill, your
  speed, and the fact that you built their sheet into an app in front of them.
- What exists today (per BRIEF) is strong for **office-side** apps: data with row and column security, validation rules,
  formula columns, rollups, comments and tasks, scheduled email reports, backups, environments, two-step verification.
- What sells on the shop floor is **not built yet**: phone layouts, approvals and flows (in progress), WhatsApp alerts,
  PDF output, dashboards, Tally connector. Sell what exists. Pre-sell nothing. Put the gaps in writing.
- Therefore the first pilot is an **office-side app** a supervisor or clerk uses at a PC: production log typed from
  the paper sheet, QC/inspection register, maintenance history, or a daily MIS. Not the operator-at-the-machine app.
- The Windows installer has **not yet been run on a real customer machine** (BRIEF; README "Known limits"). Prove it on
  two borrowed Windows PCs before any pilot. A failed install in front of the plant head ends the deal.

---

## 1. Target account profile (ICP)

### 1.1 Primary: small manufacturer near you

| Attribute | Fits | Why |
|---|---|---|
| Headcount | 20-200 (sweet spot 40-120) | Big enough to have Excel pain and a supervisor layer; small enough that the owner decides |
| Location | Within a day trip of Bhopal first: Govindpura and Mandideep (Bhopal), Pithampur and Sanwer Road (Indore) | Plant walks are the sales motion; travel time is your scarcest resource |
| Process | Discrete, batch or job-shop: auto components, machining, fabrication, plastics moulding, packaging, pharma/food packaging units | Many machines and shifts produce data no ledger holds |
| Systems | Tally (or Busy/Marg) for accounts; Excel and paper for production, QC, maintenance; WhatsApp groups for coordination | The gap between Tally and the floor is the wedge ([manufacturing research](../../research/manufacturing.md)) |
| Trigger events | A customer audit (IATF/ISO customer asked for traceability); a new plant head; a bad month of rejects; the "Excel person" leaving; an ERP project that stalled | Pain plus a deadline |
| Someone who owns the sheet | A plant head, QA head or MIS clerk who maintains a big Excel workbook today | Your champion and later your in-house maker |
| A PC that stays on | A Tally/server PC or any Windows 10/11 PC with 8 GB RAM in the office | Install target ([getting started](../../guide/getting-started.md#what-you-need)) |

### 1.2 Secondary (later, office-side only)

- Coaching institutes and multi-branch tuition chains: leads, batches, fee instalments tracked in Excel, with no
  parent app expected from you (the [education research](../../research/education.md) says ready-made school ERPs win
  for K-12; do not chase schools).
- Distributors and service firms (AMC/service contracts, site engineers) that outgrew Excel and WhatsApp.
- Teams inside larger firms who already own Microsoft 365 but cannot get Power Apps Premium budget.

### 1.3 Disqualifiers (walk away early)

| Signal | Why walk |
|---|---|
| "We want a full ERP: accounts, GST, inventory, payroll, everything" | ERP templates are planned, not built. ERPNext, Odoo and Tally do this today. |
| The core requirement is operator entry on phones at the machine **now** | Phone layouts are planned (see [objection-handling](objection-handling.md#f-we-want-mobile)) |
| They need a WhatsApp alert, PDF document or approval chain as the **first** deliverable | Not built yet; a pilot without it will fail its own success criteria |
| Regulated validation demanded: "must be 21 CFR Part 11 / GMP validated", "need a certified system" | You cannot claim it; no outside audit exists |
| No PC that can stay on, and no budget for a small VPS | Nothing to install on |
| Owner will not meet; only "send me a quotation" by WhatsApp | No champion, price-only comparison, you lose |
| Wants it free "as a pilot" with no named success measure | Free pilots in small firms rarely convert; they also cost you two weeks each |
| More than 200 users, multi-plant consolidation, or HA/uptime SLA required | Single-machine product; no high availability ([security model](../../admin/security-model.md#explicit-limitations)) |
| Machine/PLC auto data capture is the core ask | Not in scope; partner with an IoT vendor later |
| You would need to be on site more than one day a week during the pilot | You cannot serve it and build the product |

---

## 2. The buying committee in a 20-200 person Indian manufacturer

**Inference** from typical small-firm structures; validate in your first 10 discovery conversations.

| Role | Cares about | Fears | What they need to see | How they block you |
|---|---|---|---|---|
| **Owner / MD** (often the founder or second generation) | Cash, rejects, on-time delivery to big customers, not being cheated, his own time | Another software that nobody uses; dependence on a one-man vendor; data going "outside"; hidden yearly costs | His own numbers on one screen; a fixed price; what happens if you disappear; a reference he can call (you will not have one: say so) | "Send quotation", then silence; or hands to the nephew/IT vendor to "check" |
| **Plant head / production manager** | Output vs plan, downtime reasons, supervisor discipline, customer audit questions | Being blamed by the numbers; extra work for supervisors; a tool the owner uses to watch him | Less typing for his team; daily report without chasing; it works on their PC | Quiet non-adoption; "supervisors are busy this month" |
| **Accounts head** (runs Tally) | Books clean for GST and audit; no double entry; nothing touching Tally without control | A second "source of truth" for stock; you touching Tally; extra reconciliation | You do **not** replace or write into Tally; stock/financial numbers stay in Tally; exports in CSV he can check | "This will mismatch with Tally" in the owner's ear |
| **The "computer person"** (nephew, in-house IT, or external IT/AMC vendor) | Their position as the tech expert; no extra calls at night; antivirus, backups, network | Being replaced or embarrassed; responsibility for something they don't understand | Installation steps, service, ports, backups, a diagnostics bundle, and a role (admin) for them | "It's not secure", "cloud is better", "I can build this in Excel/Access/PHP" |
| **The CA** (external, monthly) | Statutory compliance, audit trail for stock records, TDS/GST on your invoice | Records outside Tally being used for statutory purposes | You are not a statutory system; your invoice is a clean GST invoice | Rarely involved unless asked; can kill the deal with one "why do you need this?" |
| **Supervisors / QC inspector / storekeeper** (users) | Finishing the shift, not being shouted at | Being caught by the data; typing twice | Faster than the paper + Excel they do today | Not entering data, or entering it at day end |

**Rule:** single-thread through the owner and you lose to the first objection. By the demo you need the owner plus the
plant head in the room, and the computer person invited (give them the admin role in the pilot).

---

## 3. The sales process, stage by stage

Time budgets are **your** hours. Elapsed time is calendar time. Both are **Assumptions**.

| # | Stage | Entry criteria | What you do | Exit criteria (all must be true) | Artefacts | Your hours | Elapsed |
|---|---|---|---|---|---|---|---|
| 1 | **Prospect** | Fits ICP on paper (sector, size, location) | Research: website, IndiaMART/Justdial listing, LinkedIn of owner/plant head, customers they supply; find an intro path (CA, Tally partner, industry association, friend) | A named person agreed to a 20-30 min conversation | CRM row; account notes | 0.5 | 1-2 weeks |
| 2 | **Discovery** | Conversation booked | 30-45 min call or office visit. Use the [question bank](#4-discovery-question-bank). Listen 80%. Do not demo. | You can write their top 3 pains in their words, who owns which Excel, and who decides. They agreed to a plant walk. | Discovery notes (template in §11) | 1.5 | 1 week |
| 3 | **Plant walk / process mapping** | Owner or plant head agreed to show you the floor | 1.5-2 h walk: follow one job from order to dispatch. Photograph (with permission) the paper sheets and the Excel. Count re-entry steps. Ask for **one Excel sheet** to use in the demo. Offer an NDA. | You have one real sheet (or a sanitised copy), a one-page process map, the baseline numbers for the ROI model (§6), and a demo date with owner + plant head | Process map; baseline sheet; sample Excel | 3 + travel | 1 week |
| 4 | **Demo on THEIR Excel** | You have their sheet and a meeting with the decision makers | Build the app from their sheet live (recipe in §5). Show security, report, backup, export. Close with "what would have to be true for you to run this for six weeks?" | Owner names a pilot scope, a success measure and an owner on their side; asks "what will it cost?" | Demo recording (with permission); 1-page recap sent same day | 4 prep + 2 meeting | 1-2 weeks |
| 5 | **Pilot proposal** | Owner asked for the pilot terms | Send the pilot proposal (§9) within 48 hours; review it in person or on a call, not by email alone | Signed pilot agreement and a PO (or advance paid) | Proposal; pilot agreement (§10); PO | 3 | 1-3 weeks |
| 6 | **Paid pilot** | Advance received; PC/VPS ready | Install (≤ 1 hour target), build 1-2 apps with their champion, train users, weekly 30-min review against success criteria | Success criteria met (or honestly missed) at the week-6 review; owner decides go/no-go | Install record; weekly review notes; week-6 result vs baseline | 25-40 over 6 weeks | 6 weeks (8 max) |
| 7 | **Rollout** | Pilot passed; owner said yes | Licence by seat band; move pilot apps to production environment; train the in-house maker; set backups to a second disk | Licence invoice paid; ≥ 1 in-house person can make simple changes; nightly backup copied off the PC | Licence; handover pack; support terms | 10-15 | 2-4 weeks |
| 8 | **Expansion** | 60 days of live use | Quarterly review; next department app; operator passes; second site | Next app scoped and paid | Account plan | 2/quarter | ongoing |

**Kill points.** If a stage's exit criteria are not met within twice its elapsed time, move the account to "nurture"
(monthly touch) and stop spending hours on it.

---

## 4. Discovery question bank

Ask 8-12 per meeting, not all of them. Write answers in their words. Mark the ones that give ROI baseline numbers (★).

### Owner / general
1. What made you agree to meet now? What happened this month?
2. Which three numbers do you look at every morning? Where do they come from, and how late do they arrive? ★
3. Which customer audit or complaint in the last year cost you the most time?
4. What software have you bought in the last five years that people stopped using? Why?
5. If you were away for two weeks, what would you be most nervous about?
6. Who in the company is best with Excel? What happens when they are on leave?
7. Where does the business data live today: which PC, which phones, which WhatsApp groups?
8. How do you decide on a purchase like this: alone, with a partner, with your CA?

### Production
9. Walk me through one shift: who writes what, on paper or Excel, and when is it typed? ★
10. How many people re-type shift data into Excel each day, and for how long? ★
11. How do you know yesterday's output vs plan by machine? At what time do you know it? ★
12. How are downtime reasons recorded? Who decides the reason codes?
13. Which machine is the bottleneck? What is one hour of it worth to you (contribution, not price)? ★
14. How do you plan the day: Excel, whiteboard, in someone's head?
15. If a customer asks "which batch, which shift, which operator?", how long does it take to answer?

Also ask on the plant walk (from simulation h): *Where is the nearest PC that is unlocked at shift end?* and *Which
fields on the paper sheet does the supervisor actually know at shift end?* Design entry forms from the paper sheet,
not from the planner's Excel.

### Quality
16. Incoming, in-process, final: which inspections are on paper and which in Excel?
17. What is your rejection / scrap rate this year? How sure are you of that number? ★
18. How do you raise and close a non-conformance today? Who chases the CAPA?
19. Which customers audit you (IATF 16949, ISO 9001, pharma customer audits)? What do they ask to see?
20. Where are inspection photos and calibration certificates kept?
21. How long does it take to prepare for a customer audit? ★

### Maintenance
22. When a machine breaks down, how does maintenance hear about it? How long until someone arrives? ★
23. Is there a preventive maintenance plan? Where? How often is it actually followed?
24. Do you have a history card per machine? Can you tell me the top three repeat failures?
25. How do you track spares issued for repairs?
26. How many hours of breakdown did your bottleneck machine have last month? ★

### Stores
27. Who keeps stock: Tally, Excel, bin cards? Which one is right when they disagree?
28. How often does production stop because a consumable, insert or packing material was not there? ★
29. How are reorder levels set and who checks them?
30. How do material issues to production get recorded? Same day?
31. Do you use barcodes or QR labels anywhere?

### Purchase
32. How does an indent become a PO? Who approves, how, and how long does it wait? ★
33. How do you follow up open POs with vendors?
34. How much do you spend on urgent local purchases or express freight because something was late? ★
35. Where are quotations compared?

### Dispatch / sales
36. How do you know what to dispatch today, and who decides priority?
37. How is the packing list or gate pass prepared?
38. What is your on-time delivery rate to your biggest customer? Who tracks it? ★
39. Does dispatch information go back into Tally by re-typing?

### HR / admin
40. Biometric attendance: which device, and where does the data go? Who computes overtime?
41. How many contract workers, and how is their attendance and billing tracked?
42. Safety incidents and near misses: is there a register? Who sees it?
43. Training records for operators (customer audits ask for them): where are they?

### Accounts
44. Which Tally edition and how many users? Who is your Tally partner?
45. What do you re-enter into Tally from other sheets each month? ★
46. What would worry you about another system holding stock or production numbers?
47. How do you prefer vendors to bill software: one-time, yearly? Do you deduct TDS on software and services?
48. Payment terms you normally give vendors? Who signs cheques/approves bank transfers?

### The computer person / IT
49. Which PC is on all the time? Windows version, RAM, antivirus, who has the admin password?
50. Is there a LAN between office and floor? Wi-Fi on the floor? Internet reliability?
51. How are backups done today? When were they last tested by restoring?
52. Any cloud services already used (Google Workspace, Microsoft 365, Zoho)?
53. Who would you call if the PC dies at 9 pm on a Saturday?

### Closing the discovery
54. If we solved only one of these, which one would you pay for first?
55. Who else needs to see a demo for this to go forward?
56. Can I take one Excel sheet (or a copy with the numbers changed) to build a working demo from it?

---

## 5. Demo recipe: "bring one Excel sheet, leave with an app"

### 5.1 Version A: features that exist today (per BRIEF and the product docs)

Goal: in 45-60 minutes of a 90-minute meeting, their own sheet becomes a secured, multi-user app with a daily email
report. Everything below is in [BRIEF.md](../BRIEF.md) as built, with how-to in the linked guides.

**Before the meeting (2-4 hours)**

1. Get the sheet. Prefer a copy with real structure and changed numbers. Never take a sheet without the owner's
   consent; offer a simple NDA (lawyer-reviewed template).
2. Rehearse once on your laptop with their sheet in a **Sandbox environment**, then delete it and start clean so the
   live build is real ([environments](../../admin/environments.md)).
3. Laptop checklist: server running (PostgreSQL install, not demo mode, because [demo mode is not
   secure](../../admin/security-model.md#demo-mode-is-not-secure) and simulates roles); two browser profiles signed in
   as "Owner" and "Supervisor"; SMTP configured if you want the report to arrive by email live; screen recording on
   (ask permission); phone hotspot in case there is no Wi-Fi.
4. Prepare two users (owner, supervisor) and a department/team structure that matches their plant (Line 1, Line 2).

**In the meeting**

| Step | Do | Say (short) | Feature |
|---|---|---|---|
| 1 | Data files > add their .xlsx (≤ 25 MB, no macros). Each sheet becomes a table. | "Your file is copied; the original is never changed." | [Data files](../../guide/maker/data.md) |
| 2 | **Move to database** for the main sheet. | "Now it lives in a proper database (PostgreSQL) on this PC, not in a file someone can overwrite." | Data files, PostgreSQL |
| 3 | Columns: make Line/Shift/Reason a **Choice**, dates a **Date**, quantities numbers; add a **Lookup** to a Machines table. | "No more 'Line1', 'line 1', 'L-1'." | Tables, column types |
| 4 | Open the **data model designer**, show the Production → Machine relationship. | "This is your plant on one page." | [Data model designer](../../guide/maker/data-model.md) |
| 5 | Add a **validation rule** (rejects cannot exceed produced; date not in the future). Try to break it. | "Wrong data is stopped at entry, not found at month end." | Validation rules |
| 6 | Add a **formula column** (Reject % = Rejects / Produced) and a **rollup** on Machine (total rejects). | "Excel formulas, but the server keeps them right for everyone." | Formula columns, rollups |
| 7 | Home > **Start with data**: app with list + form. In the Studio add a date filter and search with a formula they recognise (`Filter(...)`). | "If you can write an Excel formula, your team can change this app." | [Studio](../../guide/maker/studio.md), [formulas](../../guide/maker/formulas.md) |
| 8 | **Security role** "Supervisor": Read/Update scope Team (own line); hide a cost column. Use **Test as user** to show what the supervisor sees and why. | "Line 1 supervisor sees Line 1. Nobody on the floor sees your rates." | [Users and roles](../../admin/users-and-roles.md) |
| 9 | Second browser as Supervisor: add a row. Owner's screen updates **live**. | "No more 'send me the latest file'." | Live updates |
| 10 | On a row: comment and **@mention** the plant head; create a **task** with a due date. | "The WhatsApp discussion, attached to the actual batch." | Tasks, comments, mentions, timelines |
| 11 | **Scheduled report**: yesterday's production by machine with totals, every day at 8 am, to the owner's email. Send a test if SMTP is set. | "Your MIS arrives without anyone compiling it." | [Scheduled reports](../../guide/maker/scheduled-reports.md) |
| 12 | Admin: **Audit log** (who changed what), **Back up now**, **Export environment data** (every table as CSV in a ZIP). | "It's your data. You can take all of it out any day, in CSV." | [Audit log](../../admin/audit-log.md), [backup and restore](../../admin/backup-and-restore.md) |
| 13 | Close: "What would have to be true for you to run this for six weeks? Who would own it on your side?" | | |

**What "leave with an app" honestly means:** they saw their sheet become a working app, and they get the recording,
screenshots and a one-page recap the same evening. **Do not install on their PC in the demo meeting**: their data, their
IT person, and an installer not yet proven on a customer machine make that a pilot activity.

**Do not show:** flows (in progress; the editor is a JSON definition, not a visual designer), any "Soon" menu entry as
if it works, phone screens on a real phone unless you have tested that exact app on Android over a LAN, the demo-mode
browser build.

**Phone note:** the Studio has phone design sizes and "Start with data" makes a phone list/form
([apps guide](../../guide/maker/apps.md#phone-and-tablet-apps)), but BRIEF still lists phone layouts as planned and
nothing has been tested on a shop floor. Treat phone use as **not sellable** until you have run a pilot app on two
cheap Android phones over the plant Wi-Fi for a week. Then update this playbook and BRIEF together.

### 5.2 Version B: once flows, approvals, phone layouts, PDF and WhatsApp exist (planned P1-P2)

Add, in this order, only when each is released and tested:

1. Supervisor enters the shift log on a phone at the line (phone layout, P2).
2. A rejection above the limit raises an NCR and asks the QA head to approve the disposition (flows + approvals, P1).
3. Breakdown ticket: maintenance gets an alert, escalation to the plant head if not acknowledged in 30 minutes (flows, P1;
   WhatsApp, P2).
4. 8 am: OEE and output vs plan as a PDF in the owner's WhatsApp (PDF, dashboards, WhatsApp, P2).
5. Indent → approval → PO with a value limit (approvals, P1; PDF PO, P2).

Script line for version B: "Last time you saw your sheet become an app. Today, watch what happens when a supervisor
records a reject on his phone." Until then, never say "it can also...".

---

## 6. ROI model

### 6.1 Principles

- Use **their** baseline numbers from discovery (★ questions). The worked example uses labelled **Assumptions** only to
  show the mechanics. Never present the example as a promise or a statistic.
- Apply a **realisation factor** (default 50%) to everything. Small-firm owners trust a conservative number and
  discount an optimistic one to zero.
- Split benefits into **"today"** (features that exist) and **"after P1/P2"** (flows, approvals, phone, WhatsApp).
  The pilot's business case must stand on "today" alone.

### 6.2 Spreadsheet logic (build in Excel now; later as an Appbuilder app with formula columns)

Inputs (yellow cells). Every input is an **Assumption** until replaced by the customer's figure.

| Cell | Input | Example (60-person plant) | Source |
|---|---|---|---|
| B2 | People who re-type paper/Excel data daily | 4 | Discovery Q10 |
| B3 | Hours each spends re-typing and compiling per day | 1.5 | Discovery Q9-10 |
| B4 | Share of that time removed (desk entry once, no compiling) | 50% | Assumption; 70%+ only with phone entry (P2) |
| B5 | Working days per month | 26 | Plant calendar |
| B6 | Loaded cost per clerk/supervisor hour (₹) | 150 | Assumption: ₹25k/month salary ÷ 208 h × 1.25 |
| B7 | Hours per week a manager spends building the MIS | 6 | Discovery Q2 |
| B8 | Share of MIS time removed by scheduled reports | 65% | Assumption |
| B9 | Manager loaded cost per hour (₹) | 400 | Assumption |
| B10 | Monthly material consumption (₹) | 40,00,000 | Owner / Tally |
| B11 | Current scrap/rejection rate | 4.0% | Discovery Q17 (often unknown: measure in pilot) |
| B12 | Scrap reduction from daily visibility (percentage points) | 0.25 | Assumption, deliberately small |
| B13 | Bottleneck machine contribution per hour (₹) | 1,500 | Owner |
| B14 | Bottleneck hours recovered per week via downtime-reason visibility | 2 | Assumption |
| B15 | Production-stopping stock-outs per month | 2 | Discovery Q28 |
| B16 | Hours lost per stock-out | 3 | Discovery Q28 |
| B17 | Line contribution per hour (₹) | 2,000 | Owner |
| B18 | Share of stock-outs avoided (daily below-reorder email report today) | 30% | Assumption; 50% with alerts (P1/P2) |
| B19 | Urgent purchase / express freight premium per month (₹) | 15,000 | Discovery Q34 |
| B20 | Share avoided by faster approvals | 25% | Assumption; **only after P1 approvals** |
| B21 | Realisation factor | 50% | Policy |
| B22 | Year-1 cost: licence (₹) | `<PRICE_BAND_50>` | Launch plan |
| B23 | Year-1 cost: setup / pilot / training services (₹) | `<SETUP_FEE>` | Launch plan |
| B24 | Customer's internal time cost (₹) | 30,000 | Assumption: champion 2 h/week × 15 weeks × ₹1,000 |

Calculations:

| Cell | Benefit line (annual ₹) | Formula | Example result | Available |
|---|---|---|---|---|
| C2 | Re-entry time saved | `=B2*B3*B4*B5*12*B6` | 4×1.5×0.5×26×12×150 = **1,40,400** | Today |
| C3 | MIS compilation saved | `=B7*B8*52*B9` | 6×0.65×52×400 = **81,120** | Today |
| C4 | Scrap reduction | `=B10*12*(B12/100)` | 40,00,000×12×0.0025 = **1,20,000** | Today (needs honest daily entry) |
| C5 | Bottleneck hours recovered | `=B13*B14*50` | 1,500×2×50 = **1,50,000** | Today (downtime log at desk); better with phone (P2) |
| C6 | Stock-outs avoided | `=B15*B16*B17*B18*12` | 2×3×2,000×0.3×12 = **43,200** | Today (scheduled report); more with alerts |
| C7 | Approval delays (expediting) | `=B19*B20*12` | 15,000×0.25×12 = **45,000** | **After P1** |
| C8 | Gross benefit today | `=SUM(C2:C6)` | **5,34,720** | |
| C9 | Gross benefit after P1/P2 | `=C8+C7` | 5,79,720 | |
| C10 | Conservative benefit today | `=C8*B21` | **2,67,360** | |
| C11 | Year-1 total cost | `=B22+B23+B24` | depends on prices | |
| C12 | Payback (months) | `=C11/(C10/12)` | e.g. cost ₹1,00,000 → 4.5 months | |
| C13 | Year-1 ROI | `=(C10-C11)/C11` | | |
| C14 | Break-even licence price | `=C10-B23-B24` | the most a rational owner would pay in year 1 | |

How to use it in the meeting: fill B2-B20 **with the owner**, on his numbers, in front of him. If C10 is below about
2× C11, the deal is weak: say so and narrow the scope rather than inflate the assumptions.

Pilot measurement: C2, C3 and C5 can be measured in six weeks (time logs, MIS hours, downtime hours). C4 usually
cannot: six weeks of honest data mostly **reveals** the true scrap rate. Promise visibility, not reduction.

---

## 7. Pricing and packaging talk track

Model (BRIEF, not decided): **one licence per install by seat band** (25 / 50 / 100 users) with **user passes**: Full
user (builds or uses everything), Operator (data entry and own work), External (outside party, later). Numbers come
from the launch plan: `<PRICE_BAND_25>`, `<PRICE_BAND_50>`, `<PRICE_BAND_100>`, `<PASS_FULL>`, `<PASS_OPERATOR>`,
`<PASS_EXTERNAL>`, `<SETUP_FEE>`, `<AMC_OR_SUPPORT>`.

**Talk track (say it in this order):**

1. "You pay for the install, by size band, not per app, per flow or per connector. Add apps without a new bill."
2. "Shop-floor people are Operator passes, priced below a full user, so you are not punished for headcount."
   (Operator passes and licence enforcement are planned in P3; until then say "the pass structure we are introducing".)
3. "It runs on your PC. Your data is in a standard PostgreSQL database you can export any day."
4. "The pilot fee is credited against year one if you continue." (See §8.)
5. "Setup and training are separate and fixed-price, so you know the total before we start."
6. Then stop talking.

**Packaging for year one (proposal structure):**

| Line | What | Price |
|---|---|---|
| Licence | Install licence, seat band chosen by user count, includes updates for 12 months | `<PRICE_BAND_xx>` |
| Passes | Full users × n, Operator passes × m (when passes ship) | `<PASS_...>` |
| Implementation | Fixed scope: apps listed by name, roles, reports, training sessions | `<SETUP_FEE>` |
| Support | Hours, channels and response targets (best effort, business hours; no uptime SLA) | `<AMC_OR_SUPPORT>` |
| Change requests | Day rate after the fixed scope | `<DAY_RATE>` |

Do not discuss price before the demo except as a range ("for a plant your size, the first year is usually in the range
of `<RANGE>`, including setup"). A small-firm owner who asks price first is checking whether to keep listening; a range
answers that.

Comparing against competitors' published prices: use only the verified numbers in
[competitive-battlecards.md](competitive-battlecards.md) and say the date you checked.

---

## 8. Pilot offer

| Item | Offer |
|---|---|
| **Scope** | 1 app (max 2), from their real sheet, for one department or line. Office-side entry at a PC. Up to 15 users. One security role structure, one scheduled report. **Explicitly excluded:** phone entry, WhatsApp, PDF, approvals, Tally integration, machine data (all planned, not built). |
| **Duration** | 6 weeks of use after install (8 weeks maximum, then a decision is due) |
| **Where** | Their Windows 10/11 PC or Windows Server (8 GB RAM recommended), or a small Linux VPS they own. LAN access with HTTPS from the installer. |
| **Fee** | `<PILOT_FEE>`, 50% on signing (or against PO), 50% at the week-3 review. **100% credited** to year-one licence if they continue within 30 days of the decision. |
| **Their commitments** | A named champion (2 h/week), the owner at the week-0 and week-6 reviews, supervisors trained in two 45-minute sessions, the baseline numbers from discovery |
| **Our commitments** | Install ≤ 1 day, app live by end of week 1, weekly 30-minute review, issues answered within one business day, nightly backup configured and a restore tested in front of their IT person |
| **Success criteria (example; agree numbers at signing)** | (1) ≥ 80% of shifts/inspections logged in the app for the last 3 weeks; (2) the 8 am report used by the owner/plant head on ≥ 4 days a week; (3) MIS compilation time reduced by ≥ 50% vs baseline; (4) zero data-loss incidents; restore drill passed |
| **Exit** | At any time: full export (CSV ZIP of every table plus attachments list), uninstall, no further fee beyond what is due. Data stays theirs. |
| **Decision** | Week-6 meeting: go (licence + rollout), extend (once, 2 weeks, only for a named reason), or stop (export, uninstall). |

Why paid: a fee forces the owner to assign a champion. A free pilot in a small firm usually means nobody's job depends
on it. If the owner refuses any fee, offer a smaller scope, never zero.

---

## 9. Proposal template (2 pages max)

```
PROPOSAL: <App name> pilot for <Company>                       Date: <date>  Valid until: <date + 30 days>
Prepared for: <Owner name>, <Plant head name>                  Prepared by: <Founder name>, <Entity name>, GSTIN <...>

1. What you told us (in your words)
   - <Pain 1 with their number, e.g. "Two people spend 3 hours a day typing shift sheets">
   - <Pain 2>
   - <Pain 3>
2. What we will build in the pilot
   - App: <name>, from <their sheet name>. Users: <roles and counts>. Report: <name, time, recipients>.
   - Not included in this pilot: phone entry, WhatsApp, PDF documents, approvals, Tally link (these are on our
     roadmap; we will tell you when each is released and tested).
3. How we will measure success (baseline from our visit on <date>)
   | Measure | Today | Target at week 6 |
4. Plan
   Week 0 install and baseline | Week 1 app live, training | Weeks 2-5 use, weekly review | Week 6 decision
5. Fee
   Pilot: <PILOT_FEE> + GST. 50% on signing, 50% at week 3. Credited in full to the year-one licence if you continue.
   Year one if you continue (indicative): licence <PRICE_BAND_xx>, setup <SETUP_FEE>, support <AMC_OR_SUPPORT>, + GST.
6. Your data and continuity
   Data in PostgreSQL on your machine; full CSV export any time; nightly backups; documentation; <continuity
   commitments chosen from objection-handling.md>.
7. What we need from you
   Champion: <name>. PC: <spec>. Two training slots. Baseline numbers.
8. Honest status
   Appbuilder is version <x>. You would be among our first customers. There has been no outside security audit yet.
9. Next step
   Sign the attached pilot agreement or issue a PO; we install on <date>.
```

---

## 10. One-page pilot agreement outline (for a lawyer to draft)

Not legal advice. Have a lawyer turn this into the actual document once, then reuse it.

1. **Parties** and effective date.
2. **Scope**: apps, users, exclusions (copy from proposal §2).
3. **Term**: 6 weeks of use from install date; decision meeting date; one optional 2-week extension.
4. **Fees and payment**: amount, GST, milestones, credit towards licence, TDS handling (customer deducts at the
   applicable rate and issues the TDS certificate; see §12).
5. **Licence for the pilot**: non-exclusive, non-transferable right to use during the term at one install.
6. **Customer data**: belongs to the customer; vendor accesses it only to deliver the pilot; confidentiality both ways;
   vendor deletes any copies it holds within 15 days of the end (and confirms in writing). Note DPDP obligations (most
   apply from about 13 May 2027 per the [manufacturing research](../../research/manufacturing.md#5-architecture-and-deployment)):
   lawyer to add a processing clause.
7. **Customer responsibilities**: hardware, OS licences, antivirus, physical security of the PC, backups copied off
   the PC, a champion.
8. **Security statement**: describes the measures that exist ([security model](../../admin/security-model.md)); states
   there has been no outside audit; no warranty of fitness for regulated use (GMP, 21 CFR Part 11, statutory registers).
9. **Warranty and liability**: software as is during the pilot; liability capped at fees paid; no consequential loss.
10. **Exit**: export and uninstall at any time; what survives (confidentiality, data deletion).
11. **IP**: vendor owns the platform; customer owns its data and app definitions built from its sheets (decide and
    state this explicitly; it is a strong selling point).
12. **Non-solicitation, governing law (India), jurisdiction (Bhopal or the customer's city), signatures.**

---

## 11. Negotiation guidance

**Guardrails (decide once, do not improvise in the room):**

| Lever | Floor | Rule |
|---|---|---|
| Licence discount | Max `<MAX_DISCOUNT>` % (suggest ≤ 15%) | Only in exchange for something on the trade list. Never for "please". |
| Pilot fee | Never zero | Reduce scope instead of price |
| Setup fee | Can be split over 2-3 milestones | Do not discount; it is your time |
| Payment terms | 50% advance for pilot; licence on delivery; max 30 days | Longer terms only with a PO from a creditworthy firm |
| Free change requests | 0 beyond agreed scope | Offer a fixed "change bucket" of hours instead |
| Roadmap promises | None with dates | "When it is released and tested, you get it under your licence" |

**Trade list (what you can get for a concession):**

1. Permission to name them as a customer (only after go-live, in writing, and only facts they approve).
2. A reference call with a future prospect (max 2 per quarter).
3. Two-year commitment or annual pre-payment.
4. Introduction to two other owners (their supplier, their customer, their association).
5. A written case study with their real numbers (approved by them).
6. Faster payment (full advance).
7. Acting as the design partner for the manufacturing template (feedback sessions; their sheets become the template,
   anonymised, with permission).

**Small-firm specifics:** the owner will ask for "final price" at least twice. Answer the first time with the trade
list, the second time with a decision ("I can do X if you can do Y today"). Never discount by WhatsApp. Never negotiate
with the nephew/IT vendor; they can block, not buy.

---

## 12. Procurement in small firms (PO, GST invoice, payment terms, TDS)

Research notes for your CA to confirm before the first invoice.

1. **Vendor registration**: expect a form asking for PAN, GSTIN, bank details with a cancelled cheque, address proof
   and, if you have it, Udyam registration. Have these as one PDF.
2. **PO**: ask for a PO even for the pilot. Check the PO has: scope by reference to your proposal, amount + GST, payment
   terms, and your legal entity name exactly as on your GST registration.
3. **GST**: business customers want a GST invoice to claim input tax credit, so plan to register even below the
   threshold (CA to confirm threshold and timing). Software licensing for the right to use software is commonly
   classified under SAC 997331 at **18%** since 22 September 2025
   ([Busy: SAC 997331](https://busy.in/sac-code-997331/), secondary source; CA to confirm SAC for licence vs
   implementation services). Quote all prices "+ GST".
4. **TDS**: since 1 April 2026 the Income-tax Act, 2025 applies; the old section 194J corresponds to section 393, with
   10% for professional services and "other royalty", 2% for fees for technical services, threshold ₹50,000
   ([Busy: section 393 guide](https://busy.in/tds/section-393-tds-on-professional-and-technical-fees-rates-threshold-due-dates-and-compliance-guide-for-tax-year-2026-27/),
   secondary). Software licence payments are often treated as royalty (10%) by buyers' accountants; implementation as
   technical services (2%). **Unverified for your contract wording**: let your CA advise how to word invoices and
   split lines. Practical point: TDS reduces cash received, not the price. Track TDS certificates and match them in your
   Form 26AS / annual information statement.
5. **Payment terms and the MSME rule**: if your entity is a registered micro or small enterprise (Udyam), buyers who
   pay later than 15 days (no written agreement) or 45 days (written agreement) can lose the tax deduction for that
   year; under the 2025 Act the corresponding provision is cited as section 37(2)(g) from tax year 2026-27, and the
   MSMED Act interest is three times the RBI bank rate ([Busy: 43B(h) explained](https://busy.in/tds/section-43bh-msme-payment-rule-and-45-day-limit-explained/),
   secondary; transition details unclear, CA to confirm). Put "Udyam registered: payment within 45 days of acceptance"
   on your proposals once registered. It is a polite, legal lever.
6. **Cheques and approvals**: in small firms the owner signs every payment. Get the advance in the same meeting the
   agreement is signed, or it slips weeks.
7. **Entity**: you cannot invoice until your entity exists and your employment constraint has ended; see
   [README.md](README.md#the-employment-constraint).

---

## 13. Expansion plays

| Play | Trigger | Offer |
|---|---|---|
| Second app, same department | Pilot app used daily for 60 days | Next sheet (e.g. QC after production log); fixed setup fee |
| Next department | Plant head shows the report in a management meeting | Maintenance history, stores issue register, training records |
| Operator passes | Phone layout released and tested (P2) | Move entry to the line; passes for operators |
| Approvals | Flows and approvals released (P1) | Indent/PO approval, NCR disposition, scrap write-off |
| Seat band upgrade | Users approach band limit | Next band; credit the unused part |
| Second plant / warehouse | Multi-site customer | Second install or row security by site (single install, if load allows) |
| In-house maker training | Champion wants to change apps himself | 2-day maker course, fixed fee |
| Template partner | Customer's apps generalise | Discount in exchange for anonymised template rights |
| Referral | 90 days of live use, owner happy | Ask for two named introductions (script in [outreach-kit](outreach-kit.md#referral-ask)) |

---

## 14. Channel partners: Tally partners and CAs

**Why them:** Tally describes "thousands of authorised partners across India", from large resellers to individual
consultants, who sell licences, implement, train and offer AMCs ([Tally, May 2026](https://tallysolutions.com/business-guides/how-to-choose-the-right-tallyprime-partner/)).
They already visit your ICP every month. CAs see the books and hear the owner's complaints.

**What they fear:** you replacing Tally, you taking their AMC, a product they cannot support, a one-person vendor.

**Partner models (pick one per partner; numbers are placeholders):**

| Model | Partner does | Partner earns | You do |
|---|---|---|---|
| Referral | Introduces the owner, attends discovery | `<REFERRAL_PCT>` % of year-one licence, paid after customer pays | Everything else |
| Reseller | Sells, invoices the customer, first-line support | Buys at `<PARTNER_DISCOUNT>` % off list | Install, build, second-line support |
| Implementer (later) | Builds apps after your maker training | Their own service fees | Licence, platform support |

**Partner pitch (2 minutes):**

> "Your clients keep accounts in Tally, and production, quality and maintenance in Excel and WhatsApp. That part is
> not your business today and nobody serves it well. I build that layer: apps from their own Excel sheets, on their own
> PC, next to Tally. I don't touch Tally and I don't sell accounting, so your Tally relationship and AMC are safe.
> Introduce me to two clients who complain about Excel. If they go ahead, you earn `<REFERRAL_PCT>` % of the first-year
> licence. Later, if you want, I train one of your people to build these apps and you earn service income too.
> Honest status: the product is new, I'm looking for my first customers, and there is no Tally connector yet; it is a
> planned feature. Today the apps sit beside Tally, not inside it."

**Partner red flags:** wants exclusivity for a whole city before any deal; wants you to build a Tally TDL; wants to white
label and own the customer relationship before you have three customers.

Simulation of a partner conversation: [simulations.md](simulations.md#d-a-tally-partner-evaluating-reselling).

---

## 15. Pipeline maths for a solo founder

**Target:** 3 paid pilots signed within 3 months (12 weeks) of the day you are free to sell. Pilots take 4-6 weeks from
first contact to signature (**Assumption**), so conversations must happen mostly in weeks 1-8.

Stage conversion rates are **Assumptions** (no sourced benchmarks for this segment). Replace them with your own after
20 conversations.

| Stage conversion | Low | Base | High |
|---|---|---|---|
| Discovery conversation → plant walk | 30% | 40% | 50% |
| Plant walk → demo on their Excel | 50% | 60% | 70% |
| Demo → pilot proposal | 35% | 50% | 65% |
| Proposal → paid pilot | 25% | 40% | 60% |
| **Conversation → paid pilot** | **1.3%** | **4.8%** | **13.7%** |

Required volume for 3 pilots:

| | Low | Base | High |
|---|---|---|---|
| Proposals | 12 | 8 | 5 |
| Demos | 34 | 15 | 8 |
| Plant walks | 69 | 25 | 11 |
| Discovery conversations | 229 | 63 | 22 |
| Conversations per week (over 8 weeks) | ~29 | ~8 | ~3 |
| Outreach touches per week (warm intro → conversation 30%, cold → 5%; **Assumptions**) | not feasible | ~15 warm or ~50 cold + 5 warm | ~10 warm |
| Your selling days per week (walk ≈ 0.5 day + travel, demo ≈ 1 day incl. prep) | > 6: impossible | ≈ 4 | ≈ 2 |

**Blunt read:**

- The **base case eats about four days a week** for two months. You cannot also build P1/P2. Either accept that product
  work slows for those weeks, or aim for **2 pilots in 3 months** (≈ 2.5 selling days/week).
- The **low case is not reachable solo.** If after 20 conversations you are tracking low, do not add volume; change
  the input: tighter ICP (one sub-sector, one industrial area), warm intros only (CA/Tally partner), or wait for
  phone/flows to ship.
- Warm introductions convert far better than cold outreach in small Indian firms (**Inference**). Spend the
  pre-notice-end period building the intro network (CAs, Tally partners, associations), not a cold list.
- Cluster: book 2-3 plant walks on the same day in the same industrial area.

---

## 16. Weekly operating rhythm (after notice end)

| Day | Morning (deep work) | Afternoon |
|---|---|---|
| Monday | Product | Pipeline review (30 min, rules below); outreach batch: 10 warm + 10 cold touches |
| Tuesday | Field day: 2-3 discovery meetings / plant walks in one industrial area | |
| Wednesday | Product | Demo prep from sheets collected; follow-ups |
| Thursday | Field day: demos / pilot reviews | |
| Friday | Product | Pilot support; proposals out; partner meeting (CA/Tally partner) one per week; CRM clean-up; write what you learned (one paragraph) |

Pipeline review rules: every deal has a next step with a date; any deal past 2× its stage time goes to nurture; count
conversations, walks, demos, proposals this week vs the base case; move one stuck deal by phone, not email.

During pilots: block Thursday afternoons for the pilot customer every week. Never miss a weekly review.

---

## 17. CRM fields

Run the pipeline in Appbuilder itself (a table plus a scheduled Monday report): it is your best demo and dog-fooding.
Until then, one spreadsheet with these columns.

**Accounts**: Account name; Sector/sub-sector; City / industrial area; Headcount band; Turnover band (if known);
Systems (Tally edition, ERP, Excel, other); IT setup (server PC, LAN, internet); Source (CA, Tally partner,
association, LinkedIn, event, cold); Introducer; ICP fit score (0-5); Disqualifier flags; Trigger event; Notes.

**Contacts**: Name; Role in buying committee (Owner, Plant head, Accounts, IT person, CA, User); Phone; Email;
WhatsApp opt-in (Yes/No, date, how obtained); Do-not-contact flag; Preferred language (English/Hindi);
Last contact date.

**Opportunities**: Account; Stage (1-8 from §3); Stage entry date; Next step; Next step date; Pains (top 3, verbatim);
Baseline numbers (★ answers); Sheet received (Y/N, date, NDA Y/N); Proposed scope; Excluded items acknowledged (Y/N);
Pilot fee; Licence band; Expected close date; Probability (from stage, not gut); Competitors mentioned; Product gaps
raised (multi-select: Phone, Approvals/flows, WhatsApp, PDF, Dashboards, Tally connector, Biometric, Mobile offline,
Security audit, Continuity, Price); Loss reason; Won/lost date.

**Activities**: Date; Type (call, visit, demo, email, WhatsApp, partner meeting); Contact; Outcome; Minutes spent
(to compute selling time per pilot).

**Partners**: Name; Type (Tally partner, CA, IT vendor, association); Clients in ICP (est.); Agreement model;
Intros made; Deals; Commission due.

The "Product gaps raised" field is the most important one for you as founder: it is the roadmap's evidence. Review it
monthly against [simulations.md](simulations.md#summary-product-gaps-ranked-by-how-often-they-lose-deals).
