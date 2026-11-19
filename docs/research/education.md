# Sector research: educational institutes (schools, coaching institutes, colleges; India focus)

> **Product facts in this research are dated 18 Nov 2026 (version 0.3).** Since then the platform moved to PostgreSQL, removed the 5,000-row limit, and added password reset, two-step verification, environments, flows and more. For current product facts use `docs/launch/BRIEF.md`. The market findings are unchanged.


Research date: 18 November 2026. Prices, laws and product status were checked on that date where a source is linked. Anything marked **Inference** is the author's judgement, not a sourced fact. Anything marked **Unverified** could not be confirmed.

## Executive summary

1. The school ERP market in India is crowded and cheap. Entab claims [2,500+ schools](https://entab.in/school-erp-software.html); Teachmint [bought MyClassCampus in January 2022](https://www.freepressjournal.in/business/teachmint-acquires-education-erp-player-myclasscampus-its-fourth-acquisition); a 2026 cost guide puts typical SaaS at [roughly ₹50-600 per student per year](https://codingclave.com/guides/school-management-software-cost-india-2026) (secondary source).
2. Every incumbent ships a parent/teacher **mobile app**, fee collection through a payment gateway, and SMS/WhatsApp notices. These are table stakes; Appbuilder has none of them today.
3. The parents are the largest user group, and they are on phones. A desktop-landscape-only platform can serve the office (admissions desk, accounts, exam cell) but not parents, teachers in class, or transport.
4. Fees are the money flow and the decision driver: fee reminders, online payment, receipts and dues ageing are must-have automations.
5. National systems shape the data model: schools submit [UDISE+ data each year](https://educationforallinindia.com/udise-2026-27-answers-to-the-questions-parents-teachers-and-school-heads-are-actually-asking/), every student has an 11-digit PEN, and schools generate the 12-digit [APAAR ID with parental consent](https://news.careers360.com/apaar-id-12-digit-registration-form-consent-academic-bank-of-credits-abc-digilocker-login-cbse-ugc-udise-school-nep-2020-faqs), which links to the Academic Bank of Credits and DigiLocker.
6. DPDP is the strongest regulatory change: verifiable parental consent for under-18s (Rule 10) applies from about **13 May 2027**, with a [Fourth Schedule carve-out](https://www.dpdpa.com/schedule/schedule4.html) for educational institutions' tracking and monitoring for education and safety. Proposed shortening of the timeline had [not been notified as of Oct 2026](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts).
7. Appbuilder's row- and column-level security is a genuine strength here (teacher sees own sections, parent sees own child, medical and concession columns restricted), and DPDP gives it a story.
8. KPIs are simple and mostly ratios: attendance rate, chronic absenteeism (10%+ days missed, a [US definition](https://www.ed.gov/teaching-and-administration/supporting-students/chronic-absenteeism)), fee collection efficiency, dues ageing, admission conversion, pass percentage, PTR (RTE norm [30:1 primary, 35:1 upper primary](https://dsel.education.gov.in/sites/default/files/update/Student-Teacher-Ratio.pdf)).
9. **Inference:** a general low-code platform should not try to beat ready-made school ERPs at full scope. Ready-made wins for K-12 schools. A narrower wedge exists in (a) coaching institutes and multi-branch groups with non-standard processes, (b) colleges and trusts with odd workflows (hostel, placements, accreditation evidence), and (c) DPDP-ready consent and records apps.
10. First three templates: (1) Admission enquiry CRM + application, (2) Fee ledger with dues ageing and reminders, (3) Attendance + parent notice. Each needs flows plus WhatsApp to be sellable; (2) also needs a payment gateway.

---

## 1. Apps institutes need

Fit ratings are for the current Appbuilder (desktop landscape, MySQL, roles with row and column security, attachments, no flows, no mobile layout, no offline mode). "Today" reflects common practice; where no source is linked it is **Inference**.

| Function | App | Main users | Core screens | What they use today | Fit now | Why |
|---|---|---|---|---|---|---|
| Admissions | Enquiry CRM, application, test/interview, offer, enrolment | Admission counsellor, principal | Enquiry list with follow-up dates, application form, document upload, status board | Registers, Excel, WhatsApp, ERP enquiry modules (e.g. [Entab admissions](https://entab.in/school-erp-software.html)) | Good (office), partial (online form for parents) | Desk work fits; public application form needs a web/mobile page |
| Student information (SIS) | Student master, guardians, documents, TC | Office staff | Student profile, guardian, siblings, documents, transfer certificate | ERP, Excel, paper files; UDISE+ portal for government returns | Good | Classic desktop forms + attachments; TC needs PDF |
| Attendance | Daily or period attendance, leave | Teachers, class teacher, office | Class register grid, absentee list, monthly summary | Paper register, ERP app, QR/biometric in some ([MyClassCampus lists QR attendance](https://softwarereview.com/s/myclasscampus)) | Partial | Teachers mark in class on a phone |
| Fees | Fee structure, concessions, invoices, receipts, dues, online payment | Accountant, parents | Fee heads by class, student ledger, receipt, dues report, concession approval | ERP fee module, Tally for books, Excel, cash counter | Partial | Ledger and reports fit; parents pay on phone via gateway (missing) |
| Timetable | Class and teacher timetable, substitutions | Timetable in-charge | Grid editor, clash check, substitution | Excel, ERP generators (Fedena lists a [timetable generator](https://www.softwareadvice.com/school-management/fedena-profile/)) | Partial | Grid fits desktop; automatic generation is an algorithm, not low-code |
| Exams & grades | Exam schedule, marks entry, report card | Exam cell, teachers | Marks grid by subject/section, grade rules, report card | ERP, Excel; board-specific report-card formats | Partial | Marks grid fits; report card needs PDF with board formats |
| Homework / LMS-lite | Assignments, notes, submissions | Teachers, students | Assignment post, submission list | WhatsApp groups, Google Classroom, Teachmint, Classplus | Poor | Student-facing, mobile, content-heavy; free tools dominate |
| Communication | Circulars, notices, PTM booking, complaints | Office, parents | Notice composer, delivery status, PTM slots | WhatsApp groups, SMS, ERP apps | Poor | Needs messaging and parent app |
| Transport | Routes, stops, vehicle documents, student-route mapping, GPS | Transport in-charge, parents | Route master, student allocation, vehicle compliance | Excel, GPS vendor apps | Partial (masters), poor (tracking) | Live GPS and parent tracking are mobile/hardware |
| Library | Catalogue, issue/return, fines | Librarian | Book master, issue desk, overdue list | ERP module, Excel, open-source (Koha in colleges, **Unverified**) | Good | Desk app, barcode scanner works as keyboard |
| Hostel | Rooms, allocation, mess, leave/outpass, visitors | Warden | Room board, allocation, outpass, mess attendance | Registers, Excel | Partial | Desk work fits; outpass approvals need flows and parent alerts |
| Staff & payroll | Staff master, attendance, leave, payroll | HR, accounts | Staff profile, leave, salary sheet | Tally payroll, Excel, ERP HR ([Entab lists HR and payroll](https://entab.in/school-erp-software.html)) | Partial | Payroll rules and statutory deductions are better bought |
| Inventory/assets | Stationery, uniform/book sales, lab assets | Store | Stock, sales to students | Excel | Good | Small desktop app |
| Compliance & reporting | UDISE+ data prep, APAAR status, CBSE mandatory disclosure, accreditation (NAAC for colleges) | Principal, office, IQAC | Checklists, evidence uploads, data exports | Manual compilation | Good | Structured data + attachments + exports is what low-code does well |
| Coaching-specific | Batches, leads, test series, performance ranking, fee instalments | Coaching owner, counsellors | Lead pipeline, batch board, test results, instalment tracker | Classplus, Teachmint, Excel, WhatsApp | Partial | Office side fits; student app side does not |

## 2. Automations

| # | Trigger | Action | Must-have? |
|---|---|---|---|
| 1 | Fee instalment due in 7 days / due today / overdue 15 days | WhatsApp/SMS reminder with pay link; escalate to accountant list | Must-have |
| 2 | Payment captured by gateway (webhook) | Mark paid, generate receipt PDF, send to parent | Must-have (where online fees offered) |
| 3 | Student marked absent | Same-day message to parent | Must-have for schools |
| 4 | New enquiry (web form, call, walk-in) | Assign counsellor; schedule follow-up; reminder if not contacted in 24 h | Must-have for admissions template |
| 5 | Fee concession requested | Approval by principal/trust; lock record; audit | Must-have |
| 6 | Marks finalised for a term | Generate report cards (PDF) in bulk; publish to parents | Must-have for exam module |
| 7 | Monthly / daily 8 am | Collection summary, defaulters list, attendance summary to principal and owner | Must-have |
| 8 | Leave / hostel outpass request | Approval chain (class teacher → warden); notify parent | Wanted |
| 9 | Student attendance falls below 75% (common board/university eligibility rule, **Unverified** per board) | Warn student, parent and mentor | Wanted |
| 10 | Vehicle insurance/fitness/permit expiry in 30 days | Remind transport in-charge | Wanted |
| 11 | Receipts and fee income | Post summarised entries to Tally | Wanted (many schools keep accounts in Tally) |
| 12 | Biometric or RFID punch | Mark attendance automatically | Wanted |
| 13 | Child turns 18 / guardian consent withdrawn | Re-seek consent from the student or restrict processing (DPDP) | Needed by May 2027 (**Inference**) |

Messaging and payments constraints: WhatsApp Business Platform charges per template message since [1 July 2025](https://developers.facebook.com/docs/whatsapp/pricing/). Indian SMS requires DLT registration of the entity, sender header and every template; promotional SMS is limited to 10 am-9 pm and since October 2024 [URLs must be whitelisted](https://www.messagecentral.com/sms-guideline/india) (vendor summary). Razorpay's standard rate is a [2% platform fee plus GST, including on UPI, with no setup fee, and education uses the same standard rate](https://razorpay.com/blog/payment-gateway-pricing-by-business-category-india/). A 2026 cost guide estimates [messaging at ₹0.15-0.50 per message](https://codingclave.com/guides/school-management-software-cost-india-2026) (secondary).

## 3. KPIs

| KPI | Formula | Data needed | Definition source |
|---|---|---|---|
| Attendance rate | Days (or periods) present ÷ days (or periods) scheduled, per student, section, school | Daily attendance, school calendar | Common definition |
| Chronic absenteeism | Share of students missing at least 10% of school days (excused or not) | Attendance per student | [US Dept of Education](https://www.ed.gov/teaching-and-administration/supporting-students/chronic-absenteeism) (no single Indian standard found) |
| Fee collection efficiency | Fees collected in period ÷ fees billed (due) in period | Fee invoices, receipts | Common finance definition (not a formal standard) |
| Outstanding dues ageing | Dues bucketed by days overdue: 0-30, 31-60, 61-90, 90+ | Invoice due dates, receipts | Common accounts-receivable practice |
| Concession ratio | Concessions and waivers ÷ gross fees billed | Concession records | Common definition |
| Admission funnel conversion | Enrolled ÷ enquiries; also stage-to-stage (enquiry → visit → application → offer → enrolled) | Enquiry and application status with dates | Common sales-funnel definition |
| Cost per admission | Marketing spend ÷ new enrolments | Spend by channel, enquiry source | Common definition |
| Pass percentage | Students passing ÷ students appeared (per exam, subject, section) | Marks, pass rules | Common definition; boards publish rules |
| Average score / grade distribution | Mean marks; share in each grade band | Marks | Common definition |
| Pupil-teacher ratio (PTR) | Pupils ÷ teachers at a level | Enrolment, teacher count | [UDISE+ definition](https://educationforallinindia.com/codes-concepts-definitions-of-udiseplus/); RTE norm 30:1 primary, 35:1 upper primary; RMSA 30:1 secondary ([MoE](https://dsel.education.gov.in/sites/default/files/update/Student-Teacher-Ratio.pdf)) |
| Promotion / repetition / dropout rate | Share of a grade's cohort that next year is in the next grade / same grade / not enrolled anywhere | Year-on-year student status | [UDISE+ concepts](https://educationforallinindia.com/codes-concepts-definitions-of-udiseplus/) |
| Retention (school) | Share of a first-grade cohort expected to reach the last grade of the level | Cohort data | [UDISE+ concepts](https://educationforallinindia.com/codes-concepts-definitions-of-udiseplus/) |
| Re-enrolment rate (private school) | Students re-enrolled for next year ÷ eligible students (excluding final grade) | Year-end status | Common definition (**Inference**: the private-school version of retention owners watch) |
| Teacher attendance / substitution load | Teacher days present ÷ scheduled; substitutions per teacher | Staff attendance, substitutions | Common definition |
| Transport utilisation | Students on route ÷ seats | Route allocation, vehicle capacity | Common definition |
| Coaching: test score improvement, batch fill rate | Change in mean test score per student; enrolled ÷ batch capacity | Test results, batch capacity | Common definition |

## 4. Data model

### Standards, checked

- **UDISE+** is the Ministry of Education's national school database covering every recognised school; schools fill an annual school-level Data Capture Format and maintain student records (admission, progression, transfer, exit) in a student module; the 2026-27 entry deadline was [30 September 2026](https://educationforallinindia.com/udise-2026-27-answers-to-the-questions-parents-teachers-and-school-heads-are-actually-asking/). Each student gets an **11-digit PEN** that follows them across schools ([same source](https://educationforallinindia.com/udise-2026-27-answers-to-the-questions-parents-teachers-and-school-heads-are-actually-asking/)).
- **APAAR ID** is a 12-digit lifelong academic ID; schools generate it after verifying details and obtaining parental consent for minors, with Aadhaar-based authentication; the ministry says it is not legally mandatory, though states were told to create IDs in schools ([Careers360](https://news.careers360.com/apaar-id-12-digit-registration-form-consent-academic-bank-of-credits-abc-digilocker-login-cbse-ugc-udise-school-nep-2020-faqs)).
- **Academic Bank of Credits (ABC)** is a digital store of students' academic credits launched in 2021; for higher education the APAAR and ABC IDs are used interchangeably, and the APAAR card appears in DigiLocker ([Careers360](https://news.careers360.com/apaar-id-12-digit-registration-form-consent-academic-bank-of-credits-abc-digilocker-login-cbse-ugc-udise-school-nep-2020-faqs)).
- **OneRoster 1.2** (1EdTech) exchanges rosters (users, courses, classes, enrolments, organisations), gradebook data and resource assignments between systems such as an SIS and an LMS, through CSV files or REST ([1EdTech](https://www.1edtech.org/standards/oneroster)). Used mainly in the US and some other regions; not common in Indian schools (**Inference**).
- **Ed-Fi** is an open K-12 data standard (not software) with a unifying data model covering enrolment, demographics, attendance, assessment, courses and sections, staff, discipline and more; used by state education agencies and districts ([Ed-Fi docs](https://docs.ed-fi.org/reference/data-exchange/data-standards)). US-centric.

**Inference:** for India, store PEN, APAAR ID and UDISE school code as fields and make exports match UDISE+ student-module fields. Borrow entity names from OneRoster (org, academic session, course, class/section, enrolment, line item, result) so a future OneRoster CSV export for international schools is cheap.

### Proposed core schema

| Table | Key fields | Relations | RLS | Column security |
|---|---|---|---|---|
| org (trust, campus/branch) | id, parent_id, name, udise_code, board, affiliation_no | self-hierarchy | Staff see own branch; trust admin sees all | — |
| academic_session | id, org_id, name, start, end | 1-n term | All | — |
| grade / section | id, grade, section, class_teacher_id, capacity | n-1 session | Teacher sees own sections | — |
| subject / course | id, name, code, board_code | n-n section via class_subject | All | — |
| class_subject (OneRoster "class") | section_id, subject_id, teacher_id, periods_per_week | links teacher to section+subject | Teacher own | — |
| student | id, admission_no, name, dob, gender, pen, apaar_id, aadhaar_ref, category, photo, status | 1-n enrolment, guardian_link | Teacher: students in own sections; parent: own child; student: self | Aadhaar ref, category/caste, medical, disability, photo (restricted) |
| guardian | id, name, relation, phone, email, occupation, income | n-n student | Parent sees self | Income, phone (limited to office and class teacher) |
| consent_record | student_id, guardian_id, purpose, method (e.g. DigiLocker token / existing ID), given_at, withdrawn_at, evidence | n-1 student | Office, DPO | — |
| enrolment | student_id, section_id, session_id, roll_no, start, end, exit_reason | n-1 student, section | As student | — |
| attendance | student_id, date, period, status, marked_by | n-1 enrolment | Teacher own sections; parent own child | — |
| timetable_slot | section_id, day, period, class_subject_id, room | n-1 section | All (read) | — |
| exam / assessment / mark | exam: session, term, type; mark: student_id, class_subject_id, max, obtained, grade | n-1 student | Teacher own class_subjects (edit until locked); parent own child after publish | — |
| enquiry / application | id, child_name, dob, guardian contact, source, stage, counsellor_id, next_follow_up | → student on enrolment | Counsellor own leads | Guardian contact (sales staff only) |
| fee_structure / fee_head | session, grade, head, amount, due_dates | 1-n fee_invoice | Accounts | — |
| fee_invoice / fee_line | student_id, head, amount, due_date, concession_id | n-1 student | Accounts; parent own child | Concession amount and reason (accounts, principal) |
| concession | student_id, type (sibling, staff ward, RTE 25%, merit, hardship), pct, approved_by | n-1 student | Accounts, principal | Whole table restricted; reason is sensitive |
| receipt / payment | invoice_id, amount, mode, gateway_txn_id, received_at, receipt_no | n-1 invoice | Accounts; parent own | — |
| staff | id, emp_code, role, qualifications, joining | 1-n class_subject | HR; teachers see own | Salary, bank, PAN, Aadhaar, police verification |
| transport_route / stop / vehicle / student_route | route, stop times, vehicle docs, driver | n-n student | Transport; parent own child's route | Driver phone, licence (restricted) |
| library_item / loan | accession_no, title, status; loan dates, fine | n-1 student/staff | Librarian; borrower own | — |
| hostel_room / allocation / outpass | room, bed; student; outpass times, approvals | n-1 student | Warden; parent own child | — |
| health_record | student_id, allergies, conditions, medication, emergency contact | 1-1 student | Nurse, class teacher (limited view) | Whole table restricted |
| notice / message_log | audience, channel, template, sent_at, delivered | — | Office | Message content to parents |
| audit_log | who, when, table, row, before/after | all | Admin, DPO | — |

### Data volumes (Inference, for a 1,500-student single school with 80 staff)

| Table | Rows per year |
|---|---|
| attendance (daily) | ~300k (1,500 × ~200 days); period-wise: ~2 million |
| mark | 50k-150k (1,500 × 8 subjects × 4-10 assessments) |
| fee_line + receipt | 20k-60k |
| message_log | 100k-500k |
| enquiry | 1k-5k |
| library loans | 5k-20k |

Coaching institutes have fewer rows per student but higher churn and more leads. Multi-branch groups multiply all of this. **Implication:** Appbuilder's current [5,000-row load cap per table](../../README.md#known-limits) is exceeded by attendance within days; server-side filtering, paging and aggregates are mandatory.

## 5. Architecture and deployment

**How they deploy (Inference unless linked).** Small schools and coaching centres are moving to SaaS with a branded mobile app; older and larger schools still have on-premise ERP installs (Entab itself [started on-premise and moved to SaaS](https://yourstory.com/2020/12/delhi-school-management-startup-entab)). Campus internet is usually adequate in cities, patchy in tier-3 towns. The office has desktops; teachers and parents use Android phones.

**Integrations they expect:** payment gateway (Razorpay, PayU, bank gateways) with webhooks and auto-reconciliation; WhatsApp Business API and DLT-compliant SMS; Tally export of fee income ([Fedena lists Tally integration](https://www.softwareadvice.com/school-management/fedena-profile/)); biometric/RFID/QR attendance; GPS for buses; Google Workspace or Microsoft 365 accounts; UDISE+-shaped exports. Cost guide estimates for add-ons such as a branded app (₹20-80k) and biometric points (₹20-80k each) are in [Codingclave's 2026 guide](https://codingclave.com/guides/school-management-software-cost-india-2026) (secondary, rough).

**Mobile vs desktop split.** By headcount, most users are parents and students, all mobile. Teachers are mostly mobile. The office (admissions, accounts, exam cell, principal) is desktop. **Inference:** a desktop platform covers perhaps 10% of users but most of the admin work.

**Multi-branch.** Common for school chains and coaching brands; needs branch-scoped security, central fee policies and consolidated reports.

**Regulation:**

- **DPDP Act 2023 and Rules 2025.** Rules were notified on 14 November 2025 ([Wikipedia summary](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025)). Board-related rules applied at once; consent-manager registration on 13 November 2026; most other rules, including notice and consent (Rule 3), security safeguards (Rule 6), breach notification (Rule 7), retention (Rule 8) and **verifiable parental consent (Rule 10)**, from 13 May 2027 ([dcomply rule table](https://dpdpa.dcomply.in/rules/); [The Privacy Labs](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts)). A January 2026 MeitY proposal to cut the runway to 12 months had **not** been notified as of October 2026 ([The Privacy Labs](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts); [MirvoLegal](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/)) — re-check the Gazette before relying on the date.
  - The Act bars tracking, behavioural monitoring and targeted advertising directed at children; parents must give verifiable consent, which may be checked against identity details the organisation already holds or a virtual token from an authorised entity ([S.S. Rana](https://ssrana.in/articles/schools-coaching-centres-platforms-processing-childrens-data-are-you-compliant/)).
  - The Fourth Schedule exempts **educational institutions** from the consent and monitoring bans only for tracking and behavioural monitoring for educational activities or the safety of enrolled children, and **transport providers** engaged by schools for location tracking during travel ([DPDPA.com Schedule 4](https://www.dpdpa.com/schedule/schedule4.html)). Whether coaching centres count as "educational institutions" is unclear ([S.S. Rana](https://ssrana.in/articles/schools-coaching-centres-platforms-processing-childrens-data-are-you-compliant/)).
  - Breach: notify the Board without delay, with a full report within 72 hours; logs kept at least one year; security measures include encryption, access control, activity logs and backups ([MirvoLegal](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/)).
  - **Inference:** fee collection, attendance and report cards are core educational activity, but marketing to parents, sharing photos for advertising and analytics beyond education still need consent. A consent register, purpose tags, audit trail and column security are concrete product features to sell.
- **School boards.** CBSE schools must publish mandatory disclosures (affiliation, safety certificates, three years of results, fee structure, teacher details, infrastructure) on their website under the 2018 affiliation bye-laws; compliance has been poor ([Careers360](https://news.careers360.com/how-many-schools-violate-cbse-regulations-on-mandatory-disclosures)). CBSE has also [mandated CCTV in affiliated schools](https://www.freepressjournal.in/education/cbse-mandates-cctv-installation-in-all-affiliated-schools-for-enhanced-safety) (details not read).
- **Coaching centres.** The 2024 Ministry of Education guidelines bar enrolling students under 16, require registration, pro-rata fee refunds on early exit, counselling systems, and a website showing tutor qualifications, courses, duration, hostel and fees; penalties are ₹25,000 then ₹1 lakh then cancellation; states implement them ([Drishti IAS summary](https://www.drishtiias.com/daily-updates/daily-news-analysis/moe-guidelines-for-coaching-centres/print_manually)). **Inference:** refund calculation and disclosure pages are small template features with compliance pull.
- **GST.** Core school education fees are generally GST-exempt while coaching fees are taxable (**Unverified** here; confirm with a CA). If coaching invoices are taxable, the same 72-month record rule as manufacturing applies.

## 6. Gap analysis against Appbuilder

Already covered: relational student/fee/marks tables on MySQL; desktop forms and grids; formulas for grade and fee rules; row filters with own-row scope and column access (strong match for teacher/parent/medical/concession rules); attachments for documents; CSV/Excel import for migrating existing spreadsheets; basic charts; audit log; solution packaging for templates.

Ranked by how much each gap blocks a sale (**Inference**):

| Rank | Gap | Why it blocks | Notes |
|---|---|---|---|
| 1 | Parent/teacher mobile experience | Every competitor has a parent app; parents are the visible customer | Portrait/responsive layouts at minimum; a PWA may be enough for v1 |
| 2 | Multi-user hosting (PHP gateway) and multi-tenant hosting | Parents and teachers connect over the internet; a reseller needs many schools on one host | Single-PC server today |
| 3 | Payment gateway + receipts | Online fee collection is expected; receipts must be automatic | Razorpay webhook + reconciliation |
| 4 | Flows (reminders, approvals, scheduled reports) | Fee reminders and absent alerts are must-haves | Not built |
| 5 | WhatsApp/SMS with DLT templates | The communication channel of Indian schools | BSP integration, template management, delivery logs |
| 6 | PDF generation (receipts, report cards, TC, ID cards) | Printed and shared documents are legal and customary | Board-specific report-card layouts |
| 7 | Server-side paging/aggregation beyond 5,000 rows | Attendance alone exceeds the cap within days | Needed for any real school |
| 8 | Relationship-based row security | "Teacher sees students in sections they teach", "parent sees own children" needs filters through link tables, not only row ownership | **Verify** whether current row filters can express this |
| 9 | Parent/external user accounts at scale | 1,500-5,000 parent logins with OTP sign-in, password reset | No password-reset email or 2FA today |
| 10 | Consent and DPDP features | Consent register, purpose tags, retention/erasure jobs, breach log | Differentiator if built; deadline May 2027 |
| 11 | Bulk operations (promote students to next year, bulk invoice, bulk report cards) | Year-end and term-end workloads | Needs flows or server-side actions |
| 12 | Biometric/RFID/GPS integration | Nice-to-have for most | Partner-led |

### First 3 apps to build as templates

1. **Admission enquiry CRM + application tracker.** Office-only users (fits desktop today), no conflict with the existing ERP (many ERPs do this weakly), revenue-linked (each admission is ₹30k-3 lakh a year for a private school, **Inference**), and seasonal urgency every November-April. Needs follow-up reminders (flows) and WhatsApp.
2. **Fee ledger with concessions, dues ageing and reminders.** The owner's main money question. Uses column security for concessions and row security for parents. Needs flows, WhatsApp and, to be complete, Razorpay and PDF receipts.
3. **Attendance + absent alert + monthly summary.** The highest-frequency daily task and the one parents notice. Needs a phone layout for teachers and the absent-alert flow; proves server-side scale (hundreds of thousands of rows).

These three also form a minimum "school office" bundle that can sit beside an existing ERP or replace it for small coaching centres.

## 7. Market reality check

| Product | What it is (verified) | Price signal |
|---|---|---|
| Entab CampusCare | School ERP: admissions, fees and accounting, exams, attendance/transport, HR/payroll; claims 2,500+ schools ([Entab](https://entab.in/school-erp-software.html)) | Not published; secondary guide estimates ₹25k-4 lakh/year ([Codingclave](https://codingclave.com/guides/school-management-software-cost-india-2026)) |
| Teachmint (incl. MyClassCampus) | ERP + LMS for schools, colleges, coaching; acquired MyClassCampus in Jan 2022 ([Free Press Journal](https://www.freepressjournal.in/business/teachmint-acquires-education-erp-player-myclasscampus-its-fourth-acquisition)); also sells digital boards ([Teachmint](https://www.teachmint.com/pricing)) | Not published; secondary guide: free basic, paid ₹2k-15k/month |
| MyClassCampus | Mobile-first ERP: admissions CRM, fees, exams, QR attendance, timetable, library ([SoftwareReview](https://softwarereview.com/s/myclasscampus)) | Listed per user; secondary guide ₹15k-1 lakh/year |
| Fedena (Foradian) | Long-standing school ERP with Tally integration, timetable generator, form builder; community edition existed ([Software Advice](https://www.softwareadvice.com/school-management/fedena-profile/)) | Listed from $1,299 per feature per year (unclear); recent review activity thin, so current momentum is **Unverified** |
| Classplus | App platform for tutors and coaching (branded app, courses, tests) | ₹19,999-24,999/year per a competitor's article ([Edmingle](https://www.edmingle.com/blog/lms-pricing-in-india/)) |
| ERPNext Education / Odoo / Zoho Creator | General platforms with education modules or templates | See manufacturing file for platform prices |

Price band: a 2026 cost guide estimates ₹50-120 per student per year for budget vendors, ₹120-300 standard and ₹300-600 premium, plus ₹40k-2 lakh migration fees ([Codingclave](https://codingclave.com/guides/school-management-software-cost-india-2026); secondary, internally inconsistent, use only as a rough band). A 1,000-student school therefore pays roughly ₹50k-3 lakh per year.

**Why a school would choose a low-code platform:** unusual processes (trust-run groups with mixed boards, hostels, residential schools, colleges with placement and accreditation work); wanting to own the data and customise without vendor change requests; already outgrown Excel but finding ERPs rigid; DPDP-driven need for tight access control and audit.

**Why it would not:** ready-made school ERPs are cheap per student, come with a parent app, payment gateway, SMS/WhatsApp, report-card formats per board and UDISE-aligned data, and sales teams that visit schools. Principals buy a finished product; nobody on staff will build apps. For a typical CBSE/state-board K-12 school, **ready-made wins**, and Appbuilder would be a worse product at the same price.

**Realistic wedge (Inference):**
- **Coaching institutes and multi-branch tuition chains**: lead-heavy, instalment-heavy, process varies by brand, and ERPs fit poorly. Office-side apps (leads, batches, instalments, refunds per 2024 guidelines) suit a desktop platform; students can stay on WhatsApp or Classplus for content.
- **Colleges and trusts with niche workflows** (hostel outpass, placement cell, NAAC/accreditation evidence, scholarship tracking) as add-ons next to their existing ERP.
- **DPDP readiness**: a consent register, access reviews and audit trail sold to schools before May 2027 is a time-bound opening, provided legal claims are vetted by a lawyer.

Blunt view: do not try to sell a full school ERP built on Appbuilder. Sell office apps to coaching institutes and add-on apps to colleges, and only after flows, WhatsApp, PDFs and a phone layout exist.

## Sources

- [Entab: School ERP software](https://entab.in/school-erp-software.html)
- [YourStory: Entab moves from on-prem to SaaS (2020)](https://yourstory.com/2020/12/delhi-school-management-startup-entab)
- [Free Press Journal: Teachmint acquires MyClassCampus](https://www.freepressjournal.in/business/teachmint-acquires-education-erp-player-myclasscampus-its-fourth-acquisition)
- [Teachmint](https://www.teachmint.com/pricing)
- [SoftwareReview: MyClassCampus](https://softwarereview.com/s/myclasscampus)
- [Software Advice: Fedena profile](https://www.softwareadvice.com/school-management/fedena-profile/)
- [Edmingle: LMS pricing in India 2026](https://www.edmingle.com/blog/lms-pricing-in-india/)
- [Codingclave: School management software cost India 2026](https://codingclave.com/guides/school-management-software-cost-india-2026)
- [Education for All in India: UDISE+ 2026-27 Q&A](https://educationforallinindia.com/udise-2026-27-answers-to-the-questions-parents-teachers-and-school-heads-are-actually-asking/)
- [Education for All in India: UDISE+ codes, concepts and definitions](https://educationforallinindia.com/codes-concepts-definitions-of-udiseplus/)
- [Careers360: APAAR ID explainer](https://news.careers360.com/apaar-id-12-digit-registration-form-consent-academic-bank-of-credits-abc-digilocker-login-cbse-ugc-udise-school-nep-2020-faqs)
- [1EdTech: OneRoster](https://www.1edtech.org/standards/oneroster)
- [Ed-Fi: About the Ed-Fi Data Standard](https://docs.ed-fi.org/reference/data-exchange/data-standards)
- [Ministry of Education: Student-teacher ratio](https://dsel.education.gov.in/sites/default/files/update/Student-Teacher-Ratio.pdf)
- [US Department of Education: Chronic absenteeism](https://www.ed.gov/teaching-and-administration/supporting-students/chronic-absenteeism)
- [Wikipedia: DPDP Rules, 2025](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025)
- [dcomply: DPDP Rules effective dates](https://dpdpa.dcomply.in/rules/)
- [The Privacy Labs: What starts on 13 November 2026](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts)
- [MirvoLegal: DPDP Rules compliance timeline](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/)
- [DPDPA.com: Fourth Schedule](https://www.dpdpa.com/schedule/schedule4.html)
- [S.S. Rana: Schools and coaching centres processing children's data](https://ssrana.in/articles/schools-coaching-centres-platforms-processing-childrens-data-are-you-compliant/)
- [Careers360: CBSE mandatory disclosures](https://news.careers360.com/how-many-schools-violate-cbse-regulations-on-mandatory-disclosures)
- [Free Press Journal: CBSE mandates CCTV](https://www.freepressjournal.in/education/cbse-mandates-cctv-installation-in-all-affiliated-schools-for-enhanced-safety)
- [Drishti IAS: MoE guidelines for coaching centres (2024)](https://www.drishtiias.com/daily-updates/daily-news-analysis/moe-guidelines-for-coaching-centres/print_manually)
- [Razorpay: Payment gateway pricing by business category](https://razorpay.com/blog/payment-gateway-pricing-by-business-category-india/)
- [Meta: WhatsApp Business Platform pricing](https://developers.facebook.com/docs/whatsapp/pricing/)
- [Message Central: India SMS/DLT guidelines](https://www.messagecentral.com/sms-guideline/india)
