# Launch plan: from 0.5.0 to first paying customers

Status: DRAFT for the founder, 19 Nov 2026. Research date for every price, law and fact below: 18-19 Nov 2026
unless a source says otherwise. Binding constraints: [BRIEF.md](BRIEF.md). Product phases: [master plan](../plan/master-plan.md).

Labels used: **Estimate** = our own number, not a quote. **Inference** = our judgement. **Unverified** = we could
not confirm it from an official or primary source. Nothing here is legal or tax advice; see
[legal-essentials.md](legal-essentials.md) for the lawyer/CA brief.

## 0. The blunt summary

1. The master plan says the pilot starts after P3 (chat, Notes, CRM/ERP-lite templates, licence passes). That is
   too late for a one-founder company. The plan below defines a **pilot-minimum** cut: P1 complete, a thin slice
   of P2, and only the manufacturing templates from P3. Everything else waits for paying customers to ask for it.
2. The founder cannot sell, incorporate or take money while employed (no-moonlighting policy, notice until about
   end of January 2027). Use the notice period to finish the pilot-minimum product and the paperwork drafts.
   Commercial activity starts the day after the last working day, not before. See section 2.
3. The largest legal risk is not tax or data protection. It is whether the employer's IP-assignment clause can
   reach a product built during employment, in a field close to the founder's day-job specialism (the research
   in `docs/research/power-platform/` and the positioning "your own Power Platform" make the adjacency obvious).
   A lawyer must read the actual contract before the last working day.
4. Licence revenue at realistic Indian SME prices will not support the founder in year one. At the recommended
   ₹60,000 per site per year, ₹24 lakh of annual licence revenue needs 40 sites. Setup, customisation and support
   services will be most of the revenue for the first 12-18 months (**Inference**). Plan the business as
   "product-led services" until the product sells itself.
5. Do not lead with "low-code platform". Lead with three finished shop-floor apps (production log + OEE, quality
   inspection + NCR, maintenance) installed on the plant's own PC, as the manufacturing research recommends.

## 1. Timeline at a glance (Estimate)

| Stage | Window (estimate) | Gate to leave the stage |
|---|---|---|
| 0 Pilot readiness | now to about Mar 2027 | pilot-minimum product passes its exit checks; entity, bank, GST and pilot paperwork exist |
| 1 Design-partner pilot | about Mar to Jun 2027 | one manufacturer uses it daily for 8+ weeks and agrees to pay |
| 2 Three to five paid pilots | about Jul to Dec 2027 | at least 3 paying sites, outside security review done, support load measured |
| 3 Public launch, India | 2028 H1 (earliest) | repeatable sale without the founder on site; 15-20 paying sites |
| 4 Global | not before 2028 H2 | 20+ paying Indian sites, export paperwork and GDPR set-up ready |

These dates assume one full-time founder after the notice period and AI-assisted development. Every date is a
target, not a promise. Slip is likely; the kill criteria in each stage say when a slip means "stop".

## 2. Sequencing around the employment constraint

General information only; the lawyer reads the real contract (see legal-essentials.md section 1).

| Before the last working day (LWD) | Day after LWD, week 1-2 | Weeks 2-6 after LWD |
|---|---|---|
| Lawyer reads employment contract, code of conduct, IP clause (paid by founder personally) | Apply for company incorporation (SPICe+, see legal file) | Bank account, PAN/TAN, GST registration, Udyam |
| Keep building only on own laptop, own accounts, own internet, outside working hours | Sign IP assignment deed: founder to company | File trademark (after Udyam, to get the lower fee) |
| Name screen and domain purchase in personal name (low risk; confirm with lawyer) | Start customer conversations (section 5.2) | Sign design-partner pilot agreement |
| Draft (not sign) pilot agreement, EULA, NDA with lawyer | Publish a plain website without prices or a "buy" button (optional) | Install pilot |
| No company, no directorship, no customer meetings, no website with offers, no invoices, no money | | |
| Collect relieving letter and full-and-final settlement; check gratuity and bonus effects of any early release | | |

Why not use a family member's entity to start earlier: if the founder does the work, the activity is still his,
the IP still has to be assigned from him, and the arrangement can look like an attempt to get around the contract
(**Inference**). Section 1 of the legal file sets out the options and risks.

---

## 3. Stage 0: pilot readiness (now to about Mar 2027)

### 3.1 What must be true in the product

The master plan's definition of pilot-ready is the target: installed in under an hour, used daily by at least 10
people on at least 3 apps with approvals and alerts, backed up nightly, survivable without us on site.

Mapped to the master plan phases:

