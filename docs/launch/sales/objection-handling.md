# Objection handling

Status: working draft, 19 Nov 2026. 42 objections with honest answers and the proof to show.
Rules from [BRIEF.md](../BRIEF.md): no fabricated customers or numbers; planned features are called planned; no
security or compliance guarantees. If an honest answer loses the deal, lose the deal: a customer sold on a false
claim costs you more than the licence is worth (support time, refund, and the word-of-mouth in a small industrial
area).

**Method for every objection:** (1) acknowledge in one sentence; (2) ask one question to find the real worry;
(3) answer with a fact; (4) show proof on screen or in a document; (5) check: "Does that answer it?"

Status labels used below: **Exists** (in BRIEF as built), **In progress** (flows, approvals), **Planned** (not built).

---

## A. "We already have Tally / Excel"

### 1. "Tally does everything for us."
- **Ask:** "What do you track outside Tally today: production, rejects, breakdowns, inspections?"
- **Answer:** Tally is your books, GST and stock ledger, and it should stay that way. Appbuilder is for the work that
  never reaches Tally: shift output, rejects by reason, breakdowns, inspections. We do not replace or write into Tally.
- **Proof:** their own production Excel sheet, which is not in Tally.

### 2. "Excel is free and everyone knows it."
- **Ask:** "How many copies of that sheet exist? Who has the latest one right now?"
- **Answer:** Keep Excel for analysis. The problem is Excel as a multi-user database: copies, overwritten formulas, no
  "who changed this", everyone seeing every column. Appbuilder keeps the Excel-style formulas but adds one copy, row and
  column security, validation and history.
