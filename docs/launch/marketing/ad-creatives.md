# Ad creatives: brief, 24 concepts, landing-page tests

Status: draft, 19 Nov 2026. Product name written as `<NAME>` (re-check every character limit once the real name is
known). Read [strategy.md](strategy.md) first: **no paid ad runs before the name is cleared, a landing page exists,
and (for most concepts) the pilot case study is approved.** Each concept says when it may run.

Binding rules from [BRIEF.md](../BRIEF.md): no fabricated testimonials, logos, numbers, user counts, awards or
certifications; mock-ups labelled "Example"; planned features labelled as planned; comparisons factual and sourced.

---

## 1. Creative brief

| Item | Brief |
|---|---|
| Objective | Phase A/B: waitlist and design-partner applications; free template downloads. Phase C: demo bookings and clinic sign-ups. Not brand awareness. |
| Primary audiences | ICP 1 owners/plant heads of 20-200 person manufacturers (India, Hindi-English); ICP 2 Power Platform consultants (India, later UK/GCC, English); ICP 3 ops generalists (English). See [strategy.md §1](strategy.md). |
| Single-minded proposition | Your business apps, on your own computer, with "who sees what" built in. |
| Reasons to believe (today) | Self-hosted single install (Windows/Linux installers); Excel-like formulas; row/column security with "test as user"; dev/test/production environments; backup and restore; two-step verification; scheduled email reports. |
| Never say | "Secure"/"bank-grade"/"certified"/"compliant"; "AI-powered"; "mobile app"; "WhatsApp alerts"; "PDF reports"; "ready-made templates"; "trusted by"; "#1"; any customer count; any price until pricing is decided; "Power Apps clone"/"Power Fx compatible". |
| Tone | Plain, specific, a little dry; respects the owner's intelligence. See [brand-foundations.md](brand-foundations.md). |
| Visual world | Real product screens with clearly fake sample data (names like "Line 1", "B-101"); real shop-floor objects (register book, machine, Tally on a desk PC); warm daylight, not stock-photo glamour. People shown are labelled models or illustrations, never presented as customers. |
| Mandatory | "Example" tag on any mock-up; "Version 0.5, early access" or "planned" tags where relevant; on video, an end card with the website. |

### Platform specs used below (verify again before production)

