# Sales simulations

Status: working draft, 19 Nov 2026. **Every person and company below is a fictional persona** written to rehearse
conversations. None is a real customer, prospect or partner; no numbers in the dialogues are research data.
All simulations are set **after** the founder's notice period has ended and selling is lawyer-confirmed as allowed
(see [README.md](README.md#the-employment-constraint)). Product facts follow [BRIEF.md](../BRIEF.md): flows and approvals
in progress; phone layouts, PDF, dashboards, WhatsApp, Tally connector, AI planned.

Format: dialogue, with `[Note: ...]` annotations on technique. After each: what went right or wrong, the next best
action, and the product gap that decided it. A ranked gap table closes the file.

F = Founder.

---

## a) Owner of a 45-person auto-components job shop in Pithampur

**Persona:** Rajesh (fictional), 52, owns a CNC turning and VMC job shop supplying two tier-1 auto suppliers. Tally
Silver run by an accountant. Production in a big Excel workbook kept by the supervisor. His nephew Aman, 24, "does the
computers". Very price-sensitive. Met via a CA's introduction.

**Setting:** second meeting, after a plant walk. F built a demo from the supervisor's "Daily Production" sheet.

> **Rajesh:** Okay, I saw. It's nice. Now tell me the price straight. No PowerPoint.
>
> **F:** Straight answer: a six-week pilot for this one app is `<PILOT_FEE>` plus GST. If you continue, the full fee is
> credited to the first-year licence, which for your size band is `<PRICE_BAND_50>`. Before you decide whether that's
> high, can we check it against your own numbers from last week?
>
> `[Note: price given the moment it was asked, in one breath, then anchored to his numbers. Dodging price with a small
> owner reads as "expensive and hiding it".]`
>
> **Rajesh:** Numbers, numbers. Aman can make this in Excel only.
>
> **Aman:** Actually I was thinking of making it in Google Sheets with a form.
>
> **F:** That can work, Aman. Can I ask you two things? When the supervisor of Line 2 opens the sheet, does he see the
> rates column?
>
> **Aman:** ...Yes. We can hide it.
>
> **F:** Hide it in the sheet, or so he can't get it at all? And second: if someone deletes last week's rows by mistake,
> how do you get them back and know who did it?
>
> **Aman:** Version history, maybe.
>
> **F:** Fair. Here, I'll show you what the supervisor's login sees. *(opens Test as user)* No rates column, only Line 2
> rows, and this is the server refusing it, not a hidden column. And here's the audit log for the row I changed in the
> demo.
>
> `[Note: the nephew is the blocker and the potential champion. Respect his idea, ask questions that let him find the
> limits himself, never mock the spreadsheet.]`
>
> **Rajesh:** Fine, but my supervisors are on the machines. They all have phones. Can they enter from phone?
>
> **F:** Not today, and I won't pretend. Phone screens are on my roadmap. In this pilot, whoever types the paper sheets
> today types them here instead, at the office PC. Who does that now?
>
> **Rajesh:** Pooja in the office, in the evening.
>
> **F:** Then Pooja is the first user, and the change for her is: she types once, and you get the 8 am report without
> her making it. Last week you said she spends about two hours a day on it.
>
> `[Note: honest "no" on the gap, then reframe the pilot around who actually does the work today.]`
>
> **Rajesh:** What if you vanish? You are one person.
>
> **F:** Correct, I am one person. Three things. Your data sits in a normal PostgreSQL database on your PC; Aman can
> export every table to CSV any day; I'll show him. Second, I'll set up nightly backup to a second disk and we restore
> it together on day one. Third, it's in the agreement that export is never blocked even if you stop paying.
>
> **Rajesh:** Hmm. Pilot fee is too much. Do it free, if it works we'll pay.
>
> **F:** I don't do free pilots, because then nobody here has time for it, and it fails. What I can do: a smaller scope.
> Only the production log for the two CNC lines, three users, four weeks, at `<PILOT_FEE_SMALL>`. Same credit if you
> continue.
>
> `[Note: trade scope, never price to zero. Guardrail from the playbook.]`
>
> **Rajesh:** And if I take full scope, what discount?
>
> **F:** If you introduce me to two other owners in Pithampur after the pilot, and let me make Aman the admin so he can
> look after it, I'll keep the full scope at the small price.
>
> **Rajesh:** *(to Aman)* You'll handle? *(Aman nods)* Okay. Send me the paper. Half now?
>
> **F:** Half now, half at week three. I'll send the agreement tonight; Aman, I'll need the PC details by Thursday.

**Outcome:** won, paid pilot (full scope at reduced price, traded for two introductions and an in-house admin).

**What went right:** price answered immediately; nephew converted from blocker to admin; the "Pooja types it" reframe
kept the pilot inside today's product; continuity answered with facts.
**What went wrong:** the discount was given before the ROI sheet was finished, so the value anchor is weaker for the
licence conversation in week 6.
**Next best action:** confirm the PC spec and run the Windows installer on a test PC of the same Windows version
before install day. Fill the ROI sheet with Rajesh at the week-0 review.
**Gap that decided it:** **phone layout** (nearly lost it; reframed). Continuity was the second hurdle.

---

## b) Plant head of a 150-person pharma packaging unit worried about audits and data integrity

**Persona:** Dr. Meenakshi (fictional), plant head of a contract packaging unit (blister and bottle lines) near
Mandideep. Customer audits by pharma brand owners several times a year. QA uses paper batch packaging records and a
validated system for some records.

> **Meenakshi:** Before you show anything: is your system 21 CFR Part 11 compliant? Our customers audit data integrity.
> ALCOA plus, audit trails, e-signatures.
>
> **F:** No. I won't claim Part 11 or GMP compliance. The product hasn't been validated for regulated use, there has
> been no outside audit, and some things your auditors expect aren't there: for example, our audit log records changes
> but not reads, and it isn't tamper-proof against someone with database access. There's no electronic signature
> workflow.
>
> `[Note: the first answer decides credibility. Any "mostly yes" here would be discovered in the first customer audit
> and end the relationship, possibly with liability.]`
>
> **Meenakshi:** Then why are we talking?
>
> **F:** Fair question. Because in our first call you said two things that aren't GMP records: the maintenance history
> of the blister machines lives in an engineer's Excel, and your daily line efficiency report takes your planning
> person half a morning. Neither goes into a batch record. That's where I might help. If it has to be a GxP record,
> I'm the wrong tool.
>
> **Meenakshi:** Maintenance records are seen in audits too. Preventive maintenance compliance.
>
> **F:** Then we need your QA head to decide whether a maintenance log in a non-validated system is acceptable as a
> working tool with the official record elsewhere, or not at all. I'd rather you say no now than in an audit.
>
> `[Note: route the regulatory decision to the customer's QA, in writing. Do not decide compliance for them.]`
>
> **Meenakshi:** *(calls QA head, Sanjay)* Sanjay says: working tool is fine if the official PM record stays in the
> current system and our SOP says so. But he wants change history and access control.
>
> **F:** Those exist: who changed what and when, and roles so technicians edit their own tickets while engineers see
> all. Let me show you on the maintenance sheet you sent. *(demo: validation rule on closed tickets, Test as user,
> audit log)*
>
> **Meenakshi:** Okay. And escalation? If a breakdown isn't attended in 30 minutes, the shift in-charge must know.
>
> **F:** Not today. Escalations need our flow engine, which is in progress, and alerts on WhatsApp are planned later.
> Today I can send a scheduled email report, for example every two hours, of open breakdowns older than 30 minutes.
> That's a workaround, not an escalation.
>
> **Meenakshi:** Email every two hours nobody will read.
>
> **F:** Agreed, probably not on the floor. For the planning report it works: one email at 8 am.
>
> **Meenakshi:** Fine. Send a proposal for the efficiency report only. And put in writing what you just said about
> compliance.
>
> **F:** I will: a "not validated for GxP use" line in the proposal and the agreement.

**Outcome:** narrowed. No to QA/batch records; small proposal for the daily line efficiency report; maintenance log
deferred until escalations exist.

**What went right:** the compliance answer was immediate, specific and honest; the founder used her own words from
discovery to find a non-GxP use; QA was pulled in early.
**What went wrong:** the founder demoed maintenance before confirming it was in scope; ten minutes of demo spent on a
use case that was then deferred.
**Next best action:** proposal within 48 h with the non-validated statement; ask Sanjay for the SOP wording he needs.
**Gap that decided it:** **validated-compliance features** (not on the roadmap) and **flows/escalations** (P1) +
**WhatsApp** (P2). Also **outside security review** (planned before broad pilots).

---

## c) Accounts head defending Tally

**Persona:** Mr. Khare (fictional), 58, accounts head of a 90-person fabrication firm for 22 years. Runs Tally Gold with
three users. The owner wants a stores and dispatch app; Khare was asked to "see it".

> **Khare:** I'll tell you frankly. Every two years someone comes with software. Then at year end my stock doesn't
> match. Tally is the books. I don't want a second stock.
>
> **F:** I agree with you, and I'd like to make that a rule of the project: Tally stays the only stock and money record.
> Can I ask what didn't match last time?
>
> `[Note: agree with the principle first. He's defending audit-proof books, which is his job, not "resisting change".]`
>
> **Khare:** Issue slips. Stores issued material in the software, but in Tally we entered at month end from the register.
> Quantities differed, rates differed. My CA asked which is right. I had no answer.
>
> **F:** That's exactly what I'd avoid. So, two options. One: we don't touch stores at all, and do dispatch planning
> only: which order goes today, packing status, vehicle, LR number. No quantities that land in Tally. Two: if stores is
> needed, the app is the floor-side log, and the Tally entry stays as it is today. I don't have a Tally connector; it's
> planned, and I won't sell you an automatic link that doesn't exist.
>
> **Khare:** So we type twice in option two.
>
> **F:** In option two, yes, the same as today: the register is replaced by the app, and Tally entry continues. The
> gain is that the register is searchable and the plant head gets a daily report. If that's not worth it, choose
> option one.
>
> `[Note: name the downside yourself. He'll trust option one more because you named option two's cost.]`
>
> **Khare:** Hm. Who sees rates in your app?
>
> **F:** Nobody, if you say so. Column security: rates only for accounts and the owner. Let me show you. *(Test as
> user: dispatch clerk sees no rate column.)* And you can export everything to CSV whenever you want to cross-check.
>
> **Khare:** And GST? E-way bill?
>
> **F:** Stays in Tally or your GSP. The dispatch app can store the e-way bill number as a reference, nothing more.
>
> **Khare:** And my CA? He'll ask why the company is paying for this.
>
> **F:** Then let me give him a one-page note: what the app holds (dispatch plan, packing status, vehicle and LR number),
> what it doesn't hold (no ledger, no stock value, no tax), and that the invoice from us is a normal GST invoice for a
> software licence. If he has questions, I'm happy to take a call with him.
>
> `[Note: the CA is an invisible committee member. Arm the accounts head so he can answer the CA himself.]`
>
> **Khare:** *(pause)* Option one I don't mind. Tell the owner I said dispatch first. Stores later, when you have the
> Tally link.
>
> **F:** Thank you. Can I put that in the proposal as "recommended by accounts"? And when the Tally link exists, will
> you be the person who tests it?
>
> **Khare:** If it exists. I've heard "next version" before.
>
> **F:** Fair. I'll only call you when it's released and tested.

**Outcome:** blocker turned into a conditional supporter; pilot scope changed to dispatch planning.

**What went right:** agreed on Tally as the record; asked for the past failure; offered two options with honest costs;
gave him a future role.
**What went wrong:** nothing major; risk is that the owner wanted stores and may see dispatch as a smaller win.
**Next best action:** joint 15-minute call with owner and Khare to confirm dispatch-first scope; ROI on dispatch delays.
**Gap that decided it:** **Tally connector** (planned, optional). It moved the scope, not the deal.

---

## d) A Tally partner evaluating reselling

**Persona:** Vikas (fictional), runs a 12-person Tally partner firm in Indore: licence sales, implementation, AMCs,
some TDL customisation. About 300 active clients (his estimate).

> **Vikas:** My clients ask for production modules. I tell them TDL can do some. What exactly is your product?
>
> **F:** A platform to build business apps from their Excel sheets, running on their own PC, next to Tally. Production
> logs, quality, maintenance, dispatch planning. It doesn't do accounting and doesn't touch Tally.
>
> **Vikas:** Doesn't touch Tally? Then my clients double-enter. Every second software in India has Tally integration.
>
> **F:** True, and I don't have it yet. It's planned as an optional connector, built when a customer needs it. Today
> the apps cover what never reaches Tally: rejects, downtime, inspections, breakdowns.
>
> `[Note: the integration question will come up with every partner. The honest answer narrows your pitch to non-Tally
> data, which is also where you don't compete with him.]`
>
> **Vikas:** What margin?
>
> **F:** Two models. Referral: you introduce, attend the first meeting, and get `<REFERRAL_PCT>` % of the first-year
> licence after the customer pays. Reseller: you buy at `<PARTNER_DISCOUNT>` % off and invoice the client, and do
> first-line support after training. I'd suggest referral until you've seen two installs succeed.
>
> **Vikas:** Reseller is where the money is. But tell me, who supports when you're busy? My clients call me, not you.
>
> **F:** That's why I'd start with referral. I'm one person. I'll take at most three pilots at a time. If your client
> calls you, I owe you a response the next business day, in writing in our agreement.
>
> **Vikas:** One person. Hmm. If you close, my client is stuck, and my name is spoiled.
>
> **F:** Your concern is fair. What I can commit: the client's data in standard PostgreSQL with CSV export, nightly
> backups we test, and I'll train one of your engineers to install, back up and restore. If I ever stop, you can run
> existing installs. I'm also looking at source escrow for customers who want it.
>
> `[Note: the partner is also the continuity answer. Training his engineer de-risks both of you.]`
>
> **Vikas:** What does the client pay overall? My clients compare everything with Tally's price.
>
> **F:** For a 50-user plant, the first year is licence `<PRICE_BAND_50>` plus a fixed setup fee. I'll never quote your
> client a different price than I'd quote directly, so you're not undercut. And I won't sell Tally licences, AMCs or
> TDL work to your clients, ever; that goes in the referral agreement.
>
> `[Note: channel conflict is the partner's silent fear. Put the non-compete on his core business in writing.]`
>
> **Vikas:** Can I white-label it? "Vikas Production Suite"?
>
> **F:** Not now. Maybe after we have a few customers together.
>
> **Vikas:** Okay. Referral. I'll give two clients who are crying about Excel. If those two are happy, we talk reseller.
> And make the Tally link. Without it I can't push it hard.
>
> **F:** Understood. I'll send the referral terms this week. Who are the two, and can we visit both on the same day?

**Outcome:** referral agreement, two introductions; reseller deferred.

**What went right:** started with the low-commitment model; honest about support capacity; offered to train his
engineer as a continuity hedge.
**What went wrong:** the founder didn't ask how Vikas's AMC clients currently pay for customisation; a missed chance to
price services through him.
**Next best action:** referral terms (lawyer-reviewed one-pager) in 5 days; book both visits on one Indore day.
**Gap that decided it:** **Tally connector** (limits how hard partners push); **one-person continuity**.

---

## e) Coaching institute owner (back-office use)

**Persona:** Sunita (fictional), runs a JEE/NEET coaching institute in Bhopal with two branches, ~900 students, 35
staff. Uses a branded app for content, Excel for leads, batches and fee instalments, and WhatsApp for parents.

> **Sunita:** My problem is fees. Instalments, reminders, who has paid. My accountant spends three days a month
> calling parents.
>
> **F:** Can you show me the sheet? *(it has instalment columns per student, a "paid" tick, remarks)* Who sees this?
>
> **Sunita:** Me, accountant, and both branch heads. Branch heads should only see their branch, but I can't control
> that in Excel.
>
> **F:** That I can do today: branch heads see only their branch, concession columns only for you. Formula columns for
> dues, a daily email to the accountant of who is due this week. *(demo from her sheet: row rules by branch, Test as
> user, scheduled report)*
>
> `[Note: show the strong part first, built on her data. Row and column security is a real strength here.]`
>
> **Sunita:** Nice. Now the reminders. Automatic WhatsApp to parents three days before, with a payment link. And the
> receipt PDF.
>
> **F:** None of those three exist today. Automatic reminders need our flow engine, which is in progress; WhatsApp and
> PDF are planned for a later phase; a payment gateway link isn't on the plan yet.
>
> **Sunita:** Then what's left? The accountant still calls.
>
> **F:** Honestly, the calls stay. What changes: the list is right, branch heads can't see each other's data, and
> concessions are controlled. That might not be worth paying for, for you.
>
> `[Note: the founder names the weak value case rather than overselling. This loses the deal and keeps the reputation.]`
>
> **Sunita:** Can't you just make the accountant's call list better? Sorted by who pays late usually?
>
> **F:** That I can do: a formula column for days overdue, a column for how many times each family paid late before,
> and the daily email sorted by that. It shortens the calls, it doesn't remove them. Would that save the accountant a
> day a month?
>
> **Sunita:** Maybe half a day. That's not why I'd buy software.
>
> `[Note: test the smallest version of value before giving up. Here it's honestly too small; accept it.]`
>
> **Sunita:** The app company I use for content offers a fee module with reminders. I was hoping yours was cheaper.
>
> **F:** If their fee module does reminders and payment links today, it's probably the better choice for fees. Where I
> might help later is the enquiry pipeline for admissions season, with counsellor follow-ups. Can I come back in a few
> months when reminders and WhatsApp are released?
>
> **Sunita:** Come back. Admission season starts in March; if you have it by January, call me.
>
> **F:** I can't promise January. I'll call when it's released and tested, whatever the month. And one suggestion,
> free: whichever fee module you choose, ask them whether branch heads can be limited to their own branch's students.
> That was the one thing your Excel couldn't do.
>
> `[Note: leave with a useful question that favours your strength in her next evaluation.]`

**Outcome:** lost (nurture). She'll evaluate the existing vendor's fee module.

**What went right:** demo built on her data showed the genuine strength (branch-level security); no false promise on
dates.
**What went wrong:** the founder should have qualified in discovery: "fees with automatic reminders" was the stated need
and is a disqualifier today ([playbook §1.3](sales-playbook.md#13-disqualifiers-walk-away-early)). Two hours of demo prep
lost.
**Next best action:** nurture; one note in March with whatever has shipped.
**Gap that decided it:** **flows (reminders)** P1, **WhatsApp** P2, **PDF** P2, **payment gateway** (not planned).

---

## f) IT manager comparing with Power Apps licences they already own

**Persona:** Arvind (fictional), IT manager of a 200-person engineering firm. Microsoft 365 for everyone; three
Power Apps Premium licences for an existing app. Asked by the COO to compare.

> **Arvind:** We have Microsoft 365 for all 200. Power Apps is included. Why would I add a second platform?
>
> **F:** You might not. What's the app?
>
> **Arvind:** Gate pass and visitor log. Security guard enters at the gate, HR sees reports, approvals by department
> heads.
>
> **F:** Where would the data live?
>
> **Arvind:** SharePoint list.
>
> **F:** Then, honestly, Power Apps with SharePoint and standard connectors under your Microsoft 365 licences is likely
> the better fit: approvals through Power Automate, a phone app for the guard, Teams notifications. You have all of it.
> I've worked on Power Platform; that's a good use of it.
>
> `[Note: the founder's Power Platform background makes this answer credible. Recommending a competitor where it fits is
> how you earn the next conversation.]`
>
> **Arvind:** Then when would yours be better?
>
> **F:** Three cases. One: when the app needs premium features: Dataverse, a SQL Server connector, the on-premises data
> gateway. Then each user needs a premium licence, at $20 a month list today and $22 from 1 January 2027 for new terms
> and renewals. Microsoft also says users without the right licence can't open such apps from February 2027. Two: when
> data must stay on your own server, not in the cloud. Three: when many shop-floor users need occasional access and
> per-user pricing gets heavy.
>
> **Arvind:** Our production planning app: 60 users, on SQL Server on-prem. We priced it on Power Apps Premium. COO
> didn't approve.
>
> **F:** That's a different conversation. Can I see what it needs? *(lists: planning grid, approvals, phone entry for
> supervisors, PDF job cards)*
>
> **F:** Planning grid on desktop: yes, today. Approvals: in progress. Phone entry and PDF job cards: planned, not built.
> So for this app, today I'd be a partial answer.
>
> **Arvind:** And security? Microsoft has audits, certifications.
>
> **F:** We have none. No outside audit yet. I can show you our security model document, including what isn't defended.
>
> **Arvind:** And where would yours run? We have a Windows Server in the rack, Hyper-V.
>
> **F:** A Windows Server 2016 or newer VM, or a Linux VM, with HTTPS for your network from the installer. Honest
> detail: the Linux installer has been run end to end; the Windows one hasn't yet been run on a customer machine. If
> we ever pilot, I'd install it on a test VM with you first.
>
> **Arvind:** Data stays on that VM?
>
> **F:** Yes: PostgreSQL and a workspace folder on that VM. It doesn't need internet to work; email reports need your
> SMTP relay.
>
> `[Note: IT managers respect precise infrastructure answers more than features. The installer caveat costs nothing
> here and buys trust.]`
>
> **Arvind:** I'll read it. Come back when approvals and mobile are out. Gate pass stays on Power Apps.

**Outcome:** lost the gate-pass app (correctly); production planning deferred until P1/P2.

**What went right:** recommended Power Apps for the M365-shaped app; used verified licence facts; found the real
opportunity (premium-licence cost for 60 users on on-prem SQL).
**What went wrong:** didn't ask early enough for the app list with user counts; the premium-licence case should have
been the opening.
**Next best action:** send the security model and a 3-year cost comparison for the 60-user app at Microsoft's
published prices vs `<PRICE_BAND_100>`; diary a follow-up for after P1/P2 releases.
**Gap that decided it:** **phone layout** (P2), **approvals** (P1), **PDF** (P2), **outside security review**.

---

## g) The prospect who ghosts after the demo

**Persona:** Harish (fictional), owner of a 70-person plastics moulding unit in Govindpura. Demo went well, he said
"send proposal". Proposal sent; two WhatsApp messages unread for 9 days. (He had opted in to WhatsApp in the first
meeting.)

**Follow-up sequence (as executed):**

| Day | Channel | Message (short) | Note |
|---|---|---|---|
| 0 | Email + WhatsApp | Proposal with one-page recap; "I'll call Thursday 11 am to go through it" | Book the review at the demo; this step was skipped, the root cause |
| 3 | Phone | No answer; no voicemail | |
| 5 | WhatsApp | "Harish ji, one question only: does the 8 am report solve the problem you mentioned with Monday rejects?" | A yes/no question, not "any update?" |
| 9 | Call to plant head (Deepak, met at the demo) | "Is the pilot still a priority, or should I step back?" | Multi-thread |
| 12 | Email | Value add: a one-page reject-reason Pareto made from the demo data | Give something useful |
| 19 | Email "close the file" | Below | |

> Day 9, phone, Deepak (plant head):
>
> **F:** Deepak ji, I don't want to chase Harish ji if the timing is wrong. Honestly, where does it stand?
>
> **Deepak:** Sir, a big customer audit came. He's busy for two weeks. Also, one thing: he asked his friend who has
> Zoho, and the friend said Zoho has mobile app.
>
> **F:** That's helpful, thank you. Zoho does have mobile apps today; we don't yet. Does Harish ji want the operators to
> enter on phones, or is it your office that types the sheets?
>
> **Deepak:** Office only. Operators don't touch it.
>
> **F:** Then the comparison is mostly price per user over three years, and on-premise vs cloud. Can I send you a
> one-page comparison you can show him after the audit?
>
> **Deepak:** Send. After 25th call him.
>
> `[Note: the champion gave the two real reasons: timing (audit) and a competitor's mobile claim. Neither was in the
> silence.]`

> Day 19, email ("close the file"), used because the 25th passed without reply:
>
> Subject: Should I close the file?
> Harish ji, I haven't heard back, which usually means the timing isn't right. I'll close the pilot file this Friday
> so it's not hanging on you. If the Monday-rejects report is still useful after the audit, reply "later" and I'll
> check in next month. Regards, <NAME>

> Day 20, Harish (WhatsApp): "Audit over. Come Monday 10."
>
> Day 20, founder's reply (WhatsApp): "Thank you, Harish ji. Monday 10 am confirmed. I'll bring the proposal and a
> one-page comparison with the Zoho option your friend mentioned, with prices from their website. 30 minutes is
> enough."
>
> `[Note: confirm the time, name the agenda, address the hidden objection (Zoho) up front, and keep the meeting
> short. Never reply "great, so shall we start?" to a revived prospect; earn the meeting first.]`

**Outcome:** revived; meeting set. (In a realistic run, about half of these stay dead; plan for that.)

**What went right:** multi-threaded through the plant head; specific questions instead of "any update"; a polite
close-the-file email.
**What went wrong:** no review meeting was booked at the end of the demo; the founder did not know about the customer
audit (a discovery question about the next 30 days would have caught it).
**Next best action:** Monday meeting: go through proposal, address Zoho comparison with verified prices, and book the
install date before leaving.
**Gap that decided it:** **phone layout** (competitor comparison) and **dashboards** (he wanted charts; the Pareto was
made in Excel). Timing, not product, caused the silence.

---

## h) A pilot that goes badly in week 2 (adoption problem)

**Persona:** Pilot at a fictional 60-person sheet-metal firm. App: shift production log entered by two supervisors at
the office PC after each shift. Success criterion: ≥ 80% of shifts logged. Week 2 actual: 35%. The owner, Suresh, is
annoyed. Week-2 review meeting.

> **Suresh:** I paid. Half the shifts are not entered. My supervisors say your software is slow and complicated.
>
> **F:** Thank you for telling me straight. Can I spend 20 minutes with the two supervisors, without you in the room,
> and then come back with what I'll change by Monday?
>
> `[Note: don't defend the product in front of the owner. Get the facts from the users first.]`
>
> *(With supervisors Ramesh and Iqbal)*
>
> **F:** Show me exactly what you do after the shift.
>
> **Ramesh:** Shift ends 10 pm. Office PC is locked, office closes at 7. So I write in the register, next morning I
> type. But morning I'm on the floor. So it's late or not done.
>
> **Iqbal:** And the form has 14 fields. On paper I write 6. Rest the planner fills.
>
> **F:** So two problems: the PC isn't available at shift end, and the form asks for things you don't know. Which six
> do you write?
>
> **Iqbal:** Machine, part, good, reject, downtime minutes, reason.
>
> `[Note: the pilot was designed in the office for the office. The failure is design and access, not "people won't
> use it".]`
>
> *(Back with Suresh)*
>
> **F:** Here's what's wrong, and two of the three are my fault. One: I built a 14-field form; supervisors know 6 of
> them. I'll cut their form to those 6 by tomorrow; the planner fills the rest in his own screen. Two: the office PC is
> locked at shift end. Is there any PC on the floor or in the shift in-charge cabin?
>
> **Suresh:** Maintenance cabin has an old PC.
>
> **F:** If it can open a browser on the office network, they can log in there. I'll check it today. Three: you. Do you
> open the 8 am report?
>
> **Suresh:** ...Not every day.
>
> **F:** If the supervisors see that nobody reads it, they stop entering. Can you reply to the report on the app's
> comments for one week, even one line, "why Line 2 rejects high?"
>
> **Suresh:** Okay. But my supervisors have phones. Why can't they enter from phone? This is 2027.
>
> **F:** Fair point, and it's the biggest gap in my product. Phone screens are planned; I can't give you a date I'd
> stand behind. I'm writing it in our review notes as the reason the success criterion is at risk.
>
> **Suresh:** If week 4 is not 80%, I stop.
>
> **F:** Agreed. And I'd like to change the measure to "shifts logged by 10 am next day", because that's what the
> report needs. Fair?
>
> **Suresh:** Fine.

**Week 4 (epilogue):** 6-field form, maintenance-cabin PC, owner commenting daily: 78% of shifts logged by 10 am next
day. Suresh extended two weeks, as allowed once in the pilot terms.

**What went right:** users interviewed alone; the founder took ownership of design mistakes; fixed access (PC at shift
end) and the owner's own behaviour; tightened the measure to what matters.
**What went wrong:** the week-0 plant walk didn't check where and when data entry happens; the form was designed from
the planner's sheet, not the supervisor's paper.
**Next best action:** add "where is the nearest unlocked PC at shift end?" and "which fields do supervisors actually
know?" to the discovery bank (added under Production in the playbook); design every entry form from the paper sheet, not the Excel.
**Gap that decided it:** **phone layout** (P2) directly; **dashboards** marginally (owner engagement).

---

## Summary: product gaps ranked by how often they lose deals

Counted across the 8 fictional simulations above (D = decided or narrowed the deal, I = influenced it), then checked
against the research rankings in [manufacturing.md](../../research/manufacturing.md#6-gap-analysis-against-appbuilder)
and [education.md](../../research/education.md#6-gap-analysis-against-appbuilder). Simulations are rehearsal, not
evidence: replace this table with the CRM "Product gaps raised" field after 20 real conversations.

| Rank | Gap | Sims where it decided (D) / influenced (I) | Roadmap phase | Sales consequence until shipped |
|---|---|---|---|---|
| 1 | **Phone layout** (field-tested on Android) | a I, f D, g I, h D | P2 Reach (design sizes exist in Studio; not field-tested) | Pilots must be designed for PC entry; disqualify phone-only prospects |
| 2 | **Flows: approvals, reminders, escalations** | b D, e D, f D | P1 Automation (runtime in progress, JSON editor) | No approval/escalation use cases; scheduled email reports as the only automation |
| 3 | **WhatsApp alerts** | b I, e D | P2 Reach | Email only; expect this question in every manufacturing meeting |
| 4 | **Tally connector** | c D (scope), d D (partner effort) | P3 / optional, built on first customer need | Sell non-Tally data only; partners refer rather than resell |
| 5 | **PDF output** (receipts, job cards, gate pass) | e D, f I | P2 Reach | No document-printing use cases |
| 6 | **Outside security review / certifications** | b I, f I | Before pilots beyond one company (master plan §5) | Lose IT-led and regulated buyers; offer customer-commissioned tests |
| 7 | **One-person continuity** | a I, d I, g I | Not a phase: business decision (escrow, backup partner) | Offer the continuity package in [objection-handling](objection-handling.md#14-what-if-you-get-a-job-fall-ill-or-shut-down) |
| 8 | **Dashboards** | g I, h I | P2 Reach | Use scheduled reports; build charts in Excel from CSV export |
| 9 | **Validated GxP features** (tamper-evident audit, e-signatures) | b D | Not on roadmap | Disqualify GxP record use; non-GxP apps only, in writing |
| 10 | **Payment gateway / parent portal** | e D | Not planned / P6 Sites | Do not sell to education for fees; office-side apps only |

**What this means for the roadmap (founder's call, not sales'):** P1 (flows, approvals) and P2 (phone, PDF, WhatsApp,
dashboards) together remove gaps 1, 2, 3, 5 and 8, which touch 7 of the 8 simulations. That supports the master plan's
order and its rule that the pilot proper starts after them. Selling before P2 means selling office-side apps only.