- **Proof:** Demo steps 5, 8 and 12 ([playbook §5](sales-playbook.md#51-version-a-features-that-exist-today-per-brief-and-the-product-docs)):
  validation stops a wrong entry; supervisor sees only his line; audit log shows who changed a row.

### 3. "Our Excel person handles it fine."
- **Ask:** "What happens when he is on leave for two weeks, or leaves?"
- **Answer:** He becomes more valuable, not less: he becomes the in-house maker who builds and changes apps. The
  formulas he knows work in the Studio.
- **Proof:** show a `Filter(...)` formula in the Studio next to the same logic in his sheet.

### 4. "This will create a second set of numbers that won't match Tally." (accounts head)
- **Ask:** "Which numbers are you worried about: stock quantities, values, or sales?"
- **Answer:** Fair worry. Rule for the pilot: financial and stock values stay in Tally only. Appbuilder holds
  operational data (output, rejects, downtime, inspections). Where both touch the same thing (e.g. material issued),
  Tally remains the record and our app is the shop-floor log. A Tally connector is **Planned**, built when a customer
  needs it; until then nothing flows into Tally automatically.
- **Proof:** the pilot scope line "Excluded: Tally integration"; CSV export he can reconcile in Excel.

### 5. "We'll just make a better Excel with Google Sheets."
- **Answer:** Good option for a team of five with no confidential columns. It breaks when you need roles (supervisor vs
  owner), validation that cannot be bypassed, and data on your own machine. Appbuilder can even read Google Sheets as a
  data source (connector exists, **not yet tested against a live Google account**: say so).
- **Proof:** README "Known limits".

---

## B. "ERPNext / Zoho / Odoo is cheaper or free"

### 6. "ERPNext is free."
- **Answer:** True: open source, no licence fee, and it has manufacturing, stock and accounts. If you want a full ERP
  and have someone to implement and maintain it, it is a serious choice and I'd tell you so. People pick us when they
  want one or two apps around their own process, built from their sheets in days, without replacing Tally.
- **Ask:** "Do you want to change your accounting system?" If yes: walk away politely
  ([battlecard](competitive-battlecards.md#erpnext--frappe)).
- **Proof:** total cost comparison: ERPNext implementation partner days + hosting vs our fixed pilot.

### 7. "Zoho Creator is ₹ few hundred per user."
- **Answer:** Zoho Creator's list price is per user per month (US$8 / 20 / 25 on its pricing page; INR is shown
  locally, [Zoho](https://www.zoho.com/creator/pricing.html), checked 19 Nov 2026). It is cloud-hosted, has mobile apps
  today, and is a good product. We are different in two ways: priced per install by size band, so 40 shop-floor users
  don't multiply the bill; and it runs on your own PC with your data in PostgreSQL. If you need mobile apps this month,
  Zoho is ahead of us today.
- **Proof:** a 3-year cost table at their user count using verified numbers only.

### 8. "Odoo has everything and is cheap."
- **Answer:** Odoo's Studio customisation is only on the Custom plan; third-party trackers list India at about ₹1,080
  (promotional, yearly) to ₹1,350 per user per month for Custom ([oec.sh](https://oec.sh/odoo-pricing/india),
  third-party, verified Sept 2026). For a full ERP replacement it competes well; for one shop-floor app beside Tally,
  it is a big project.
- **Proof:** battlecard pricing notes.

### 9. "A local developer will build this for ₹50,000 one-time."
- **Answer:** Maybe. Ask him three things: who changes it when your process changes; who restores it when the PC dies;
  and whether your supervisor can see only his line. With us, your own person changes the app with Excel-style formulas,
  backups and restore are built in, and row/column security is part of the platform.
- **Proof:** backup/restore screens; Test as user.

---

## C. "Microsoft does this"

### 10. "We have Microsoft 365. Power Apps is included."
- **Answer:** Microsoft 365 includes Power Apps with standard connectors. Premium capabilities (premium connectors such
  as SQL Server, Dataverse, on-premises data gateway, custom APIs) need premium licences, and Microsoft says that from
  **February 2027** users without the right licence cannot open such apps
  ([Microsoft Learn, licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/powerapps-licensing-faq)).
  If your app fits in SharePoint lists with standard connectors, use it. I know Power Platform well (I've built on it);
  I'll tell you honestly if it fits.
- **Proof:** the FAQ page; their own list of data sources.

### 11. "Power Apps Premium is only $20."
- **Answer:** $20 per user per month, paid yearly, rising to **$22 from 1 January 2027** for new terms and renewals
  ([Microsoft licensing news, Sept 2026](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update)).
  For 40 users that is $10,560 a year at the new list price before Dataverse capacity add-ons. We price per install.
  Microsoft wins on mobile apps, Teams integration and ecosystem today.
- **Proof:** a calculation at their headcount; Microsoft's own page.

### 12. "Microsoft will be around in 10 years. Will you?"
- See section D. Don't argue; answer with continuity commitments.

### 13. "Our IT vendor says go with Microsoft for security."
- **Answer:** Microsoft has certifications and audits we don't have. If certified cloud security is a must, Microsoft
  is the right choice and I'd say so. If the concern is "data inside our premises" and "who sees what", show our
  model and its limits in writing.
- **Proof:** [security model](../../admin/security-model.md), including the "Not defended" section.

---

## D. "You are one person. What if you disappear?"

### 14. "What if you get a job, fall ill, or shut down?"
This is the most important objection and the most legitimate. Answer with facts, then offer concrete commitments.

**Facts that are true today:**
- Your data is in **standard PostgreSQL** on your own machine. Any PostgreSQL person can read it.
- **Export environment data** gives every table as CSV in one ZIP, plus an attachments list
  ([backup and restore](../../admin/backup-and-restore.md)). Apps and solutions export as YAML packages.
- **Backups** are built in: nightly by default, verified, restorable, optionally encrypted with a passphrase. We drill
  a restore in front of your IT person at go-live.
- **Documentation** for admins exists: installation, backups, upgrades, disaster recovery, operations.
- The software keeps running on your PC whether or not we exist; nothing phones home to work today.

**Continuity commitments the founder can offer (pick a package; costs are Assumptions to confirm):**

| # | Commitment | What it means | Cost to you (estimate) | Offer to |
|---|---|---|---|---|
| 1 | Data-exit guarantee | Contract clause: export is never blocked, even if licence lapses (matches the planned soft enforcement: grace, then read-only, export always works, [master plan §9](../../plan/master-plan.md#9-owner-decisions-18-nov-2026-supersede-the-sections-above-where-they-differ)) | Nil; must be honoured in licence design | Everyone |
| 2 | Perpetual-use fallback | If you stop trading or end the product, you publish a final release and licence file without expiry for existing customers | Nil now; a few hours at the end | Everyone |
| 3 | Restore drill at go-live | Backup copied to a second disk, restored to a test environment, witnessed by their IT person | 2-3 hours per customer | Everyone |
| 4 | End-of-life notice | 6 months' written notice before ending support | Nil | Everyone |
| 5 | Source code escrow | Current source and build instructions deposited with an escrow agent (or a lawyer under a written release agreement); released on defined triggers (insolvency, end of support without successor, no response for 30 days). Customer gets a licence to use and modify for internal use only. | Agent fees: **unverified**, get quotes; lawyer drafting one-time; ~2 hours per deposit update | Customers above a deal size, or charge as an add-on `<ESCROW_FEE>` |
| 6 | Trained backup engineer | Train a local IT vendor or Tally partner to install, back up, restore and upgrade; they hold the runbook | Partner training 1-2 days; retainer `<BACKUP_PARTNER_FEE>` | After first 3 customers |
| 7 | Second-person access | A named second technical person with access to builds, signing keys (under a sealed procedure) and the customer list | Depends on hiring/partner | Mid-term goal |

- **Say:** "I can't promise I'll never be hit by a bus. I can promise you'll never be locked out of your data, and that
  someone else can run your system without me." Then show the export and restore.
- **Don't say:** "We have a team", "we're funded", "we have many customers". None is true.

### 15. "Who will support us if you are busy with other customers?"
- **Answer:** Support terms in writing: channels (phone, email, WhatsApp only if they opted in), business hours,
  response target (e.g. next business day), and what is **not** covered (24×7, uptime SLA). I limit the number of
  pilots I run at once (max 3) so I can keep this.
- **Proof:** the support section of the proposal; diagnostics bundle in Admin console > Server logs
  ([operations](../../admin/operations.md)).

### 16. "Why should we be your first customer?"
- **Answer:** You get the founder's full attention, a price and terms first customers get, and influence on what is
  built next. You take the risk of a young product. The pilot is short, paid and has an exit clause so the risk is
  bounded. If you need a proven vendor with references, I'm not that yet.
- **Proof:** pilot exit clause; the honest status line in the proposal.

### 17. "Give us a reference customer."
- **Answer:** "I don't have one yet; you would be among the first. What I can give: a live demo on your own data, the
  documentation, a short paid pilot with an exit, and my previous project background." Never invent a reference.

---

## E. "Is it secure?"

### 18. "Is it secure?"
- **Ask:** "Secure against what: an employee seeing what they shouldn't, someone from outside, or losing the data?"
- **What we can say (each is documented in the [security model](../../admin/security-model.md), with the evidence
  table):**
  - Table, row and column permissions are enforced by the server on every request, not just hidden in the screen.
  - Passwords hashed with scrypt; sign-in throttling; two-step verification (authenticator app or email codes) that an
    admin can require.
  - Changes are recorded in an audit log (who, when, what).
  - Stored connection passwords are encrypted (AES-256-GCM); backups can be encrypted with a passphrase.
  - The installer can set up HTTPS for the office network.
  - Our own internal security review of the latest phase exists; it is not independent.
- **What we cannot say:**
  - There has been **no outside security review or penetration test**. No ISO 27001, SOC 2 or other certification.
  - Data is **not encrypted at rest** (protect the PC with disk encryption such as BitLocker).
  - The audit log records changes, not reads, and is **not tamper-proof** against someone with database access.
  - It does not protect against someone who controls the PC (Windows admin or malware).
  - Single machine; no high availability.
- **Offer:** "If you want an outside test, you can commission one on your install; we'll fix what it finds and share
  the results with you." (An outside review is planned before the pilot programme goes beyond one company, per
  [master plan §5](../../plan/master-plan.md#5-build-phases).)

### 19. "Is it compliant with GMP / 21 CFR Part 11 / ISO / labour registers?"
- **Answer:** No claim. We have not validated the product for any regulated use, and I won't tell you it is compliant.
  Features like audit trail, roles and two-step sign-in exist, but compliance needs validation by you and your auditors
  and features we don't have (e.g. tamper-proof audit, electronic signature workflows). If the app must be a validated
  GxP record, don't use us for that record.
- **Proof:** the "Explicit limitations" section, shown openly.

### 20. "Will you be able to see our data?"
- **Answer:** Not unless you give me access. It runs on your machine. During the pilot I need admin access to build;
  the agreement says I access data only to deliver the pilot and delete any copies afterwards. You can disable my
  account at any time and see my changes in the audit log.

### 21. "What about DPDP / employee data?"
- **Answer:** Most DPDP Rules obligations apply from about 13 May 2027 (research note, lawyer to confirm). Column
  security can restrict Aadhaar, bank and medical fields to HR. That's a tool, not compliance: your lawyer decides what
  you need. For the pilot, keep sensitive personal data out of scope.

---

## F. "We want mobile"

### 22. "Our people use phones, not PCs."
- **Answer (today):** Phone layouts are on our roadmap (phase P2) and not something I'll sell you today. The pilot is
  designed for entry at a PC by a supervisor or clerk, which is where your paper sheets get typed today anyway. The app
  runs in any modern browser on the office network.
- **Ask:** "Who types the shift sheet today, and where?" Often it's a clerk at a PC: then the pilot still fits.
- **If phone is the only acceptable mode:** disqualify for now; ask permission to come back when it's released and
  tested.
- **Note for the founder:** the Studio already has phone design sizes ([apps guide](../../guide/maker/apps.md#phone-and-tablet-apps));
  until you have tested an app on real Android phones on a plant network, keep saying "planned".

### 23. "Is there an app on the Play Store?"
- **Answer:** No. When phone layouts arrive, they run in the phone's browser on your network. A store app is not on the
  current plan.

### 24. "Will it work offline on the floor?"
- **Answer:** The server runs on your PC and needs no internet. The browser needs the office network (LAN/Wi-Fi) to
  reach it. There's no offline mode on a device that loses Wi-Fi.

---

## G. "AI?"

### 25. "Does it have AI?"
- **Answer:** Not today. AI agents are planned for a later phase (P4), after people know the product by hand. The
  design rule: an agent acts as the user and sees only what that user may see; writes need human approval; you choose
  whether data may go to an AI provider or stays on a local model. None of this exists yet, so don't buy for it.

### 26. "Can AI build the app for us?"
- **Answer:** Not today. What exists: "Start with data" makes a working list-and-form app from a table in one click,
  and the data model designer helps shape tables. I build the first app with you in the pilot.

---

## H. "Our people won't use it"

### 27. "Supervisors won't type into a computer."
- **Ask:** "Who types the paper sheet into Excel today?" Someone already does: make that person the first user.
- **Answer:** Adoption is the pilot's main risk, which is why the success criteria measure usage, not features. We
  design the entry screen with the user, not for him, and remove one task for every task we add (e.g. no more emailing
  the sheet).
- **Proof:** the success criteria in the proposal; simulation [h](simulations.md#h-a-pilot-that-goes-badly-in-week-2-adoption-problem).

### 28. "We tried software before; nobody used it."
- **Ask:** "What exactly happened?" Usually: too many screens, nobody owned it, owner stopped looking at it.
- **Answer:** One app, one champion, one report the owner reads every morning. If the owner stops looking, the users
  stop entering. That's why the 8 am report goes to you.

### 29. "Our staff are not computer literate / need Hindi."
- **Answer:** The entry screens are yours to design: your column names, Hindi labels where you want them, large fields,
  choices instead of typing. Full Hindi interface translation of the platform itself: don't promise; check the current
  language settings before saying anything.

---

## I. "Who supports us?" / implementation

### 30. "Who will train our people?"
- **Answer:** Two 45-minute sessions in the pilot, at the plant, plus a one-page guide per app written for your users.

### 31. "Who changes the app when our process changes?"
- **Answer:** Small changes: your champion, after a maker session (Excel-style formulas). Bigger changes: a fixed change
  bucket of hours or my day rate, quoted in advance.

---

## J. Price

### 32. "Too expensive."
- **Ask:** "Compared to what?" (Excel, a local developer, Zoho, doing nothing.)
- **Answer:** Go back to their ROI sheet: "On your numbers, with half the benefit discounted, payback is X months.
  Which number do you disagree with?" Then trade, don't discount
  ([negotiation guardrails](sales-playbook.md#11-negotiation-guidance)).

### 33. "Why should we pay for a pilot?"
- **Answer:** Because it makes both of us take it seriously, and it's credited fully if you continue. A free trial in a
  busy plant gets no champion and no time.

### 34. "Give it free for six months and we'll pay if it works."
- **Answer:** No. Offer a smaller pilot scope at a smaller fee.

### 35. "Yearly fee? Tally was one-time."
- **Answer:** Tally also has yearly TSS renewal for updates (Silver ₹4,500, Gold ₹13,500 a year + GST per
  [Tally, July 2026](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/)). Our yearly
  licence includes updates and support. (If the launch plan chooses a perpetual + yearly updates model, adjust this
  answer.)

---

## K. Data ownership

### 36. "Who owns the data and the apps?"
- **Answer:** Your data is yours, always, and stays on your machine. Apps built from your sheets: state ownership in the
  agreement (recommended: you own the app definitions; we own the platform).

### 37. "Can we get our data out if we stop?"
- **Answer:** Yes: export environment data (CSV ZIP), PostgreSQL backups, and YAML app packages. We show it in the demo.

---

## L. On-prem hardware and outages

### 38. "We don't have a server."
- **Answer:** A Windows 10/11 PC with 4 GB RAM minimum (8 GB recommended) and 3 GB free disk works; it runs as a Windows
  service and starts with the PC ([getting started](../../guide/getting-started.md#what-you-need)). Or a Linux VPS.
  Honest note: our Windows installer has been tested on Linux systems end to end but **not yet run on a customer
  Windows machine**; for your pilot I'll install it myself and stay until it's running.

### 39. "Our internet goes down every day."
- **Answer:** Good fit: installed on your LAN, it needs no internet to work. Only email reports and password-reset emails
  need internet; they go out when the connection returns (confirm behaviour before promising queued sending).

### 40. "Power cuts?"
- **Answer:** Put the PC on a UPS (you already do for Tally). It restarts as a service when the PC starts. Nightly
  backups plus a copy on a second disk cover the bad day.

---

## M. Customisation and integration

### 41. "Can you add <feature> for us?"
- **Answer:** If the platform can do it with configuration (tables, formulas, roles, reports): yes, in the fixed scope
  or a change bucket. If it needs a new platform feature: it goes on the roadmap list, no date promised. Never build a
  one-customer fork.

### 42. "Will it connect to Tally / biometric / our machines?"

| Integration | Today | Planned | Workaround now |
|---|---|---|---|
| Tally | No connector | Optional Tally connector, built when a customer needs it ([master plan §10](../../plan/master-plan.md#10-owner-decisions-18-nov-2026-later)) | Export masters/vouchers from Tally to Excel/CSV, import into Appbuilder; re-key what must go into Tally |
| Biometric attendance (eSSL/ZKTeco class) | No connector | Not scheduled | Import the device's CSV export (Data files / Import CSV) |
| Machines / PLC (OPC UA, MQTT) | No | Not planned; partner with IoT vendors | Manual downtime log; later accept data from an IoT vendor's API |
| Other systems by HTTP API | Connector actions, webhooks in and the email connector are in the unreleased P1 work (changelog) | Release in P1 | Treat as **In progress**; don't sell |
| WhatsApp | No | Planned (P2) | Scheduled email reports (exist) |
| PostgreSQL / MySQL databases, Google Sheets, CSV/Excel/JSON files | Connectors exist (Google Sheets untested on a live account) | | |
