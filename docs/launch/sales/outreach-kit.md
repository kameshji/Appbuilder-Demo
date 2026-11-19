# Outreach kit

Status: working draft, 19 Nov 2026. Placeholders: `<NAME>` (prospect), `<COMPANY>`, `<MY_NAME>`, `<MY_ENTITY>`,
`<INTRODUCER>`, `<AREA>` (industrial area), `<PRICE>`, `<DATE>`, `<LINK>`.

**Before using anything here:**

1. **Employment timing.** Until your notice period ends and a lawyer confirms what is allowed, use only the templates
   marked **[Research]**: they ask for learning conversations, mention no product for sale, no price, no pilot. Everything
   else is for after that date. See [README.md](README.md#the-employment-constraint).
2. **Honesty.** No template claims customers, results, awards or features that don't exist. Planned features are never
   mentioned as available. Keep it that way when you edit.
3. **Personalise one line** in every message (their product, customer, plant, a post they wrote). Unpersonalised
   messages to small-firm owners are ignored.

---

## Indian commercial-communication rules (brief; research, not legal advice)

- **Calls and SMS (TRAI).** The Telecom Commercial Communications Customer Preference Regulations were amended in
  February 2025: promotional calls use the **140** series, service/transactional calls the new **1600** series; senders
  are barred from using ordinary 10-digit numbers for telemarketing; commercial communication from **unregistered**
  senders is treated as unsolicited (UCC); after a first violation the sender's outgoing services are barred for 15
  days, and repeat violations lead to disconnection of all resources for a year and blacklisting; complaints can be
  filed within 7 days; consent rules include a mandatory opt-out in promotional messages and no re-request of consent
  for 90 days after an opt-out ([TRAI press release 11/2025](https://cms.trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf)).
  Promotional SMS also needs DLT registration of the entity, header and templates (see the
  [manufacturing research](../../research/manufacturing.md#2-automations), vendor summary).
  **Practical rule for a solo founder:** do not cold-call or bulk-SMS random mobile numbers to promote the product from
  your personal number. Call people who gave you their number for that purpose (exchanged a card, asked you to call,
  were introduced and agreed), and keep a record of how you got consent. A lawyer should confirm where one-to-one B2B
  calls fall under these rules.
- **WhatsApp.** Meta requires businesses to obtain opt-in **before** messaging people on WhatsApp; the opt-in must state
  that the person is opting in to receive messages from the business and must name the business; Meta recommends clear
  opt-out instructions and honouring them ([Meta: Get opt-in for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in)).
  The WhatsApp templates below are only for people who said "yes, WhatsApp me" (record date and context in the CRM
  field "WhatsApp opt-in").
- **Email and LinkedIn.** This research found no India-specific cold-email statute; the DPDP Act and Rules (most
  obligations from about 13 May 2027, per the [manufacturing research](../../research/manufacturing.md#5-architecture-and-deployment))
  and the IT Act may apply to how you collect and use personal data. Good practice regardless: identify yourself and
  your entity, say how you got their address, include a one-line opt-out, honour it immediately, and keep lists small
  and hand-picked. **Unverified**: lawyer to confirm.

---

## Cold and warm emails (10)

### E1 [Research] Learning conversation (usable before notice end, subject to lawyer)
Subject: 20 minutes on how <COMPANY> tracks production?

> Dear <NAME>,
>
> <INTRODUCER> mentioned you run a <product> plant in <AREA>. I'm researching how small manufacturers track production,
> rejects and maintenance outside Tally, and what they find painful about it. I'm not selling anything; I'd like to
> learn.
>
> Could I take 20 minutes of your time, at your office or on a call, in the next two weeks? I'll share a short summary of
> what I learn from 15 plants (anonymised) with everyone who helps.
>
> Regards, <MY_NAME>
> If you'd rather not hear from me again, just reply "no" and I won't write again.

Hinglish line for the same (WhatsApp/phone with consent): "Sir, main sirf samajhna chahta hoon ki aap production aur
rejection ka hisaab kaise rakhte hain. Kuch bechne nahi aa raha, bas 20 minute."

### E2 Warm introduction (after notice end)
Subject: <INTRODUCER> suggested I write

> Dear <NAME>,
>
> <INTRODUCER> said your team re-types shift sheets into Excel every evening and the morning report comes late. That's
> exactly the problem I work on: I turn a plant's own Excel sheet into a secured app on its own PC, with a daily report
> by email.
>
> Could I visit for 30 minutes on <DATE> or <DATE>? If you have the sheet handy, I'll show you what it would look like
> as an app, on your data.
>
> Regards, <MY_NAME>, <MY_ENTITY>

### E3 Cold: late MIS
Subject: Yesterday's output by machine, at 8 am?

> Dear <NAME>,
>
> I noticed <COMPANY> supplies <customer/sector>. In most plants your size I talk to, yesterday's output and rejects by
> machine reach the owner by noon, after someone compiles Excel.
>
> I build apps from a plant's own Excel sheets that run on its own PC, and send that report automatically at 8 am. Would
> a 20-minute conversation be useful to see whether it fits <COMPANY>?
>
> <MY_NAME>, <MY_ENTITY> | Reply "no" and I won't write again.

### E4 Cold: customer audit trigger
Subject: Preparing for the next customer audit at <COMPANY>

> Dear <NAME>,
>
> Customer audits usually mean days of collecting inspection sheets, training records and rejection data from files and
> WhatsApp. I help small manufacturers keep those records in one place on their own PC, searchable, with who-changed-what
> history and access by role.
>
> I don't claim it makes you compliant; your auditors decide that. It does make finding the records faster. Worth a
> 20-minute call?
>
> <MY_NAME> | Reply "no" to opt out.

### E5 Cold: rejects visibility
Subject: Rejects by reason, by shift

> Dear <NAME>,
>
> Do you know last week's rejection rate by machine and reason without asking anyone? Most owners I speak to don't,
> because the data sits on paper until month end.
>
> I set up a simple app from your existing rejection sheet, used at your office PC, with the summary emailed daily.
> A short call to see if it's worth a look?
>
> <MY_NAME> | Reply "no" to opt out.

### E6 Cold: key-person risk
Subject: When your Excel expert is on leave

> Dear <NAME>,
>
> In many plants one person holds the production workbook together. When they're away, the reports stop. I turn that
> workbook into an app on your own PC with roles, history and backups, and your same person keeps maintaining it with
> Excel-style formulas.
>
> 20 minutes to see if it applies at <COMPANY>?
>
> <MY_NAME> | Reply "no" to opt out.

### E7 Cold: IT manager with Power Apps licence cost
Subject: Power Apps Premium at $22 from January

> Dear <NAME>,
>
> Microsoft's Power Apps Premium moves from $20 to $22 per user per month for new terms and renewals from 1 January
> 2027, and Microsoft says users without a premium licence can't open premium apps from February 2027
> ([Microsoft](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update)).
>
> If you have a Power Apps style app with many occasional users on on-premise SQL, I'd like to show you a self-hosted
> alternative priced per install, with a maker experience Power Apps users recognise. If your apps fit Microsoft 365
> standard connectors, stay where you are; I'll tell you so.
>
> <MY_NAME> | Reply "no" to opt out.

### E8 After an event (they gave a card)
Subject: From the <EVENT> stall: the Excel-to-app demo

> Dear <NAME>,
>
> Thanks for stopping at the stall on <DATE>. You mentioned <their pain>. If you send one sheet (numbers changed is
> fine), I'll build it into a working app and show you in 30 minutes at your office.
>
> <MY_NAME>

### E9 Demo recap (same evening)
Subject: Recap: <COMPANY> production log app

> Dear <NAME>,
>
> Thank you for today. What you told us: (1) <pain>, (2) <pain>, (3) <pain>.
> What you saw: your <sheet> as an app, supervisor access by line, the 8 am email report, backup and full export.
> Not shown because not built yet: phone entry, WhatsApp alerts, PDF, approvals.
> Next step we agreed: <step> on <DATE>.
> The ROI sheet with your numbers is attached; please correct anything I got wrong.
>
> <MY_NAME>

### E10 Close the file
Subject: Should I close the file?

> Dear <NAME>,
>
> I haven't heard back, which usually means the timing isn't right. I'll close the file on <DATE> so it isn't hanging
> on you. If it becomes useful later, reply "later" and I'll check in next month.
>
> <MY_NAME>

Hinglish variant (WhatsApp, opt-in only): "<NAME> ji, lagta hai abhi sahi time nahi hai. Main file <DATE> ko band kar
deta hoon. Baad mein zarurat ho to bas 'later' likh dijiye."

---

## LinkedIn messages (6)

1. **[Research] Owner/plant head, connection note (≤ 300 characters):** "Hi <NAME>, I'm researching how small
   manufacturers in <AREA> track production and rejects outside Tally. Not selling; would value 15 minutes of your
   experience. Happy to share what I learn."
2. **Plant head (after notice end):** "Hi <NAME>, saw your post on <topic>. I turn plants' own Excel sheets into
   secured apps on their own PC, with a daily report. Open to a 20-minute chat?"
3. **IT manager:** "Hi <NAME>, I build a self-hosted app platform with a Power Apps-like maker experience, priced per
   install. If premium licences for shop-floor users are a budget problem, I'd like to compare notes."
4. **Tally partner:** "Hi <NAME>, your clients keep accounts in Tally and production in Excel. I build that shop-floor
   layer next to Tally, without touching Tally or your AMC. Would a referral arrangement interest you?"
5. **After they engaged with your post:** "Thanks for the comment on <post>, <NAME>. You mentioned <point>; how do you
   handle that at <COMPANY> today?" (No pitch in the first reply.)
6. **Follow-up after no reply (once only):** "Hi <NAME>, one question only: is production reporting a headache at
   <COMPANY>, or is it sorted? Either answer helps me."

---

## WhatsApp messages (6; only after recorded opt-in)

Opt-in line to use in person: "Can I WhatsApp you meeting details and the demo recap from <MY_ENTITY>? You can say
STOP any time." Record "yes", date and context in the CRM.

1. **Meeting confirmation:** "Namaste <NAME> ji, <MY_NAME> from <MY_ENTITY>. Confirming <DATE>, <TIME> at your plant,
   30 min. Reply STOP to stop messages."
2. **Sheet request:** "<NAME> ji, for Thursday's demo please share the production sheet (numbers changed is fine).
   I'll delete it after the demo if you prefer." / Hinglish: "Thursday ke demo ke liye production wali sheet bhej
   dijiye, numbers badal ke bhi chalega. Demo ke baad delete kar dunga."
3. **Day-before reminder:** "Reminder: tomorrow <TIME>. Please keep the plant head and whoever maintains the sheet for
   the last 20 minutes."
4. **Recap pointer:** "Thank you for today. Recap and your ROI sheet are in your email. Next step: <step> on <DATE>."
5. **Single-question follow-up:** "<NAME> ji, one question: does the 8 am report solve the Monday-rejects problem you
   mentioned? Yes/no is enough." / Hinglish: "Ek hi sawaal: kya 8 baje wali report se Monday ke rejection wali problem
   solve hogi? Haan/na kaafi hai."
6. **Referral thanks:** "Thank you for introducing <REFERRAL_NAME>. I'll keep you posted on how it goes."

---

## Call scripts (3, with voicemail)

Only to people who agreed to be called (introduced, gave a card, asked). See TRAI note above.

### C1 Warm-intro call (90 seconds)
> "Namaste <NAME> ji, <MY_NAME> here. <INTRODUCER> gave me your number and said you'd be okay with a call. Is this a
> good minute? ... He mentioned your shift data is typed into Excel every evening. I build apps from a plant's own sheets
> that run on your own PC. I'm not asking for anything today except a 30-minute visit to see your sheet and show you
> what it would look like. Would <DATE> or <DATE> work?"
> If "send details": "Sure, I'll email a short note. Can I call on <DATE> to fix the time?"

**Voicemail:** "Namaste <NAME> ji, <MY_NAME>, introduced by <INTRODUCER>, about your production Excel. I'll send a short
email and try again on <DAY>. My number is <NUMBER>."

### C2 Event follow-up call
> "<NAME> ji, <MY_NAME> from the <EVENT> stall; you gave me your card for a call. You said <pain>. Could I come and
> build your sheet into an app in front of you, 30 minutes? ... <DATE> 11 am?"

**Voicemail:** "<NAME> ji, <MY_NAME> from the <EVENT> stall, calling as promised about the Excel-to-app demo. I'll
WhatsApp you only if you'd like that; otherwise email. Number <NUMBER>."

### C3 Proposal review call
> "<NAME> ji, I sent the pilot proposal on <DATE>. Can we go through it for 10 minutes? ... Which part needs changing:
> scope, fee, or timing? ... If we agree today, I can install on <DATE>."

**Voicemail:** "<NAME> ji, <MY_NAME> about the pilot proposal. Ten minutes is enough; I'll try on <DAY> at <TIME>, or
reply with a better time."

Hinglish opener for any call: "Namaste sir, <MY_NAME> bol raha hoon, <INTRODUCER> ji ne aapka number diya tha. Do minute
baat ho sakti hai?"

---

## Referral ask

Ask after 60-90 days of live use, in person, when the owner has just said something positive.

> "<NAME> ji, I'm glad the morning report is working. I grow only through introductions like yours. Is there one owner,
> maybe a supplier or a friend in <AREA>, who struggles with Excel the way you did? If you're comfortable, could you
> send him a WhatsApp introducing me? I'll take it from there and keep you posted."

Make it easy: hand them a 2-line forwardable text: "<FRIEND> ji, <MY_NAME> ne hamare production Excel ko app bana diya,
hamare hi computer par. Unse 30 minute mil lijiye."

---

## Event booth pitch

**30 seconds (English):** "Do you track production or rejects in Excel? Give me one sheet and I'll turn it into an app
that runs on your own office PC: your supervisor sees only his line, and the owner gets the report by email at 8 am.
No cloud needed. Can I show you on a sample sheet?"

**30 seconds (Hinglish):** "Sir, production ya rejection Excel mein rakhte hain? Ek sheet dijiye, main use app bana
dunga jo aapke office ke computer par chalega: supervisor ko sirf apni line dikhegi, aur malik ko subah 8 baje report
email par. Ek sample dekhenge?"

**2 minutes:** (1) Ask: "What does your team type into Excel every day?" (2) Show: the sample sheet becoming an app
(pre-built, 60 seconds): Test as user, live update in a second browser, scheduled report. (3) Honest status: "It's
new; I'm looking for my first few plants. Phone screens and WhatsApp alerts are on the roadmap, not available yet."
(4) Ask: "Would you show me your sheet at your plant next week?" Take the card; ask permission to email/WhatsApp.

---

## Follow-up cadences

| Cadence | Touches | Stop rule |
|---|---|---|
| **Cold email** | Day 0 E3-E7 → day 4 one-line bump ("any thoughts?" plus one new fact) → day 10 different angle (another E-template) → day 21 E10 | Any "no" or opt-out: stop and mark do-not-contact |
| **Warm intro** | Day 0 E2 + introducer cc'd → day 2 call (C1) → day 5 email → day 9 ask the introducer for a nudge | After 3 touches without reply, thank the introducer and pause |
| **Post-demo** | Same evening E9 → day 2 WhatsApp 4 (if opt-in) → day 5 C3 → day 9 call the champion (multi-thread) → day 12 value-add (e.g. a Pareto from the demo data) → day 19 E10 | Book the next meeting at the end of every demo; most ghosting starts with no booked next step |
| **Partner** | Monthly call; quarterly visit; share every outcome of their referrals within 48 h | Two quarters without a referral: move to annual touch |
| **Nurture** | One useful note when something ships (release notes in plain words), max monthly | Unsubscribe honoured immediately |