| Need for the pilot | Master plan phase | Pilot-minimum decision |
|---|---|---|
| Install on a customer-class Windows PC in under an hour | P0 exit check | **Must.** The brief says the Windows installer is not yet proven on a customer machine. Test on at least three different PCs (Windows 10 and 11, 8 GB RAM, an old office PC, a machine with antivirus). |
| Flows: table events, schedules, conditions, notify | P1 | **Must.** Breakdown escalation, PM due reminders and daily report depend on it. |
| Approvals inbox | P1 | **Must.** Indent/PO and NCR disposition approvals are the manufacturer's must-have (manufacturing research section 2). |
| Notifications in-app and email; scheduled reports by email | P1 | **Must** (email reports already exist per the brief). |
| Purchase-approval flow runs a week without loss | P1 exit check | **Must.** Run it on our own test box for 7 days before the pilot. |
| Phone layout | P2 | **Must, thin:** three phone entry screens only (shift production entry, breakdown ticket, inspection reading). Not a general phone designer. |
| PDF output | P2 | **Should:** one document (daily production/OEE summary or NCR). A printable page is an acceptable stopgap. |
| Dashboards | P2 | **Must, thin:** one OEE/MIS board for the owner. |
| WhatsApp connector | P2 | **Defer, with risk.** Research says buyers expect WhatsApp alerts. WhatsApp Business Platform needs business verification, which needs a registered entity (**Inference**; confirm with the chosen provider). Start with email and in-app; add WhatsApp once the company exists. |
| Auto-generated apps, template catalogue | P2 | **Defer.** Build the three pilot apps by hand in the Studio. |
| Manufacturing pack (production log + OEE, QC + NCR, maintenance) | P3 | **Must**, as three apps plus data model, packaged as a solution so it can be reinstalled. |
| Chat, Notes, CRM-lite, ERP-lite with GST ledgers | P3 | **Defer.** ERP ledgers need the verified GST spec and an accountant's review (master plan section 10); not for the pilot. |
| Licence passes and licence portal | P3 | **Defer.** Issue one signed licence file by hand. |
| Tally connector | P3 | **Defer** unless the design partner's stores or dispatch app needs it; the first three templates do not. |
| Single sign-on | P3.5 | Defer. |
| Agents | P4 | Out of scope. |
| Backup, restore drill, diagnostics bundle | P0 | **Must** on the customer box, with a restore drill in week 1. |
| Security contact | `SECURITY.md` | **Must:** fill in the security contact and response times (currently placeholders). |
| Outside security review | master plan section 5 | Required "before the pilot goes beyond one company": so before Stage 2, not Stage 1. |
| Windows code-signing certificate | not in the plan | **Should** (**Inference**): unsigned installers trigger SmartScreen warnings that scare a small customer's IT person. Needs an entity for an organisation certificate, so it lands just after LWD. |

Exit check for Stage 0 (all must pass, written down with date):

1. Clean install on three different Windows PCs, each under one hour, by someone other than the founder following
   `docs/admin/installation.md` (**Inference**: a friend or family member is a fine tester).
2. The three pilot apps run end-to-end with test data: entry on a phone, approval, escalation, daily email report,
   OEE board.
3. Purchase-approval flow with escalation runs 7 days without a lost event.
4. Restore drill from a nightly backup on a second machine passes.
5. Paperwork ready: entity incorporated, bank account, pilot agreement and beta EULA reviewed by a lawyer.

### 3.2 Owner tasks

- Freeze scope to the table above. Write a one-page pilot-minimum spec and do not add to it.
- Book the lawyer for the employment contract review this month (before LWD).
- Run the name process (section 9) and buy domains.
- Prepare the pilot kit: one-page leaflet (Hindi and English), 5-minute demo script on the three apps, a laptop
  demo with realistic data, a sample daily OEE email, the draft pilot agreement.
- After LWD: incorporate, sign the IP assignment deed, open bank, GST, Udyam, trademark.

### 3.3 Budget (Estimate, INR)