| Format | Spec | Source |
|---|---|---|
| LinkedIn single image | Intro text max 600 (keep under ~150 before "see more"); headline max 200 (truncates around 70 on mobile); image 1200×1200 recommended, also 1200×627 and 1200×1500; max 5 MB | [ZenABM spec summary](https://zenabm.com/blog/linkedin-sponsored-post-specs) (third-party; LinkedIn's own help page could not be fetched) |
| LinkedIn carousel | 2-10 cards, 1080×1080, card headline 45 characters, intro text 255 characters, 10 MB per card | [ZenABM](https://zenabm.com/blog/linkedin-carousel-ad-specs/) (third-party) |
| LinkedIn budget | Minimum US$10/day; US$100 lifetime minimum for a new campaign | [LinkedIn](https://business.linkedin.com/advertise/ads/best-practices/maximize-your-budget) |
| Meta/Instagram Reels | 9:16, 1080×1920; 3-90 s allowed, 15-30 s recommended; primary text best under 125 characters; keep the top ~14% and bottom ~35% clear of key content | [Benly 2026 spec guide](https://benly.ai/learn/ad-creative/meta-ads-creative-specs-2026) (third-party) |
| YouTube | Non-skippable in-stream 7-15 s (up to 30 s on connected TV); bumper up to 6 s | [Google Ads help](https://support.google.com/google-ads/answer/11462260) |
| YouTube skippable in-stream | Skippable after 5 s; no hard maximum for 45 s creative (**Unverified** in this research) | – |
| Google responsive search ads | Up to 15 headlines × 30 characters; up to 4 descriptions × 90; display paths 15 characters each | [Google Ads help](https://support.google.com/google-ads/answer/7684791) |

---

## 2. Concepts

Format of each concept: **Audience · Insight · Hook · Copy (EN, plus Hinglish for India) · Visual · CTA · Landing page ·
Compliance · Earliest run**.

### LinkedIn single image

#### 1. "The seven registers"
- **Audience:** ICP 1 owners and plant heads, India (LinkedIn: job titles Owner, Director, Plant Head, Works Manager; company size 11-200; industries manufacturing).
- **Insight:** Every small plant runs on the same handful of paper registers; owners recognise the list instantly.
- **Hook:** "Your plant runs on 7 registers. How many can you search?"
- **Copy (EN, intro 141 chars):**
  ```
  Production, rejection, breakdown, PM, indent, gate pass, attendance. If they live on paper or in 7 Excel files, you see the plant a day late.
  ```
  Headline: `Turn your registers into apps on your own PC`
- **Copy (Hinglish):** `Production, rejection, breakdown, PM, indent, gate pass, attendance. Sab register ya alag-alag Excel mein? To plant ki report ek din late milti hai.` Headline: `Apne registers ko apps banaiye, apne hi PC par`
- **Visual:** 1200×1200. Top-down photo of seven worn register books on a steel desk in a factory office, each with a hand-written label (Production, Rejection, Breakdown, PM, Indent, Gate Pass, Attendance). One register open; overlaid on its right page, a clean laptop screen showing the real `<NAME>` table "Production" with sample rows (B-101, Line 1, 120). Small grey tag bottom right: "Example screen, sample data". Daylight from a side window; no people.
- **CTA:** Learn more → "Get the free register templates".
- **Landing page:** /templates (free register templates + waitlist).
- **Compliance:** No outcome claims; screen is real product with sample data; "templates" here means free Excel files, not the planned in-product template pack.
- **Earliest run:** Phase C (paid). Same visual can be an organic post in Phase A.

#### 2. "Who sees the salary column?"
- **Audience:** ICP 1 and ICP 3 (owners, office managers).
- **Insight:** Shared Excel means everyone sees everything; owners worry about salary and cost columns but tolerate it.
- **Hook:** "Your supervisor can see everyone's salary. In the shared Excel."
- **Copy (EN):** `In <NAME>, each role sees only its rows and columns. The supervisor sees Line 1. Accounts sees salaries. You check it with "Test as user" before anyone logs in.` Headline: `Right people, right rows, right columns`
- **Copy (Hinglish):** `<NAME> mein har role sirf apni rows aur columns dekhta hai. Supervisor ko sirf Line 1, accounts ko salary. "Test as user" se pehle hi check kar lijiye.`
- **Visual:** Split image 1200×627. Left: a blurred Excel grid with a "Salary" column highlighted red. Right: the real "Test as user" dialog ([roles-test-as-user-why.png](../../images/roles-test-as-user-why.png)) cropped to show "Visible rows" and "Hidden columns". Caption tag: "Real screen, sample data".
- **CTA:** Learn more.
- **Landing page:** /security-roles (explains roles, row and column access; states "no outside security review yet").
- **Compliance:** Describe the mechanism only; never "secure" or "DPDP compliant".
- **Earliest run:** Phase C.

#### 3. "Consultant: the deal you lost on licences"
- **Audience:** ICP 2, India first (later UK/GCC). Targeting: skills Power Apps / Power Automate, job titles consultant, freelancer, developer.
- **Insight:** Consultants lose small-client deals on per-user licence cost and cloud objections, not on capability.
- **Hook:** "Lost a 30-user client on licence cost?"
- **Copy (EN):** `<NAME> is a self-hosted app platform: canvas apps with Excel-style formulas, built-in row/column security, dev/test/prod, installed on the client's own server. Version 0.5. Looking for 10 founding partners to break it.` Headline: `Founding partners wanted: self-hosted app platform`
- **Visual:** 1200×1200. Dark-mode screenshot of the Studio formula bar (`Filter(Equipment, ...)`, [studio-filter-formula.png](../../images/studio-filter-formula.png)), large, with a sticky note overlay: "Runs on the client's server". No Microsoft logos or product names in the image.
- **CTA:** Apply.
- **Landing page:** /partners (founding partner programme, honest status list).
- **Compliance:** No Microsoft trademarks in the creative; no pricing comparison until our pricing exists.
- **Earliest run:** Phase A organic; paid in Phase C.

#### 4. "Data stays in the office"
- **Audience:** ICP 1 and ICP 3 in areas with poor connectivity or data-ownership concerns.
- **Insight:** Owners distrust "someone else's server" and patchy internet in industrial estates.
- **Hook:** "Internet down at Mandideep again? Your apps don't care."
- **Copy (EN):** `<NAME> installs on a PC or server in your office. People on your network use it in the browser. Backups run every night and you can restore them yourself.` Headline: `Apps that live on your own computer`
- **Copy (Hinglish):** `<NAME> aapke office ke PC ya server par install hota hai. Network par sab browser se use karte hain. Har raat backup, aur restore aap khud kar sakte hain.`
- **Visual:** A small tower PC on a shelf in a factory office next to a Tally screen on a monitor (Tally screen blurred, no logo), a router with a red "no internet" light. Overlay: the real backup restore dialog ([backups-restore-dialog.png](../../images/backups-restore-dialog.png)), cropped to "Restore as a new environment".
- **CTA:** Learn more.
- **Landing page:** /how-it-installs.
- **Compliance:** Must not imply "works fully offline" for every scenario: install needs internet or an offline bundle ([getting-started.md](../../guide/getting-started.md)); LAN access needs the HTTPS option. Do not name the town in paid geo ads unless targeting that area.
- **Earliest run:** Phase C, and only after the Windows installer has been proven on a customer machine.

### LinkedIn carousel (1080×1080, card headlines ≤45 characters)

#### 5. "From register to app in 5 steps"
- **Audience:** ICP 1, ICP 3.
- **Insight:** People don't believe "no code" until they see the steps.
- **Hook (intro, ≤255):** `A breakdown register, rebuilt as an app on your own PC. Five real screens, sample data. (Phone entry and WhatsApp alerts are planned, not built yet.)`
- **Cards (EN headline / visual):**
  1. `The register you have today` / photo of a hand-written breakdown register page.
  2. `Step 1: start with your data` / real "Start with data" screen ([home-start-with-data.png](../../images/home-start-with-data.png)).
  3. `Step 2: add a rule like Excel` / validation rule screen ([events-validation-rule.png](../../images/events-validation-rule.png)) with "Qty > 0".
  4. `Step 3: decide who sees what` / roles screen.
  5. `Step 4: get it by email every Monday` / scheduled reports screen ([reports-list.png](../../images/reports-list.png)).
  6. `Step 5: test before you go live` / environments picker ([environments-picker.png](../../images/environments-picker.png)).
  7. `Want us to build yours?` / plain card with CTA.
- **Hinglish card headlines:** `Aaj ka register` · `Step 1: apne data se shuru` · `Step 2: Excel jaisa rule` · `Step 3: kaun kya dekhega` · `Step 4: har Monday email par` · `Step 5: live se pehle test` · `Aapka register banayein?`
- **CTA:** Apply → design partner.
- **Landing page:** /design-partner.
- **Compliance:** Every screen real; "sample data" tag on each card; planned features stated in intro.
- **Earliest run:** Organic Phase A; paid Phase C.

#### 6. "OEE in 6 cards"
- **Audience:** ICP 1 plant heads, production managers.
- **Insight:** OEE is talked about but rarely calculated honestly in small plants.
- **Hook:** `OEE = availability × performance × quality. Here's each one with real numbers from a sample shift, and a free calculator.`
- **Cards:** 1 `What OEE actually measures` · 2 `Availability: run time ÷ planned` · 3 `Performance: ideal cycle × count` · 4 `Quality: good ÷ total count` · 5 `A sample shift: 62% OEE (example)` · 6 `Free Excel calculator, no sign-up`. Visuals: clean flat infographics, one formula per card, sample numbers in a factory-floor colour palette; card 5 labelled "Example numbers".
- **Hinglish:** `OEE asal mein kya naapta hai` · `Availability: chalne ka time ÷ planned` · `Performance: ideal cycle × count` · `Quality: good ÷ total` · `Ek sample shift: 62% (udaharan)` · `Free Excel calculator`
- **CTA:** Download.
- **Landing page:** /oee-calculator (ungated download; optional waitlist).
- **Compliance:** Formulas sourced to [OEE.com](https://www.oee.com/calculating-oee/); "62%" is explicitly an example, not a benchmark.
- **Earliest run:** Phase A organic; Phase C paid.

#### 7. "For consultants: what's built, what's not"
- **Audience:** ICP 2.
- **Insight:** Practitioners trust a vendor that lists its gaps.
- **Hook:** `An honest feature list for a version 0.5 self-hosted app platform. Green = built. Amber = in progress. Grey = planned.`
- **Cards:** 1 `Built: canvas apps + Excel-style formulas` · 2 `Built: row/column security, test as user` · 3 `Built: dev/test/prod + deploy` · 4 `Built: backup, restore, two-step sign-in` · 5 `In progress: flows and approvals` · 6 `Planned: phone layouts, PDF, dashboards` · 7 `Planned: SSO, portals, templates, agents` · 8 `Founding partners: 10 places`.
- **Visual:** Each card a real screenshot with a coloured status chip (green/amber/grey) top-left.
- **CTA:** Apply.
- **Landing page:** /partners.
- **Compliance:** Status chips must match BRIEF at publish time.
- **Earliest run:** Phase A organic; Phase C paid.

### Meta / Instagram Reels (9:16, 20-30 s; keep text out of top 14% and bottom 35%)

#### 8. "Rejection photo lost in WhatsApp" (25 s)
- **Audience:** ICP 1 (Meta: men and women 28-60 in MP industrial districts; interests manufacturing, small business, Tally; Hindi + English). Exclude under-18s.
- **Insight:** Defect photos get buried in WhatsApp groups; nobody can find them at audit time.
- **Hook (0-2 s):** Thumb scrolling endlessly through a WhatsApp-style chat full of defect photos (generic chat UI, no WhatsApp logo).
- **Script (Hinglish VO, EN subtitles):**
  - 0-3 s: "Audit kal hai. Pichhle mahine ki rejection photo kahan hai?" / "Audit is tomorrow. Where's last month's rejection photo?"
  - 3-9 s: Hand flips register pages; frustration. "Group mein thi... shayad."
  - 9-18 s: Cut to laptop: `<NAME>` table with an attachment column, filter by date, photo appears. VO: "<NAME> mein har inspection ka record, photo ke saath, ek jagah. Aapke apne PC par."
  - 18-23 s: Roles screen. VO: "Aur kaun kya dekhega, yeh aap tay karte hain."
  - 23-25 s: End card: `<NAME>` · "Early access · version 0.5" · website.
- **Visual:** Real office, real laptop screen recordings; actors labelled in-video as "Dramatisation".
- **Primary text (≤125):** `Inspection records with photos, on your own PC. Early access for MP manufacturers.`
- **CTA:** Learn more.
- **Landing page:** /quality (QC register template + design-partner form).
- **Compliance:** Attachments exist today (manufacturing research notes attachments; BRIEF lists the database and record timelines); phone photo capture at the line is **not** claimed. "Dramatisation" label.
- **Earliest run:** Phase C.

#### 9. "Monday report without asking anyone" (20 s)
- **Audience:** ICP 1 owners, ICP 3.
- **Insight:** Owners spend Monday mornings chasing numbers.
- **Hook:** Owner calling three people in a row: "Production kitna hua? ... Rejection? ... Breakdown?"
- **Script:** 0-5 s calls (split screen). 5-12 s phone shows an email "Weekly production summary" with a table (from scheduled reports). VO (Hinglish): "Har Monday subah, report khud email mein. Har person ko sirf uska data." 12-18 s scheduled report builder screen. 18-20 s end card.
- **EN VO:** "Every Monday morning, the report arrives by email. Each person gets only their own data."
- **Primary text:** `Scheduled email reports from your own server. Each person sees only what they may see.`
- **Visual:** Real scheduled report email (sample data), real [reports-builder.png](../../images/reports-builder.png).
- **CTA:** Learn more. **Landing page:** /reports.
- **Compliance:** Scheduled reports exist (BRIEF). Dashboards are planned; do not show dashboards.
- **Earliest run:** Phase C.

#### 10. "Excel formula you already know" (25 s)
- **Audience:** ICP 3 and Excel-literate office staff (English and Hinglish versions).
- **Insight:** Office staff are fluent in Excel formulas and afraid of "coding".
- **Hook:** Typing `=IF(` in a spreadsheet cell, then the same habit in the `<NAME>` formula bar.
- **Script (EN):** 0-4 s "If you can write this in Excel..." 4-14 s typing a validation rule `Qty > 0`, save is refused with message "Quantity must be more than 0". 14-22 s "...you can build the app." Studio canvas, drag a table onto a screen. 22-25 s end card.
- **Hinglish:** "Excel mein formula likh lete hain? ... To app bhi bana lenge."
- **Primary text:** `If you can write an Excel formula, you can build a business app. Self-hosted. Early access.`
- **Visual:** Screen recording only; cursor large; captions centred in the safe zone.
- **CTA:** Sign up (waitlist). **Landing page:** /makers.
- **Compliance:** Say "Excel-like" not "Excel-compatible".
- **Earliest run:** Phase C (or organic Phase A on Instagram/YouTube Shorts).

#### 11. "Backup drill in 20 seconds" (20 s)
- **Audience:** ICP 1, ICP 3 owners.
- **Insight:** Many small offices have never tested restoring a backup.
- **Hook:** Coffee spills onto a desktop PC (practical effect). "If this PC dies tonight..."
- **Script:** 3-15 s restore dialog: pick last night's backup → "Restore as a new environment" → done screen ([backups-restore-done.png](../../images/backups-restore-done.png)). VO: "...last night's backup comes back on another machine." 15-20 s end card. (Note in production: restoring "on another machine" must be demonstrated for real before this claim is used; otherwise say "comes back as a copy you can check".)
- **Hinglish:** "Agar aaj raat yeh PC kharab ho jaaye... kal ka backup wapas, kuch minute mein."
- **Primary text:** `Nightly backups you control, and a restore you can test yourself.`
- **CTA:** Learn more. **Landing page:** /backups.
- **Compliance:** Avoid time promises ("in minutes") unless timed on a realistic dataset; the hardening guide says to copy backups to another disk.
- **Earliest run:** Phase C.

### YouTube in-stream

#### 12. 15 s non-skippable: "Two ways to see your plant"
- **Audience:** ICP 1 (YouTube: custom segments on searches like "production report format", "OEE"; India; Hindi + English).
- **Insight:** The owner's choice is between seeing yesterday on paper or today on screen.
- **Script (Hinglish, EN subtitles):** 0-5 s split screen: left a register, right the `<NAME>` table updating live (live updates exist). VO: "Register mein kal ka data. Ya screen par aaj ka." 5-11 s supervisor saves a row, owner's screen updates. VO: "Aapke PC par, Tally ke saath." 11-15 s end card "<NAME> · early access · [site]".
- **EN VO:** "Yesterday's data in a register. Or today's on screen. On your own PC, next to Tally."
- **CTA:** Visit site. **Landing page:** /manufacturing.
- **Compliance:** "Next to Tally" means alongside; no Tally integration is built (connector planned). Do not show Tally's logo.
- **Earliest run:** Phase C remarketing only (to site visitors) to keep spend low.

#### 13. 15 s non-skippable (partners): "Your client said no to the cloud"
- **Audience:** ICP 2 (custom segments: Power Apps tutorials viewers, India first).
- **Script (EN):** 0-4 s text on black: "Client wants apps. Won't use the cloud." 4-11 s fast cuts: formula bar, security roles, environments picker, installer finishing "Done". VO: "Canvas apps, Excel-style formulas, row and column security, on their own server." 11-15 s "Founding partners wanted · <NAME>".
- **CTA:** Apply. **Landing page:** /partners.
- **Compliance:** No Microsoft names or UI in the creative.
- **Earliest run:** Phase C.

#### 14. 45 s skippable: "Build a breakdown log, start to finish" (EN and Hinglish versions)
- **Audience:** ICP 1 and ICP 3.
- **Insight:** A complete, unedited-feeling build convinces more than claims.
- **Hook (first 5 s, before skip):** "45 seconds. One breakdown register. No code." Timer on screen.
- **Script:** 5-15 s Start with data: create table "Breakdowns" (Machine, Fault, Reported at, Closed at). 15-25 s formula column `Closed at - Reported at` labelled "Repair time". 25-33 s role "Technician" sees own rows only; "Test as user". 33-40 s scheduled weekly report to the owner. 40-45 s end card + "Phone entry and WhatsApp alerts: planned".
- **Hinglish VO:** "45 second. Ek breakdown register. Bina coding." ... "Technician sirf apni entries dekhega." ... "Owner ko har hafte email."
- **CTA:** Apply (design partner). **Landing page:** /design-partner.
- **Compliance:** Recording must be a real build (sped up allowed, marked "2× speed"); planned features card mandatory.
- **Earliest run:** Organic Phase A (YouTube upload); paid Phase C.

#### 15. 45 s skippable: "Founder note" (EN; Hindi subtitles)
- **Audience:** ICP 2 and early adopters; remarketing.
- **Hook:** Founder to camera in a small office: "I'm building this alone, and I'll tell you what doesn't work yet."
- **Script:** 5-20 s who the founder is (Bhopal, Power Platform background; state only facts the owner approves). 20-35 s three real screens. 35-45 s "What's not built: phone layouts, PDF, WhatsApp. If you want to shape it, apply as a design partner."
- **CTA:** Apply. **Landing page:** /about.
- **Compliance:** Founder credentials must be exact (no "ex-Microsoft" or similar unless true). No customer claims.
- **Earliest run:** Phase A organic after employment ends; paid only as remarketing in Phase C.

### Google search ads (responsive search ads)

Lines are checked against limits (H ≤30, D ≤90, path ≤15) in this file. `<NAME>` is not used in headlines until its
length is known.

#### 16. Ad group "self-hosted low code" (ICP 2/3, English)
- **Keywords (phrase/exact):** self hosted low code platform; on premise low code; self hosted app builder; low code platform on premise.
- **Insight:** These searchers already know the category and want the deployment model.
- H: Self-Hosted App Builder
- H: Apps on Your Own Server
- H: Excel-Style Formulas
- H: Row & Column Level Security
- H: Dev, Test & Prod Environments
- H: Windows & Linux Installers
- H: Backup & Restore Built In
- H: Data Stays On Your Premises
- H: Version 0.5 Early Access
- H: See Real Screens & Docs
- D: Build business apps by drag and drop with Excel-like formulas. Install on your own server.
- D: Roles with row- and column-level security, two-step sign-in, dev/test/prod environments.
- D: Early access for consultants and small teams. Flows and approvals are in progress.
- D: Read the install guide, see real screens, then join the waitlist or apply as a partner.
- P: self-hosted
- P: early-access
- **CTA / landing page:** /self-hosted (category page with honest status list).
- **Compliance:** "Data stays on your premises" is true only for self-hosted installs (not for any future hosted option); remove if a hosted plan is added.
- **Earliest run:** Phase C (₹25k tier test).

#### 17. Ad group "on-prem alternative" (ICP 2; competitor-adjacent keywords, no trademarks in ad text)
- **Keywords:** power apps alternative on premise; on premise alternative to power apps; zoho creator alternative self hosted. (Bidding on competitor terms is legal in Google Ads in general, but trademark use in ad text is restricted; keep the ad text generic. Decide with the lawyer.)
- H: Need Apps Without the Cloud?
- H: Canvas Apps, Self-Hosted
- H: Formulas Like Excel
- H: One Install, Your Server
- H: Row & Column Security Built In
- H: Honest Feature List Inside
- H: Founding Partners Wanted
- D: Self-hosted app platform with Excel-style formulas, a built-in database and environments.
- D: See exactly what is built, in progress and planned before you spend an hour on it.
- D: Comparison pages with sources and a "when the other tool is better" section.
- P: compare
- P: self-hosted
- **Landing page:** /compare (fair comparison hub, [strategy.md §3](strategy.md)).
- **Compliance:** No claims of being cheaper until pricing exists.
- **Earliest run:** Phase C, after comparison pages are live.

#### 18. Ad group "OEE calculator" (ICP 1; English + Hindi)
- **Keywords:** oee calculator excel; oee calculation formula; oee format excel; production oee calculation.
- H: Free OEE Calculator (Excel)
- H: OEE Formula With Examples
- H: Availability x Perf x Quality
- H: Hindi & English Labels
- H: Downtime Pareto Included
- H: For Small Plants
- H: No Sign-Up to Download
- D: Free Excel OEE calculator for small plants: availability, performance, quality, Pareto.
- D: Standard OEE formulas with a worked example. Download free, no sign-up needed.
- D: Outgrown Excel? See how the same sheet becomes an app on your own PC (early access).
- P: oee
- P: calculator
- **Hindi variant:** H: `फ्री OEE कैलकुलेटर (Excel)` · H: `OEE फॉर्मूला उदाहरण के साथ` · D: `छोटी फैक्ट्रियों के लिए फ्री Excel OEE कैलकुलेटर। उपलब्धता, परफॉर्मेंस, क्वालिटी।`
- **Landing page:** /oee-calculator.
- **Compliance:** Calculator must be ungated as promised.
- **Earliest run:** Phase B/C (cheapest intent test; ₹5-10k).

#### 19. Ad group "breakdown register" (ICP 1)
- **Keywords:** breakdown register format; machine breakdown report format; preventive maintenance checklist excel; mttr mtbf calculation excel.
- H: Breakdown Register Template
- H: Free PM Checklist (Excel)
- H: MTTR & MTBF Formulas Inside
- H: Printable and Excel Formats
- H: From Register to App
- D: Free breakdown register and preventive maintenance checklist with MTTR and MTBF formulas.
- D: Use it on paper or Excel. When you outgrow it, build the same register as an app.
- P: maintenance
- P: templates
- **Landing page:** /maintenance-templates.
- **Earliest run:** Phase B/C.

### WhatsApp status / poster for partner networks (1080×1920 status; 1080×1350 poster)

Distributed only by partners to their own opted-in contacts or as their own status; never bulk-sent by us.

#### 20. "Tally partner: offer your clients the shop floor"
- **Audience:** Tally partners and their clients (ICP 1).
- **Insight:** Tally partners already visit SME offices and get asked "can Tally do production/QC?".
- **Copy (EN):** `Tally runs the accounts. What runs the shop floor? Breakdown, QC and production registers as apps on the client's own PC. Ask [Partner name] for a demo.`
- **Hinglish:** `Accounts Tally mein. Shop floor kis mein? Breakdown, QC, production register, apps ke roop mein, client ke apne PC par. Demo ke liye [Partner name] se poochhein.`
- **Hindi (Devanagari):** `हिसाब-किताब Tally में। शॉप फ्लोर किसमें? ब्रेकडाउन, QC और प्रोडक्शन रजिस्टर अब ऐप में, आपके अपने कंप्यूटर पर। डेमो के लिए [Partner name] से संपर्क करें।`
- **Visual:** Vertical poster. Top third: a desk PC showing a generic accounting screen (blurred, no Tally UI or logo) beside a laptop showing the `<NAME>` production table. Middle: three icons (wrench, magnifier with tick, factory). Bottom 35% empty except partner name/number band. Tag: "Example screen".
- **CTA:** "Demo ke liye message karein" with the partner's number.
- **Landing page:** none (partner's number) or /partners/[partner-slug] with consent.
- **Compliance:** The partner sends only to people who opted in to the partner's messages. No Tally trademark beyond factual mention; no "integrated with Tally".
- **Earliest run:** Phase C (partner programme live).

#### 21. "Clinic invite"
- **Audience:** Association members (posted by the association secretary in the association's own group, with the association's permission).
- **Copy (Hinglish):** `Excel-se-App Clinic · [Date], [Time] · [Venue], Govindpura. 2 ghante: factory ke 7 register, ek live demo, aapka free scorecard. Free, chai ke saath. Register: [QR/link]`
- **Hindi:** `एक्सेल-से-ऐप क्लिनिक · [तारीख], [समय] · [स्थान]। 2 घंटे: फैक्ट्री के 7 रजिस्टर, लाइव डेमो, आपका फ्री स्कोरकार्ड। निःशुल्क, चाय के साथ। रजिस्टर करें: [QR]`
- **Visual:** Warm ochre background; illustration of a register morphing into a laptop screen; big date block; QR bottom-right; association's name only if they agree.
- **CTA:** Scan QR to register (registration form has consent boxes).
- **Compliance:** Posted by the association, not added by us to any group.
- **Earliest run:** Phase A (after employment ends).

#### 22. "Freelancer: on-prem option" (partner network status, English)
- **Audience:** Power Platform freelancers' own networks (they share it).
- **Copy:** `Client wants apps but won't use the cloud? I now build on <NAME>: self-hosted, Excel-style formulas, row/column security. DM me.`
- **Visual:** 1080×1920; dark background, formula bar screenshot centre, freelancer's name and photo (their own) bottom band.
- **Compliance:** The freelancer's own claims about their services are theirs; we supply only accurate product lines.
- **Earliest run:** Phase C.

### Print flyer for an industrial-area trade body event (A5, two-sided)

#### 23. "Your registers, as apps" (A5 front/back, bilingual)
- **Audience:** ICP 1 at an association meeting or clinic.
- **Front (Hindi headline, English sub):**
  - Headline (Devanagari): `आपके रजिस्टर, अब ऐप में। आपके अपने कंप्यूटर पर।`
  - Sub (EN): `Production · Rejection · Breakdown · PM · Indent — as apps your team can use, with "who sees what" built in.`
  - Visual: A worn register on the left turning into a laptop screen on the right (illustration, not a photo of a real customer site); real screen inset with "उदाहरण / Example" tag.
- **Back:**
  - What works today (EN + Hindi bullets): self-hosted install on your PC/server; Excel-like formulas; roles with row and column access; nightly backup and restore; scheduled email reports.
  - What is coming (labelled `जल्द / Planned`): phone screens, WhatsApp alerts, PDF, ready templates.
  - Offer: `3 design-partner places in [cluster] · डिज़ाइन पार्टनर के लिए 3 जगह`.
  - QR to /design-partner?src=flyer-[event]; founder name, address, phone; "Version 0.5".
- **CTA:** Scan QR.
- **Compliance:** "Planned" box mandatory; no prices; printed version date in footer.
- **Earliest run:** Phase A (after employment and name clearance).

#### 24. "Shop-floor scorecard" (A4 single sheet, fill-in)
- **Audience:** ICP 1 at a clinic or association event.
- **Copy:** Title `How digital is your shop floor? (5 minutes)` / Hindi `आपका शॉप फ्लोर कितना डिजिटल है? (5 मिनट)`. 20 yes/no questions in 5 boxes (production, quality, maintenance, stores, approvals); score bands 0-40 / 41-70 / 71-100 with next steps; bottom strip: QR for the free templates and the clinic; small `<NAME>` logo area.
- **Visual:** Clean form layout, factory-grey and ochre, large tick boxes usable with a pen.
- **CTA:** Scan for your detailed result + free templates.
- **Compliance:** Scoring is our own model ("not an industry standard" in the footer).
- **Earliest run:** Phase A.

---

## 3. Landing-page headline and subhead variants (A/B tests)

Test one variable at a time; minimum ~100 conversions per variant before calling a winner is ideal, which a small site
will not reach quickly, so treat early results as directional (**Assumption**).

| # | Audience | Headline | Subhead |
|---|---|---|---|
| A | ICP 1 | Your business apps, on your own computer. | Turn production, quality and breakdown registers into apps your team can use, with "who sees what" built in. Version 0.5, early access. |
| B | ICP 1 | The work Tally doesn't cover, in apps your team can use. | `<NAME>` runs next to Tally on your own PC or server. Start with one register; we'll build it with you. |
| C | ICP 1/3 | From Excel sheet to secure-by-role app, on your own server. | Excel-like formulas, roles with row and column access, nightly backups you control. No code, no cloud required. |
| D | ICP 3 | If you can write an Excel formula, you can build this. | Drag-and-drop screens, Excel-like formulas, a built-in database with permissions. Installed once, on your machine. |
| E | ICP 2 | Canvas apps your clients can host themselves. | A self-hosted app platform with Excel-style formulas, row/column security and dev/test/prod. Founding partners wanted. |

Note on C: "secure-by-role" describes the role mechanism; if the lawyer or reviewer objects to the word "secure",
use "From Excel sheet to app with permissions, on your own server."