| Item | Low | High | Note |
|---|---|---|---|
| Lawyer: employment contract review | 5,000 | 15,000 | Founder pays personally |
| Company incorporation incl. professional fee | 8,000 | 20,000 | Government fee is nil for authorised capital up to ₹15 lakh per [LegalRaasta, Aug 2026](https://www.legalraasta.com/blog/pvt-ltd-vs-llp-vs-opc-in-india/); stamp duty varies by state |
| IP assignment deed, pilot agreement, beta EULA, NDA (lawyer) | 25,000 | 60,000 | |
| Trademark, 2 classes, government fee | 9,000 | 18,000 | ₹4,500/class for startups and small enterprises, ₹9,000 otherwise ([S.S. Rana fee table](https://ssrana.in/ip-laws/trademarks-in-india/tm-filing-fees-forms-india/)) |
| Trademark search opinion | 5,000 | 15,000 | |
| Domains (.com, .in, one more) | 2,000 | 5,000 | |
| Windows code-signing certificate, 1 year | 20,000 | 45,000 | **Unverified** price range; get quotes |
| Test hardware (one low-end mini PC or used office PC) | 0 | 40,000 | Use an existing PC if possible |
| **Total** | **~74,000** | **~2,18,000** | excludes the founder's living costs |

The real Stage 0 budget is the founder's personal runway. Plan for at least 12 months of personal expenses with
no salary (**Inference**).

### 3.4 Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Employer claims the product IP | could block the whole venture | lawyer review before LWD; clean-room hygiene; written IP assignment to the company |
| Pilot-minimum scope still too large | pilot slips past mid-2027 | cut phone layout to one screen and PDF to none before cutting flows or approvals |
| Windows installer fails on real PCs | first impression lost | three-PC test, offline bundle, a printed install checklist |
| WhatsApp missing | buyers lose interest | show the email report and in-app alerts; promise WhatsApp only with a date you can meet |

### 3.5 Kill criteria for Stage 0

- If the employment contract review says the employer has a credible claim to the product and a written release
  cannot be obtained: **stop** commercial plans for this code base until a lawyer clears a path.
- If the pilot-minimum exit checks are not met by **30 April 2027** (three months after LWD): cut scope again to two
  apps; if still not met by 31 May 2027, stop building platform features and decide between (a) selling
  configuration services on the current product to one customer, or (b) shelving the product.

---

## 4. Stage 1: one design-partner pilot (about Mar to Jun 2027)

### 4.1 Where to look (verified clusters near the founder)

| Cluster | Distance from Bhopal | What we found | Fit |
|---|---|---|---|
| **Govindpura industrial area**, Bhopal | in the city | An industrial estate made up mainly of firms that supply the BHEL plant ([Wikipedia](https://en.wikipedia.org/wiki/Govindpura,_Bhopal)). A **Govindpura Industries Association** holds a GST registration in MP ([KnowYourGST listing](https://www.knowyourgst.com/gst-number-search/govindpura-industries-association-23AAAAI2310J1ZA)), and a **Govindpura Engineering Cluster Foundation** company exists ([company listing](https://qorpiq.com/company/govindpura-engineering-cluster-foundation/U74900MP2012NPL029181); listing seen in search, not opened). An older DC-MSME list puts the **Madhya Pradesh Laghu Udyog Sangh** at a Govindpura address ([DC-MSME association list](https://www.dcmsme.gov.in/all%20associations/small.html); dated list, contacts may be stale). | **Best first target.** Engineering job shops supplying a large buyer have inspection and maintenance pain, and the founder can visit daily. |
| **Mandideep**, Raisen district | about 23 km south | More than 650 industrial units; large names include HEG, P&G, Eicher Tractors, Lupin, TAFE, Godrej ([Wikipedia](https://en.wikipedia.org/wiki/Mandideep)). A DC-MSME district survey exists ([Raisen survey PDF](https://dcmsme.gov.in/dips/SURVEY%20RAISEN.pdf), not opened). The name of a Mandideep industries association is **Unverified**: ask at the industrial area office. | **Good second target:** MSME suppliers to the large plants, within an hour's drive. |
| **Pithampur**, Dhar district (near Indore) | roughly 200+ km (**Estimate**) | Auto cluster SPV formed with the **Pithampur Audyogik Sangathan** as equity partner and the state's Audyogik Kendra Vikas Nigam ([Business Standard, 2008](https://www.business-standard.com/article/sme/mp-pithampur-cluster-complete-108111001037_1.html); old article). Pharma presence listed by [PharmChoices](https://pharmchoices.com/list-of-pharmaceutical-companies-in-pithampur) (not opened). | Larger market, but too far for daily support during the first pilot. Use in Stage 2. |
| **Indore** (Sanwer Road, Palda and other estates) | about 190 km (**Estimate**) | The **Association of Industries of Madhya Pradesh (AIMP)** is Indore-based and active on industrial-area issues such as Palda and Sanwer Road ([Free Press Journal on AIMP elections](https://www.freepressjournal.in/indore/indore-yogesh-mehta-and-tarun-vyas-elected-president-secretary-of-association-of-industries-of-madhya-pradesh); [on Sanwer Road](https://www.freepressjournal.in/amp/indore/indore-industrialists-want-new-route-to-sanwer-road-industrial-area); search results, not opened). | Stage 2. AIMP events are a good place for a 10-minute talk once a pilot result exists. |

Government and other channels:

- **MSME Development Institute, Indore** (Ministry of MSME field office, founded 1954): consultancy, technology
  upgradation, training; it lists an MSME testing station in Bhopal and branches in Gwalior and Rewa
  ([MSME-DI Indore](https://msmeindore.nic.in/about.html)). Ask about upcoming vendor development or technology
  programmes where a short demo slot is possible (**Inference**). Field office list:
  [DC-MSME](https://dcmsme.gov.in/All_MSME_DIs_TCs.aspx).
- **Laghu Udyog Bharati** has an MP presence ([The Hitavada, 2021](https://www.thehitavada.com/Encyc/2021/12/27/Laghu-Udyog-Bharti-delegation-calls-on-Shivraj-Singh-Chouhan.html); not opened). Local unit contacts **Unverified**.
- **Tally partners and CA firms** in Bhopal: they already serve the exact buyer. A referral fee of 10-15% of
  year-one licence (**Estimate**) is cheaper than cold outreach.
- The founder's own network: relatives, college alumni (engineering graduates often work in these plants).

### 4.2 How to find one partner (process)

1. Build a list of 60 units in Govindpura and Mandideep with 20-200 staff (association directory, IndiaMART,
   Google Maps, DC-MSME district reports).
2. Qualify by phone or a visit: do they have (a) a plant head or owner who complains about daily reporting,
   rejects or breakdowns, (b) at least one office PC that stays on, (c) 10+ people who would enter data,
   (d) someone who could be the internal champion.
3. Aim for 20 conversations and 8 site visits in 6 weeks. Show the three apps on a laptop with their own example
   numbers typed in during the meeting.
4. Pick the partner with the strongest pain and an engaged owner, not the biggest name.

### 4.3 Pilot agreement: key terms (outline for the lawyer)

| Term | Proposal |
|---|---|
| Parties | our company (after incorporation) and the manufacturer |
| Scope | three apps (production log + OEE, QC + NCR, maintenance) on one site; up to 25 Full users and 50 Operators |
| Term | 90 days, extendable once by 30 days |
| Fees | licence free during the pilot; setup by us free; customer provides the PC/server, network and a named champion |
| Conversion | price fixed in the agreement now: year one at 50% of list (see section 8) if they continue; no obligation to buy |
| Data | stays on the customer's machine; customer owns all its data; we access it only during support sessions the customer starts and watches; no copies leave the site without written permission |
| Usage metrics | we may collect counts (active users, records per app, errors) from logs, with no business data, shown to the customer first |
| Confidentiality | mutual, survives 3 years |
| Warranty | none: pre-release software "as is"; we will use reasonable efforts to fix blocking bugs within 2 working days |
| Liability | capped at a small fixed amount (for example ₹50,000) except for breach of confidentiality; no indirect losses |
| Backups | nightly backup configured by us; customer keeps one copy off the machine; restore drill in week 1 |
| References | no logo, name or quote used without separate written consent after the pilot |
| IP | we own the product and templates; customer gets a licence to configurations made for it; feedback may be used freely |
| Exit | full data export to Excel/CSV at any time; we uninstall on request |
| Law and venue | Indian law; courts at Bhopal |

### 4.4 Success criteria (agree them in writing at kickoff)

| Measure | Target |
|---|---|
| Install time | under 1 hour (master plan) |
| Daily active users | 10+ on at least 3 apps by week 4 |
| Shift logs entered on time | 90%+ of shifts by week 6 |
| Daily OEE/MIS report | sent every working day without manual work by week 3 |
| Breakdown tickets | 100% of breakdowns logged with acknowledge and close times by week 6 |
| Survivability | 14 consecutive days without the founder on site, no data loss, backups verified |
| Support load | under 4 hours per week of founder time by week 8 |
| Business | owner can state one decision made from the data (for example a machine with hidden downtime) |
| Commercial | owner signs the conversion order (paid year one) by the end of the pilot |

### 4.5 Data to collect

Baseline before install: hours per day spent compiling the daily report; number of paper or Excel forms; owner's
estimate of downtime and rejects; how breakdowns are reported today; PC and network specs; Tally version.

During: weekly active users per app; records per app per day; phone vs desktop entries; median time to fill a
form; errors and crashes (diagnostics bundle); every support request with time spent; feature requests ranked by
the customer; install and update duration; backup sizes; one 20-minute interview with an operator, a supervisor
and the owner in weeks 2 and 8.

Commercial: who decides, who pays, what they compare us with, what price they consider fair, objections heard.

### 4.6 Budget (Estimate, INR)

| Item | Low | High |
|---|---|---|
| Local travel (Bhopal, Mandideep; a few Indore trips) | 10,000 | 40,000 |
| Demo kit: printing, a cheap Android phone for demos | 5,000 | 15,000 |
| Professional indemnity / cyber cover (quote first) | 0 | 50,000 (**Unverified**) |
| Customer hardware if they have none (try to make the customer buy it) | 0 | 50,000 |
| **Total** | **15,000** | **1,55,000** |

### 4.7 Risks

- No partner willing without WhatsApp alerts. Mitigation: add the WhatsApp connector immediately after
  incorporation; show it working before asking a second time.
- Champion leaves or loses interest. Mitigation: owner sponsorship and the weekly 30-minute review.
- Founder becomes the unpaid IT department. Mitigation: support hours logged and capped in the agreement.
- Data loss on a shared office PC. Mitigation: nightly backup plus an off-machine copy plus restore drill.

### 4.8 Kill criteria for Stage 1

- **No partner after 8 weeks**, 20 qualified conversations and 8 visits: the manufacturing wedge as pitched is not
  working. Stop and run 10 more interviews to find out why before writing more code. If the answer is "ERPNext /
  Zoho / Excel is good enough", consider the second segment from the research (coaching-institute back office) or a
  services-first model.
- **Usage collapses**: fewer than 5 daily active users in week 6, or usage falls by half whenever the founder stops
  visiting. The product does not yet stick; fix adoption before Stage 2.
- **No willingness to pay**: the partner will not sign the conversion order even at 50% of list. One "no" is a
  signal, not a verdict; two "no"s across Stage 1 and the first Stage 2 prospect means the price or the value is
  wrong.

---

## 5. Stage 2: three to five paid pilots (about Jul to Dec 2027)

### 5.1 Entry and exit

Entry: Stage 1 partner converted (or a clear reason recorded); outside security review booked; WhatsApp connector
working; one written result from Stage 1 (with the customer's permission) to show.

Exit: 3+ paying sites on annual licences; support load per site measured and under 4 hours/month after the
first month; install done by someone other than the founder at least once; security review findings fixed.

### 5.2 Owner tasks

- Extend to Indore and Pithampur via AIMP, Pithampur Audyogik Sangathan and Tally partners.
- Paid pilot offer: 90 days at ₹25,000, credited to year one if they convert (section 8).
- Commission the outside security review (master plan requires it before going beyond one company).
- Turn the pilot apps into the installable manufacturing pack with a template install plan.
- Hire or contract one part-time implementation helper (local engineering graduate) and train them.
- Put a simple ticket inbox and a status page in place; write the top-20 support answers.

### 5.3 Budget (Estimate, INR)

| Item | Low | High |
|---|---|---|
| Outside security review / penetration test | 1,50,000 | 5,00,000 (**Unverified**: get 3 quotes) |
| Part-time helper, 6 months | 90,000 | 2,40,000 |
| Travel Bhopal–Indore–Pithampur | 30,000 | 80,000 |
| Insurance (PI + cyber) | 20,000 | 80,000 (**Unverified**) |
| CA retainer, 6 months | 18,000 | 48,000 |
| **Total** | **~3,08,000** | **~9,48,000** |

### 5.4 Risks

Each install is a custom project; templates do not generalise; one bad security finding before the review;
customers want stores/dispatch which need the Tally connector.

### 5.5 Kill criteria

- Fewer than 3 of the first 10 qualified prospects pay for a pilot: the offer is wrong. Stop outreach and rework
  price or scope.
- Paid pilots convert below 50%: the product does not deliver what the demo promises.
- Support above one day per week per site after month two: on-prem support economics do not work at this price;
  either raise prices, move to hosted VPS installs we manage, or stop.

---

## 6. Stage 3: public launch, India (2028 H1 earliest)

Entry: 5+ paying sites, at least one installed and supported without the founder visiting; security review done;
website legal pages, DPDP readiness for our own data (DPDP substantive duties expected from May 2027); refund
policy; payment gateway; reseller agreement.

Owner tasks: public website with prices (no fabricated proof: only customer stories with written consent);
self-serve trial download; partner programme for Tally partners and IT shops; documentation site; webinars in
Hindi and English; a second vertical template only if three customers ask for the same thing.

Budget (Estimate): ₹6-20 lakh for the first 6 months (marketing, partner commissions, one full-time support hire,
content, events).

Risks: support load grows faster than revenue; partners mis-sell; price pressure from ERPNext and Zoho.

Kill criteria: after 12 months of public launch, if annual recurring licence revenue is below ₹15-20 lakh and
falling month on month, stop investing in the platform and either run the business as an implementation services
firm on the product or wind the product down (**Inference**). If 12-month churn exceeds 20% of sites, stop
acquisition and fix retention first.

---

## 7. Stage 4: global (not before 2028 H2)

Entry: 20+ paying Indian sites; security review current; English docs complete; export paperwork (GST LUT, the
new FEMA export declaration process from 1 Oct 2026, see legal file); GDPR processor terms and SCCs ready.

Owner tasks: pick one market with Indian-diaspora SMEs or Indian-run manufacturers (UAE/GCC is a common first
step for Indian SaaS, **Inference**); USD price list; payment by international card or wire; trademark via Madrid.

Budget (Estimate): ₹10-40 lakh in year one (travel, marketing, EU/UK representative if needed, legal review of
foreign terms, tax advice).

Kill criteria: do not start until Stage 3 hits its targets. If the first foreign market produces fewer than 3
customers in 12 months, return the effort to India.

---

## 8. Pricing

### 8.1 Benchmarks (verified on 19 Nov 2026 unless marked)

| Product | Public price | Source |
|---|---|---|
| Zoho Creator | ₹480 / ₹1,200 / ₹1,500 per user per month billed annually (Standard / Professional / Enterprise); ₹720 / ₹1,800 / ₹2,220 billed monthly; GST extra; Standard allows 1 app | [zoho.com/creator/pricing](https://www.zoho.com/creator/pricing.html) (INR shown for India) |
| Microsoft Power Apps Premium | US$20 per user per month (annual), rising to **US$22 from 1 Jan 2027** for new purchases and renewals; no INR price checked | [Microsoft licensing news, 9 Sep 2026](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update) |
| Power Apps per app plan | US$5 per user per app per month; no longer sold to new non-CSP customers since early 2026; CSP still sells it (third-party summary) | [SAMexpert](https://samexpert.com/power-apps-per-app-plan-retired/) (**not official**) |
| Microsoft Power Automate | Premium US$15 per user per month; Process US$150 per bot per month; Hosted Process US$215 (annual) | [Microsoft Power Automate pricing](https://www.microsoft.com/en-us/power-platform/products/power-automate/pricing) |
| Odoo | Standard US$31.10 / Custom US$46.70 per user per month (lower figure, with a 12-month discount note); Studio only on Custom; India: about ₹580-725 (Standard) and ₹1,080-1,350 (Custom) per user per month billed yearly | [odoo.com/pricing](https://odoo.com/pricing) (USD only); INR from [oec.sh, Oct 2026](https://oec.sh/odoo-pricing/india) (**third-party**) |
| ERPNext on Frappe Cloud | Sites from ₹410/month (US$5); servers from ₹3,600/month (US$40); no per-user fee mentioned | [frappe.io/cloud/pricing](https://frappe.io/cloud/pricing); [Frappe pricing docs](https://docs.frappe.io/customer-guide/pricing/frappe-cloud-pricing) |
| TallyPrime | Silver ₹22,500 + GST one-time (single user), Gold ₹67,500 + GST (multi-user LAN); rental ₹750 / ₹2,250 per month; TSS renewal ₹4,500 / ₹13,500 per year + GST | [Tally Solutions, 13 Jul 2026](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/) |

What a 25-user and a 50-user site would pay per year (list prices, GST extra; USD at an **assumed ₹88/US$**):

| | 25 users | 50 users |
|---|---|---|
| Zoho Creator Professional (₹1,200) | ₹3.6 lakh | ₹7.2 lakh |
| Power Apps Premium (US$22 from Jan 2027) | about ₹5.8 lakh | about ₹11.6 lakh |
| Odoo Custom India (₹1,080-1,350, third-party) | ₹3.2-4.1 lakh | ₹6.5-8.1 lakh |
| ERPNext on Frappe Cloud (hosting only) | ₹5,000-43,000+ | same (compute-based) |
| Tally Gold (accounting, not an app platform) | ₹67,500 once + ₹13,500/yr | same |

Reading: per-user platforms cost ₹3-6 lakh a year for 25 users. A small manufacturer's mental anchor is Tally
(tens of thousands of rupees) and Excel (free). Per-user pricing also punishes shop-floor headcount (manufacturing
research section 7). Our price has to sit far below Zoho and Microsoft and close to "Tally plus a bit".

### 8.2 Three model options

**Option A: annual site licence by Full-user band, cheap Operator packs** (matches the master plan's licence design)

| Band | Price per site per year (Estimate) | Includes |
|---|---|---|
| Up to 25 Full users | ₹60,000 | 50 Operator passes, updates, standard support, manufacturing pack |
| Up to 50 Full users | ₹96,000 | 100 Operator passes |
| Up to 100 Full users | ₹1,80,000 | 200 Operator passes |
| Extra Operator pack (25) | ₹12,000 | |
| Extra site (same company) | 60% of band price | |

Pros: predictable, simple, 6x below Zoho for 25 users, fits the signed licence file. Cons: small numbers per sale;
recurring revenue needs renewals, which on-prem customers sometimes skip; soft enforcement (read-only after grace)
must be clear in the EULA.

**Option B: perpetual licence plus annual maintenance (Tally-style)**

| Band | One-time (Estimate) | Annual maintenance from year 2 |
|---|---|---|
| 25 Full users | ₹1,50,000 | 20% (₹30,000) |
| 50 Full users | ₹2,50,000 | 20% (₹50,000) |
| 100 Full users | ₹4,50,000 | 20% (₹90,000) |

Pros: Indian SME owners are used to one-time purchase (Tally); cash up front helps a bootstrapped founder.
Cons: lumpy revenue; maintenance renewals are often skipped after year two (**Inference**); perpetual rights to
old versions create a long support tail for a one-person company.

**Option C: plant solution subscription (outcome bundle)**

| Item | Price (Estimate) |
|---|---|
| Plant subscription: platform + manufacturing pack + standard support, up to 25 Full + 50 Operators | ₹6,000 per month, billed yearly (₹72,000) |
| Each extra plant | ₹4,000 per month |
| Setup (fixed price) | ₹50,000-1,50,000 depending on templates and data import |

Pros: sells an outcome (OEE, inspections, maintenance) instead of a platform; the setup fee pays for the founder's
time. Cons: implies we own the templates' fitness for purpose; harder to sell later to non-manufacturers.

### 8.3 Recommendation

Publish **Option A** as the list price, and sell it to manufacturers in the **Option C wrapper** (site licence plus
fixed-price setup). Reasons: it uses the licence mechanics already decided (signed licence file, bands, passes);
₹60,000 per year is roughly 10% of what Power Apps Premium would cost the same 25 users (about ₹5.8 lakh) and below Zoho Creator
Standard for 25 users (₹1.44 lakh, one app only); and the setup fee captures the real value delivered in year one.
Keep Option B in reserve for an owner who insists on a one-time purchase, at the prices above (never below 2.5x
the annual price).

For pilots:

| | Stage 1 design partner | Stage 2 paid pilots |
|---|---|---|
| Licence during pilot | free, 90 days | ₹25,000 for 90 days, credited to year one |
| Setup | free | free (credited) or ₹25,000 for extra templates |
| Year one if converted | 50% of list (₹30,000 for the 25 band) | list price minus the pilot fee |
| Why | no references, no security review, pre-release; the partner pays in time and data | a paid pilot tests real willingness to pay; credit removes the risk for the buyer |

Price validation: ask every Stage 1 and 2 prospect the same four questions (too cheap to trust / good value /
expensive but OK / too expensive) at the ₹60,000 point and record answers in the pilot log.

### 8.4 Implementation, AMC and support pricing (Estimate)

| Service | Price |
|---|---|
| Quick start: install, backups, one template, one training day | ₹40,000-60,000 fixed |
| Plant pack: three templates configured, masters imported from Excel/Tally export, two training days, 30-day hypercare | ₹1,00,000-1,50,000 fixed |
| Custom app or report | ₹25,000-1,00,000 per app, quoted after a free scoping call |
| Day rate (on-site or remote) | ₹8,000-12,000 per day |
| On-site visit for support | ₹5,000-8,000 per visit plus travel outside the city |
| AMC on custom work | 15-20% of the implementation fee per year |
| Standard support (in the licence) | email/ticket, next-business-day response, updates |
| Priority support | ₹24,000-36,000 per site per year: 4 business-hour response, phone/WhatsApp, quarterly health check |

Never promise 24x7 or response times one person cannot keep.

### 8.5 What is free

- In the pilot: licence, setup and training, as in 8.3.
- Always: data export, the documentation, security fixes for the supported version, read-only access after licence
  expiry (soft enforcement as decided in the master plan).
- Possibly later (decide in Stage 3): a free single-maker edition for up to 3 users, for learning only.

---

## 9. The name problem

"Appbuilder" is a working name (master plan section 10). A coined name is needed before the company is
incorporated, because the company name, trademark, domain and installer branding should match.

### 9.1 Criteria

1. Coined (invented) word: strongest trademark protection; descriptive words like "AppBuilder", "FlowForm" or
   "SmartFactory" are weak or refused as descriptive (**Inference** from general trade mark practice; lawyer to
   confirm).
2. Two or three syllables; spelled the way it sounds in both Hindi and English; no letters that Indian speakers
   read two ways.
3. No unfortunate meaning in Hindi, Marathi, Gujarati, Tamil, Telugu, Bengali, English, Arabic (check with native
   speakers).
4. Not similar to Power, Zoho, Frappe, Tally, Odoo, Budibase, NocoBase, Appsmith, ToolJet or Microsoft marks.
5. .com available (or at least .in plus .app), and the same handle on LinkedIn, YouTube, X, Instagram.
6. No identical or similar live mark in classes 9 (software) and 42 (SaaS, software design) in India; later
   EUIPO, UKIPO, USPTO and WIPO for the global stage.
7. Can be a company name on MCA (not identical or too similar to an existing company, LLP or registered mark;
   **Inference**: the MCA name check and Companies (Incorporation) Rules apply; lawyer/CS to confirm).

### 9.2 Process

1. Shortlist (below) and native-speaker meaning check: free, 1 week.
2. Trade mark search on the **official IP India public search** (wordmark, phonetic and Vienna code searches) for
   classes 9, 42 and 35: [tmrsearch.ipindia.gov.in/tmrpublicsearch](https://tmrsearch.ipindia.gov.in/tmrpublicsearch/).
   We confirmed the page is reachable on 19 Nov 2026 but it is behind a CAPTCHA, so this step must be done by the
   founder or the lawyer by hand.
3. MCA company-name availability check, then reserve the name through SPICe+ (RUN) at incorporation.
4. Buy the domains (.com, .in, and .app or .co) in the founder's personal name now; transfer to the company later.
5. Lawyer's search opinion (₹5,000-15,000, **Estimate**).
6. File form TM-A in classes 9 and 42 in the company's name right after incorporation and Udyam registration, at
   ₹4,500 per class for a small enterprise or startup instead of ₹9,000 ([S.S. Rana fee table](https://ssrana.in/ip-laws/trademarks-in-india/tm-filing-fees-forms-india/)).
   Filing "proposed to be used" is possible before launch (**Inference**; lawyer to confirm).

### 9.3 Fifteen coined candidates and a first-pass conflict check

**This is not a legal clearance.** Method, 19 Nov 2026: (a) domain registration status from the registries' own
RDAP services (Verisign for .com, NIXI for .in, Google Registry for .app; "free" means the registry returned
"not found", which can still hide premium or reserved names); (b) web search for the exact spelling, with 2-4
names per query, which reduces sensitivity; (c) no trade mark register was searched.

| # | Name | Idea behind it | .com | .in | .app | Web first pass | First-pass view |
|---|---|---|---|---|---|---|---|
| 1 | **Panktio** | *pankti* = row, line (a table product) | free | free | free | no exact hits | strong candidate; check English reading "punk" |
| 2 | **Kaarvia** | *kaar(ya)* = work | free | free | free | no exact hits | strong candidate; easy globally |
| 3 | **Rekhavo** | *rekha* = line | free | free | free | no exact hits (unrelated "Kkhavo" food brand) | good |
| 4 | **Ganakio** | *ganak* = calculator (formula language) | free | free | free | no exact hits | good; check stress ("ga-NAA-kio") |
| 5 | **Rachvo** | *rachna* = creation | free | free | free | no exact hits | good; short |
| 6 | **Karyovo** | *karya* = work | free | free | free | no exact hits | good; close to Kaarvia, pick one |
| 7 | **Kramvo** | *krama* = order, sequence (flows) | free | free | free | no exact hits | fair; consonant cluster hard for some |
| 8 | **Ganakra** | *ganak* + *-ra* | free | free | free | no exact hits | fair |
| 9 | **Rachnex** | *rachna* + "-nex" | free | free | free | no exact hits | fair; "-nex" suffix is crowded in tech names |
| 10 | **Talikra** | *talika* = table, list | free | free | free | near: "Taliara Limited" (UK software firm), "Taliki" | fair; check Taliara in class 42 abroad |
| 11 | **Sankalo** | *sankalan* = compilation | free | free | free | near: "Sangalo" app on the App Store | weaker: phonetic closeness |
| 12 | **Sanchiq** | *sanch(a)* = mould, frame | free | free | free | near: "Santiq International Pvt Ltd" (2026), "SanchiConnect" | weaker: similar Indian company names |
| 13 | **Kalpavo** | *kalpana* = imagination | free | free | free | "Kalpa-" prefix very common (Kalpavriksha brands) | weaker: low distinctiveness |
| 14 | **Yojaq** | *yojana* = plan | free | free | free | no exact hits | weaker: "q" ending read two ways |
| 15 | **Vidhaq** | *vidhi* = method | free | free | free | no exact hits | weaker: same "q" issue |

Shortlist to take to the IP India search: **Panktio, Kaarvia, Rekhavo, Ganakio, Rachvo.** Several plainer
candidates we tried first (Kaarvo, Udyora, Kriyon, Nirmo, Ordiva, Formyra and others) already had registered .com
domains, so we dropped them.

---

## Sources

Product and research inputs: [BRIEF.md](BRIEF.md), [master plan](../plan/master-plan.md),
[manufacturing research](../research/manufacturing.md), [research index](../research/README.md),
`SECURITY.md`, `docs/admin/installation.md`.

Pricing: [Zoho Creator pricing](https://www.zoho.com/creator/pricing.html);
[Zoho Creator plans FAQ](https://help.zoho.com/portal/en/kb/creator/faqs/getting-started/articles/pricingplans);
[Microsoft: Power Apps Premium price update](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update);
[Microsoft Power Automate pricing](https://www.microsoft.com/en-us/power-platform/products/power-automate/pricing);
[SAMexpert on per app retirement](https://samexpert.com/power-apps-per-app-plan-retired/);
[Odoo pricing](https://odoo.com/pricing); [oec.sh Odoo India](https://oec.sh/odoo-pricing/india);
[Frappe Cloud pricing](https://frappe.io/cloud/pricing); [Frappe pricing docs](https://docs.frappe.io/customer-guide/pricing/frappe-cloud-pricing);
[TallyPrime total cost of ownership](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/).

Clusters and associations: [Mandideep](https://en.wikipedia.org/wiki/Mandideep);
[Govindpura](https://en.wikipedia.org/wiki/Govindpura,_Bhopal);
[Govindpura Industries Association GST listing](https://www.knowyourgst.com/gst-number-search/govindpura-industries-association-23AAAAI2310J1ZA);
[Govindpura Engineering Cluster Foundation listing](https://qorpiq.com/company/govindpura-engineering-cluster-foundation/U74900MP2012NPL029181);
[Pithampur auto cluster](https://www.business-standard.com/article/sme/mp-pithampur-cluster-complete-108111001037_1.html);
[PharmChoices Pithampur list](https://pharmchoices.com/list-of-pharmaceutical-companies-in-pithampur);
[AIMP elections](https://www.freepressjournal.in/indore/indore-yogesh-mehta-and-tarun-vyas-elected-president-secretary-of-association-of-industries-of-madhya-pradesh);
[Sanwer Road](https://www.freepressjournal.in/amp/indore/indore-industrialists-want-new-route-to-sanwer-road-industrial-area);
[MSME-DI Indore](https://msmeindore.nic.in/about.html); [DC-MSME field offices](https://dcmsme.gov.in/All_MSME_DIs_TCs.aspx);
[DC-MSME association list](https://www.dcmsme.gov.in/all%20associations/small.html);
[DC-MSME Raisen survey](https://dcmsme.gov.in/dips/SURVEY%20RAISEN.pdf);
[Laghu Udyog Bharti, The Hitavada](https://www.thehitavada.com/Encyc/2021/12/27/Laghu-Udyog-Bharti-delegation-calls-on-Shivraj-Singh-Chouhan.html).

Legal/fees used here: [LegalRaasta entity comparison](https://www.legalraasta.com/blog/pvt-ltd-vs-llp-vs-opc-in-india/);
[S.S. Rana trademark fees](https://ssrana.in/ip-laws/trademarks-in-india/tm-filing-fees-forms-india/);
[IP India public search](https://tmrsearch.ipindia.gov.in/tmrpublicsearch/).

Name check: RDAP bootstrap [IANA](https://data.iana.org/rdap/dns.json); registries rdap.verisign.com,
rdap.nixiregistry.in, pubapi.registry.google (queried 19 Nov 2026);
[Sangalo App Store](https://apps.apple.com/cv/app/sangalo/id1550242573);
[Taliara Limited](https://findmesales.com/uk/TALIARA%20LIMITED/17228820);
[Santiq International](https://qorpiq.com/company/santiq-international-private-limited/U46909TS2026PTC217416);
[SanchiConnect](https://yourstory.com/companies/sanchiconnect).
