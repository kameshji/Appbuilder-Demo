# Legal essentials: research brief for the lawyer and CA

Status: research notes, **not legal or tax advice**. Status date for every law below: **19 November 2026**. Laws,
rates and section numbers in India changed a lot in 2025-2026 (a new Income-tax Act from 1 April 2026, new FEMA
export rules from 1 October 2026, DPDP Rules phasing in to May 2027). A practising lawyer and a chartered
accountant must confirm each point before the founder acts on it.

Labels: **Inference** = our reading, not a sourced statement. **Unverified** = could not confirm from an official
or primary source. Where only a secondary source (law firm, tax portal, vendor blog) was available, it is named
as such.

Context from [BRIEF.md](BRIEF.md): self-hosted business app platform, India-first, one founder in Bhopal who is an
employee serving notice at an Indian IT services company with a no-moonlighting policy until about end of January
2027. Version 0.5.0, no customer, no outside security review.

---

## 1. The founder's employment situation

### 1.1 What the law generally says (India)

- **Restraints during employment are usually enforceable.** Section 27 of the Indian Contract Act voids agreements
  restraining a lawful trade, but the Supreme Court has long treated negative covenants that operate *while* the
  employee must serve exclusively as outside that rule (*Niranjan Shankar Golikari*, 1967; reaffirmed in
  *Superintendence Co. v. Krishan Murgai*, 1981) ([Desai & Diwanji, Dec 2025](https://desaidiwanji.com/insights/articles/validity-of-non-solicitation-and-non-compete-clauses-in-employment-agreements)).
  A no-moonlighting or exclusivity clause during employment, including the notice period, is therefore likely
  enforceable (**Inference**).
- **Post-employment non-competes are generally void** under Section 27; courts protect only confidential
  information and, in narrow cases, non-solicitation of clients and staff. The Delhi High Court restated this in
  *Varun Tyagi v. Daffodil Software* (2025) ([same source](https://desaidiwanji.com/insights/articles/validity-of-non-solicitation-and-non-compete-clauses-in-employment-agreements)).
- **IP assignment is the real risk.** Broad clauses can claim IP created during employment even off-hours on
  personal equipment; narrow clauses cover only work using company resources, related to the employer's business,
  or done in working hours ([LVL1 Accelerator, Sep 2026](https://lvl1accelerator.com/blog/start-startup-while-employed-india-legal/), secondary).
  Under the Copyright Act, 1957, the employer is first owner of works made "in the course of employment" (s.17),
  and any assignment must be in writing (s.19) (**Unverified** here: lawyer to confirm against the Act on India
  Code).
- **Directorships are public.** A director appointment appears in MCA records and may need the employer's consent
  under the code of conduct ([LVL1 Accelerator](https://lvl1accelerator.com/blog/start-startup-while-employed-india-legal/)).

### 1.2 Typical clauses in Indian IT-services contracts (Inference; read the actual contract)

| Clause | Typical content | What it means here |
|---|---|---|
| Exclusivity / no moonlighting | no other employment, business or paid work without written consent | no company, no sales, no paid work until LWD |
| Conflict of interest / code of conduct | disclose outside business interests, directorships, shareholdings | shareholding or directorship before LWD may need disclosure |
| IP assignment | all inventions, works and code "conceived or developed during employment" belong to employer; sometimes "related to the business" | **the critical clause**: the product was built during employment and sits close to the founder's day-job specialism (Microsoft low-code; see `docs/research/power-platform/`) |
| Confidentiality | no use of client or employer information, survives employment | never use client designs, data or employer templates; keep a clean record |
| Non-solicitation | no hiring colleagues or approaching clients for 6-12 months | do not recruit colleagues; do not pitch the employer's clients |
| Post-employment non-compete | often present | generally void (above), but do not test it needlessly |

### 1.3 What "serving notice" changes

During notice the person is still an employee: all clauses apply in full until the last working day (LWD)
(**Inference**). After LWD, exclusivity ends; confidentiality, IP assignment for work done during employment, and
any non-solicit continue. Early release (shorter notice) changes the date but not the logic; check effects on
gratuity (generally after 5 years of continuous service for a permanent employee; lawyer/CA to confirm under the
Code on Social Security now in force), bonus and leave encashment before agreeing to any early release.

### 1.4 Sequencing options and their risks

| Option | What it means | Risks | View |
|---|---|---|---|
| **A. Clean wait** | Build privately on own equipment and time; no entity, directorship, customer meetings, offers or money until LWD; incorporate and sell from LWD+1 | 6-10 weeks lost; IP clause still has to be checked | **Recommended.** Lowest risk; the notice period is spent finishing the pilot-minimum product |
| B. Family member's entity now | e.g. spouse's proprietorship or LLP does the selling | if the founder does the work, it is still his activity; IP still needs assigning from him; can look like evasion; control and tax complications; a proprietorship cannot be converted cleanly; investors dislike it | Not recommended, except to hold a domain |
| C. Ask the employer for written consent or an IP no-objection | disclose the project and ask for a release | reveals plans; may be refused; but a written release removes most IP doubt | Worth considering **only after** the lawyer reads the contract; a release is the strongest protection if the IP clause is broad |
| D. Incorporate now as shareholder only, others as directors | founder holds shares, family members are directors | code-of-conduct disclosure duties; MCA records public; the company cannot do business with the founder's work until LWD anyway | Little gain, some risk |

Practical hygiene until LWD (any option): own laptop, own accounts, own internet; outside working hours; no
employer code, documents, templates or client knowledge; no colleagues involved. Keep the repository history:
it is evidence of what was built when. Be aware it also shows commit times; if many commits fall in office hours,
tell the lawyer.

**Must-do:** a lawyer reads the actual employment contract, offer letter, any IP/confidentiality agreement and the
code of conduct **before LWD**, and advises whether to ask for a written release.

---

## 2. Entity options

### 2.1 Comparison

| | Sole proprietorship | LLP | Private limited | One Person Company (OPC) |
|---|---|---|---|---|
| Setup cost | registrations only (GST/Udyam/shop licence) | government fee ₹500 for contribution up to ₹1 lakh, up to ₹5,000 above ₹25 lakh | nil MCA incorporation fee for authorised capital up to ₹15 lakh; total typically ₹4,000-10,000 plus professional fees, depending on state stamp duty | similar to private limited |
| Annual compliance cost (small) | ITR, GST | about ₹5,000-10,000 below audit threshold; Form 8, Form 11, ITR | about ₹15,000-30,000; AOC-4, MGT-7, AGM, DIR-3 KYC; statutory audit every year | close to private limited (audit compulsory, no AGM) |
| Audit | tax audit above income-tax limits | only above ₹40 lakh turnover or ₹25 lakh contribution | always | always |
| Liability | unlimited, personal | limited | limited | limited |
| Members | 1 | min. 2 designated partners | min. 2 directors and 2 shareholders | 1 member + nominee; Indian citizen |
| Fundraising | none | no equity shares; FDI conditions | equity and ESOPs; preferred by investors | no outside equity; can convert to private limited at any time |
| DPIIT startup recognition | not eligible | eligible | eligible | the official page lists private limited, partnership, LLP; OPC status **Unverified** |

Source for the rows above: [LegalRaasta, Aug 2026](https://www.legalraasta.com/blog/pvt-ltd-vs-llp-vs-opc-in-india/)
(secondary; confirm fees on [mca.gov.in](https://www.mca.gov.in)). Time to incorporate is not stated there; a
SPICe+ incorporation commonly takes one to three weeks (**Unverified**). The "small company" thresholds were raised
to paid-up capital up to ₹10 crore and turnover up to ₹100 crore by G.S.R. 880(E), effective 1 December 2025
([Taxmann](https://www.taxmann.com/post/blog/mca-raises-small-company-thresholds-to-rs-10-cr-capital-and-rs-100-cr-turnover)),
which reduces some compliance for a new company.

**Inference / recommendation:** a **private limited company** with the founder plus one family member as the
second director and a small minority shareholder, incorporated the day after LWD. Reasons: limited liability
against customer claims, the only structure investors and larger customers expect, DPIIT eligibility, and a clean
target for the founder's IP assignment. An OPC is acceptable if there is truly no second person, with a plan to
convert. Avoid a proprietorship for an on-prem software business: unlimited personal liability for a security or
data-loss claim.

### 2.2 Startup India (DPIIT) recognition

Eligibility on the official page: private limited company, partnership firm, LLP (or cooperative); turnover under
₹200 crore in any year; up to 10 years from incorporation; working on innovation; not formed by splitting an
existing business ([startupindia.gov.in](https://www.startupindia.gov.in/content/sih/en/startupgov/startup_recognition_page.html),
page last updated 27 June 2023). Benefits listed: the 80-IAC three-year tax holiday on application (companies and
LLPs incorporated after 1 April 2016), the angel-tax exemption, self-certification, IPR fee rebates and
procurement relaxations. Note that the income-tax section numbers changed with the new Income-tax Act (section 2.5);
the CA must map 80-IAC to the new Act. DPIIT recognition also qualifies the company for the lower trademark fee.

### 2.3 Udyam (MSME) registration

Free on the official portal; services firms qualify; current limits (revised from 1 April 2025): micro up to
₹2.5 crore investment and ₹10 crore turnover; small up to ₹25 crore and ₹100 crore
([Cashfree, Oct 2026](https://www.cashfree.com/blog/udyam-registration-online/), secondary). Benefits relevant to
us: MSME Samadhaan / facilitation council route for delayed payments by buyers, priority-sector lending, some
procurement concessions, and the small-enterprise trademark fee. The MSMED Act's 45-day payment rule for buyers
from micro and small enterprises, and its income-tax link, are worth asking the CA about: they push B2B
customers to pay on time (**Unverified** for the post-April 2026 tax section).

### 2.4 GST

| Topic | Position (verify with CA) |
|---|---|
| Registration threshold | services: aggregate turnover above ₹20 lakh (₹10 lakh in special category states; MP is not one) ([VJM Global](https://www.vjmglobal.com/blog/exempt-suppliers-services-through-an-e-commerce-platform-obtaining-compulsory-registration), citing Notification 65/2017-CT for e-commerce suppliers; inter-state service suppliers below the threshold were exempted by Notification 10/2017-Integrated Tax, secondary) |
| Should we register early? | **Yes (Inference).** B2B manufacturers want a GST invoice to claim input tax credit; an unregistered supplier is a purchasing problem for them. Registration is also needed to file an LUT for exports |
| Rate | 18% for software licences and IT services; GST 2.0 (22 Sep 2025) removed the 12% and 28% slabs but left IT services at 18% ([Xflow](https://www.xflowpay.com/blog/gst-on-software-services), secondary) |
| SAC codes | 997331 licence to use software; 998313 IT consulting, support and AMC; 998314 design and development (implementation); 998315 hosting ([Xflow](https://www.xflowpay.com/blog/gst-on-software-services)); packaged software on physical media falls under HSN 8523 |
| Intra vs inter-state | CGST 9% + SGST 9% for MP customers; IGST 18% for other states; place of supply for B2B is generally the recipient's location |
| Invoice contents | supplier GSTIN, consecutive invoice number, date, recipient name and GSTIN, place of supply, SAC, value, rate and tax split, signature (CGST Rules, rule 46; **Unverified** against current text) |
| E-invoicing | mandatory only once aggregate turnover exceeds ₹5 crore in any year since 2017-18 ([Tally Solutions, Sep 2026](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/)); years away |
| Exports | zero-rated with an LUT, if all export-of-service conditions are met (including payment in convertible foreign exchange) ([Xflow](https://www.xflowpay.com/blog/gst-on-software-services)) |
| Buying foreign SaaS | reverse charge: self-assess 18% IGST, usually claimable as credit |

### 2.5 TDS that customers will deduct

The **Income-tax Act, 2025 replaced the 1961 Act from 1 April 2026**; old section 194J is now within section
393(1): 2% for fees for technical services, 10% for professional services and "other royalty", ₹50,000 threshold
for technical/professional fees ([TDSMAN, Jul 2026](https://blog.tdsman.com/2026/07/tds-on-fees-for-professional-and-technical-services-section-3931-194j/),
secondary). Old 194C (contracts) moved into section 393 as well ([TaxGarden](https://taxgarden.in/blog/income-tax-act-2025-section-393-tds-new-numbers-old-194c-194j-194q), secondary, not opened).

Practical effect (**Inference; CA to confirm**): a customer paying for a software licence may deduct 10% as
royalty; support/AMC may be treated as technical services (2%) or contract work. The old relief for software
bought from a reseller where TDS was deducted earlier (Notification 21/2012) does not help a developer selling its
own software, and its status under the new Act is **Unverified**. Quote prices so that the founder's cash flow
survives receiving 90% up front and claiming the rest against tax; file TDS returns credit checks quarterly.

---

## 3. Intellectual property

### 3.1 Copyright in software

Copyright arises automatically on creation; registration is optional but gives evidence in disputes (**Inference**
from general Indian copyright practice). Optional registration of the code as a literary work with the Copyright
Office is possible; fee and source-code deposit rules **Unverified** (check [copyright.gov.in](https://copyright.gov.in)).
The bigger task is ownership: after LWD the founder signs a written **assignment deed** of all rights in the code,
designs, docs and the name to the company (s.19 writing requirement, above).

### 3.2 Trademark

- Search on the official [IP India public search](https://tmrsearch.ipindia.gov.in/tmrpublicsearch/) (CAPTCHA;
  manual). Classes: **9** (downloadable software) and **42** (SaaS, software design); consider **35** later for
  business-management services.
- Fees for form TM-A by e-filing: ₹4,500 per class for individuals, startups and small enterprises; ₹9,000 for
  other companies; expedited processing ₹40,000; renewal ₹9,000 per class (e-filing)
  ([S.S. Rana fee table](https://ssrana.in/ip-laws/trademarks-in-india/tm-filing-fees-forms-india/), secondary;
  confirm in the First Schedule of the Trade Marks Rules on [ipindia.gov.in](https://ipindia.gov.in)).
- Sequence: incorporate, get Udyam (same day, free), then file in the company's name at the lower fee. Typical
  time to registration if unopposed is many months (**Unverified**); use "TM" not "®" until registered.
- International later through the Madrid Protocol (handling fee ₹5,000 per the same table, plus WIPO fees).

### 3.3 AI-generated code

- **India:** the Copyright Act treats the author of a computer-generated work as "the person who causes the work
  to be created" (s.2(d)(vi)); AI is not accepted as an author, and how much human input is needed for protection
  is unsettled ([S.S. Rana, Aug 2026](https://ssrana.in/articles/who-owns-what-the-machine-makes-authorship-and-ownership-of-ai-generated-works-under-indian-law/)).
  DPIIT's committee published **Part 1** of a Working Paper on Generative AI and Copyright in December 2025 on
  training data (a proposed mandatory licence with statutory remuneration); authorship of AI outputs is reserved for
  **Part 2**, not yet seen by us ([DPIIT working paper](https://www.dpiit.gov.in/static/uploads/2025/12/ff266bbeed10c48e3479c941484f3525.pdf)).
- **United States:** human authorship is required; the Supreme Court declined to hear *Thaler v. Perlmutter* on
  2 March 2026; the Copyright Office's January 2025 report says prompts alone are not enough
  ([Mayer Brown, Mar 2026](https://www.mayerbrown.com/en/insights/publications/2026/03/supreme-court-denies-review-in-ai-authorship-case)).
- **Risk for us (Inference):** parts of a code base written mostly by AI agents may have thin or no copyright
  protection, so a competitor copying them might not infringe. Our real protection is the whole system,
  trade secrets (source not published), the EULA (contract), the trademark and speed.
- **Mitigations:** keep design docs, specs, reviews and commit history showing human direction, selection and
  editing (the repository already has specs and decision logs; keep doing it); avoid claiming in contracts that
  every line is copyrighted; protect the source as confidential; check the AI tools' terms grant output rights to
  the user; avoid pasting third-party code or GPL/AGPL snippets via AI; run the licence CI on every dependency.

### 3.4 Open-source licence obligations for what we ship

What we distribute (from `THIRD-PARTY-NOTICES.md` and `docs/admin/installation.md`):

| Component | Licence | How it reaches the customer | Obligations (Inference; lawyer to confirm) |
|---|---|---|---|
| 218 npm production packages | 182 MIT, 23 ISC, 4 Apache-2.0, 3 BSD-3-Clause, others permissive | inside our release zip | keep copyright and licence texts (the generated `THIRD-PARTY-NOTICES.md` does this); for Apache-2.0, also reproduce any NOTICE file content |
| jszip | MIT OR GPL-3.0 | inside the zip | we rely on MIT; record that election (the notices file already says so) |
| Node.js | MIT plus bundled permissive licences | downloaded by the installer; included in the offline bundle | ship its LICENSE in the offline bundle |
| PostgreSQL 17 (Windows, EDB binaries ZIP) | PostgreSQL Licence (permissive); the ZIP also contains OpenSSL (Apache-2.0), zlib, ICU, libxml2 and **LGPL-2.1** gettext libintl and libiconv DLLs, unmodified, dynamically linked | downloaded by the installer from EDB; **included in the offline bundle** | PostgreSQL: keep its notice. LGPL-2.1 DLLs: when we distribute them (offline bundle), include the LGPL text, keep them replaceable (they are separate DLLs), and provide or offer the corresponding source (the safest practice is to host the exact source archives or give a written offer); keep EDB's `commandlinetools_3rd_party_licenses.txt` |
| Caddy | Apache-2.0 | downloaded or in the offline bundle | include the licence and NOTICE; do not use the Caddy name to suggest endorsement |
| WinSW | MIT | as above | include licence |
| AGPL / fair-code / source-available projects | various | **never shipped** | the CI licence guard (`scripts/check-licences.mjs`) denies AGPL, GPL, LGPL (unless dual-licensed), SSPL, BUSL; keep it on |

Two traps to raise with the lawyer: (1) our EULA's "no reverse engineering" clause must exclude third-party
components that carry their own licences (LGPL requires allowing modification of the library); (2) when the
installer downloads PostgreSQL from EDB directly, the customer receives it from EDB; when we hand over an offline
bundle, **we** are the distributor and the obligations are ours.

### 3.5 Our own licence model

| Model | Pros | Cons |
|---|---|---|
| **Proprietary EULA, closed source** (current plan: signed licence file) | simplest to enforce; keeps the AI-written code's weak copyright from mattering as much (trade secret) | buyers fear a one-person vendor disappearing |
| Proprietary EULA **plus source escrow or a continuity clause** | answers the "what if you stop" objection: if we cease business, the customer gets the source for its own use | escrow agent costs; drafting effort |
| Source-available (e.g. BSL-style, delayed open source) | trust, community, auditability | competitors read the code; enforcement harder; buyers may not pay |
| Open core (open platform, paid templates/support) | marketing reach | ERPNext/NocoBase already occupy this space; services margin only |

**Recommendation (Inference):** proprietary EULA with a **continuity clause** (perpetual use of the last version and
access to its source under restricted terms if we stop trading or stop supporting the product). It costs little
and removes the strongest objection to buying from a single founder.

---

## 4. Contracts to prepare (outlines, not legal text)

| Contract | Key clauses |
|---|---|
| **EULA / on-prem licence** | grant (non-exclusive, non-transferable, per site and band, term or perpetual); passes and counting; licence file and soft enforcement (grace, read-only, export always works); restrictions with open-source carve-out; updates and supported versions; customer responsibilities (hardware, backups, OS patches, network security, admin accounts); data ownership (customer); warranty (conforms to docs for 90 days; no "error-free"); liability cap and exclusions; IP indemnity (limited); continuity clause; termination and data export; governing law and venue; third-party components |
| **Pilot / design-partner agreement** | scope, term, free licence, conversion price, data stays on site, support access only when customer starts the session, usage metrics, feedback licence, reference consent, as-is warranty, small liability cap, confidentiality, exit and export (see launch plan section 4.3) |
| **Order form** | customer entity and GSTIN, site, band and passes, term, price, taxes, TDS note, payment terms (for example 100% annual in advance, or 50/50 for setup), start date, references to EULA, SLA, DPA |
| **AMC / support SLA** | what is covered (product defects, updates, how-to); what is not (customer's hardware, network, custom work unless under AMC); channels and hours (IST business days); severity levels and response targets (not resolution guarantees); remote access rules; customer duties (named admin, backups, diagnostics bundle); service credits only if we can afford them; renewal |
| **Data processing agreement** | only where we touch personal data (support sessions, hosted installs): purpose limited to support/hosting; confidentiality of staff; security measures; breach notice to the customer "without delay" so it can meet its DPDP 72-hour report and CERT-In 6-hour timelines; sub-processors listed (e.g. VPS provider, email relay); deletion at end; audit by documentation; cross-border terms if any; GDPR Article 28 terms and SCCs for EU customers later |
| **NDA** | mutual, purpose-limited, 2-3 years, standard exclusions, return/destroy; one page for prospects |
| **Website privacy policy and terms** | who we are, what we collect (contact forms, downloads, licence portal, analytics), purposes, retention, rights, grievance contact, cookies; DPDP-ready notice language from May 2027; terms of use for the site and downloads |
| **Acceptable use policy** | for any hosted or trial service: no unlawful content, no security testing of others, no resale, no attempts to bypass licence controls |
| **Reseller / partner agreement** | territory (non-exclusive), pricing and discount or referral fee, who invoices, who supports (first-line partner, second-line us), branding rules, no promises beyond our docs, data protection role of the partner, training, termination, non-solicit of our customers if the partner leaves |
| **Founder IP assignment deed** | founder assigns all rights in the code, docs, designs, name and domains to the company; signed on or after LWD; records consideration |

---

## 5. Data protection

### 5.1 DPDP Act 2023 and DPDP Rules 2025: commencement status

| Phase | Date | What starts | Source |
|---|---|---|---|
| Rules notified | 13-14 Nov 2025 (Gazette G.S.R. 846(E) dated 13 Nov; announced 14 Nov) | Rules 1, 2, 17-21; definitions; Data Protection Board provisions | [ConsentOS status page, Oct 2026](https://consentos.in/learn/dpdp-rules-notification-status/); [PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf) |
| 12 months | 13-14 Nov 2026 | consent manager registration (Rule 4) | same; [Shardul Amarchand Mangaldas alert](https://www.amsshardul.com/wp-content/uploads/2025/11/Regulatory-Alert-Enforcement-of-DPDP-Act-and-Notification-of-DPDP-Rules.pdf) |
| 18 months | **13-14 May 2027** | notice and consent, security safeguards, breach intimation, data principal rights, retention, children's data, penalties, repeal of IT Act s.43A | same |

Sources differ by one day (13 vs 14) because the Gazette and the press release are dated differently; the lawyer
should use the Gazette. A January 2026 proposal to compress the Significant Data Fiduciary timeline had not been
gazetted per the status page (updated 9 Oct 2026). Whether the Data Protection Board has been constituted was
**Unverified** by that page.

Key duties from May 2027 (secondary sources):

- **Rule 6 security safeguards:** encryption/masking, access control, logging and monitoring, backups and
  continuity, **logs kept at least one year**, security terms in processor contracts, organisational measures
  ([Taxmann on Rule 7](https://www.taxmann.com/post/blog/personal-data-breach-intimation-rule-7-dpdp)).
- **Rule 7 breach intimation:** tell each affected person without delay; tell the Board without delay and send a
  detailed report **within 72 hours** of becoming aware; no materiality threshold ([same](https://www.taxmann.com/post/blog/personal-data-breach-intimation-rule-7-dpdp)).
- Data principal requests to be handled within a maximum of 90 days ([PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)).
- Penalties up to ₹250 crore for failing to keep reasonable security safeguards (same).

### 5.2 Our role

| Situation | Customer | Us |
|---|---|---|
| On-prem install, we never see data | **Data fiduciary** for its employees' and contacts' data | not a fiduciary or processor for that data (**Inference**) |
| On-prem, we join a support session or receive a diagnostics bundle containing personal data | fiduciary | **data processor** for that processing: needs a contract (DPA) and our own safeguards |
| We host the customer's install on a VPS | fiduciary | **processor**; our VPS provider is a sub-processor |
| Our website, trial sign-ups, licence portal, CRM of leads | - | **data fiduciary** for our own data: we need a notice, consent where required, safeguards, breach process from May 2027 |

Design rule (**Inference**): make diagnostics bundles exclude business data by default and show the customer what
is in them, so most support never makes us a processor.

### 5.3 Product features that help customers comply (never say "compliant")

Already built or planned per the brief and master plan: role-based, row- and column-level security; audit log;
two-step verification; backups and restore; sign-in log. Worth adding (**Inference**): a consent/notice register
template; retention rules per table with scheduled deletion; data principal request workflow (access, correction,
erasure) as a template; export of one person's records; a breach register template with the 72-hour and 6-hour
clocks; log retention setting defaulting to at least one year; NTP time sync check in diagnostics. Marketing may
say "helps you implement DPDP safeguards such as access control, logging and backups". It must not say
"DPDP compliant" or "certified".

### 5.4 GDPR basics for later global sales

- GDPR applies to a non-EU business that offers goods or services to people in the EU or monitors their behaviour
  (Art. 3(2)); EDPB Guidelines 3/2018 explain the targeting test ([GDPR-text, EDPB guidelines](https://gdpr-text.com/en/guidelines/territorialscope/)).
- For B2B on-prem sales we will usually be neither controller nor processor; when we support or host, we are a
  **processor** and need an Art. 28 DPA; transfers of EU personal data to India need a transfer tool, normally the
  EU **Standard Contractual Clauses** (2021 set) plus a transfer risk assessment (**Inference** from general GDPR
  practice).
- An **EU representative** (Art. 27) is required for a non-EU controller or processor caught by Art. 3(2), unless
  processing is occasional, not large-scale special-category data, and unlikely to create risk (same guidelines).
  The UK has an equivalent. Cost **Unverified**.
- Breach notice by a controller to the authority within 72 hours; a processor must tell the controller without
  undue delay.

### 5.5 CERT-In directions (28 April 2022)

- Issued under IT Act s.70B, effective 27 June 2022; apply to service providers, intermediaries, data centres,
  **body corporates** and government organisations; report listed cyber incidents **within 6 hours** of noticing;
  keep ICT system logs for a rolling **180 days** (in India, though CERT-In's FAQs allow storage abroad if
  produced on request); sync clocks to NIC/NPL NTP; register a point of contact; VPS/cloud/VPN providers keep
  subscriber KYC records ([Nishith Desai on the CERT-In FAQs](https://nishithdesai.com/research-and-articles/hotline/technology-law-analysis/cert-in-releases-faqs-explaining-the-direction-on-cybersecurity-6139);
  [InCorpX, 2026](https://www.incorpx.io/blog/cert-in-cybersecurity-compliance-2026), secondary, reports no
  size-based exemption and no amendments).
- **Applicability to us (Inference):** our company, once incorporated, is a body corporate: incidents on **our own
  systems** (website, licence portal, build and release pipeline, any hosting we run) must be reported within 6
  hours. For an on-prem install, the customer reports incidents on its systems; the FAQs say the entity that notices
  must report, so if we discover an incident at a customer's site during support, the lawyer should advise who
  reports. If we ever resell VPS hosting, check whether the VPS-provider KYC duties apply.
- No official amendment found as of 19 Nov 2026 (**Unverified**: we did not open cert-in.org.in directly).

---

## 6. Sector and other rules

| Topic | Position |
|---|---|
| IT Act intermediary rules | an on-prem software vendor is not an intermediary for customer data (**Inference**). A hosted multi-tenant service where customers' users upload content could fall within "intermediary" and the 2021 Intermediary Guidelines (grievance officer etc.); lawyer to confirm before hosting |
| Consumer Protection (E-Commerce) Rules 2020 | aimed at e-commerce entities selling to consumers; a business buying for commercial purposes is generally not a "consumer" under the Consumer Protection Act 2019 (**Inference**; see [Trilegal summary](https://trilegal.com/knowledge-repository/consumer-protection-e-commerce-rules-2020/), not opened). Publishing seller identity, contact, grievance details, refund and cancellation policy on the website is low cost and also required by payment gateways |
| Export of software and services: FEMA | **Changed on 1 Oct 2026.** The FEM (Export and Import of Goods and Services) Regulations, 2026 (Notification FEMA 23(R)/2026-RB, 13 Jan 2026) replaced the 2015 regulations: every exporter of services files a monthly **Export Declaration Form (EDF)**; **SOFTEX is discontinued** and software exports also use the EDF; deadline 30 days after the end of the invoice month; realisation within 9 months (12 months for rupee invoicing) after a 22 Sep 2026 amendment ([TaxGuru, 4 Oct 2026](https://taxguru.in/rbi/export-declaration-form-edf-services-fema-declaration-1-october-2026.html)). A Second Amendment (FEMA 23(R)/(2)/2026-RB, 2 Nov 2026) treats a company's EDF as submitted when it gives its bank the remittance details for receipts up to ₹10 lakh; software exporters cannot use one of the filing options open to other services ([CA Somu, Nov 2026](https://casomu.com/learning/edf-export-declaration-form-services/)). RBI FAQs were still awaited. All secondary; the CA and the bank's trade desk must confirm |
| Export under GST | file an **LUT** each financial year to export without paying IGST; keep proof of foreign-currency receipt |
| Payment gateway onboarding | KYC by entity type (PAN, bank account, incorporation documents, GSTIN if registered, director KYC) and a live website with terms, privacy, refund/cancellation and contact pages (**Inference** from common gateway practice; Razorpay's India KYC page was not retrieved, the URL returned its US version) |
| Cyber insurance and professional indemnity | technology PI typically covers negligent delivery, data handling errors and defence costs, and excludes fines, contractual penalties and known claims; premiums depend on revenue, clients and controls ([BimaKavach](https://www.bimakavach.com/blog/professional-indemnity-insurance-for-it-companies-what-you-need-to-know/), broker). Premium for a small firm **Unverified**; get quotes before Stage 2 |
| Accessibility | no general private-sector software mandate found for B2B in India (**Unverified**); government buyers expect accessibility standards (GIGW, IS 17802, **Unverified**); the EU Accessibility Act applies from 28 June 2025 mainly to consumer-facing products and services (**Unverified** for our B2B case). Practical: keyboard navigation, contrast, labels; publish an honest accessibility statement |

---

## 7. Liability, warranty and marketing claims

Customary for B2B software in India (**Inference**; lawyer to set numbers):

- Liability cap: fees paid in the 12 months before the claim (for pilots, a small fixed sum). Exclude indirect and
  consequential loss, lost profits, lost data where the customer did not keep backups. Carve-outs (uncapped or
  higher cap): breach of confidentiality, our IP infringement indemnity, fraud. Indian courts award only
  reasonable compensation for breach (Contract Act ss.73-74), so caps and liquidated sums must be reasonable.
- Warranty: software performs materially per the documentation for 90 days; remedy is fix, replace or refund the
  licence fee. Disclaim "uninterrupted", "error-free", fitness for a particular purpose. Pre-release builds "as is".
- Customer's duties written down: backups, OS patching, network security, admin account hygiene, lawful use of
  personal data.

Never say in marketing, decks, the website or chats:

- "100% secure", "unhackable", "bank-grade", "military-grade" security, or any security guarantee.
- "DPDP compliant", "GDPR compliant", "ISO 27001 certified", "SOC 2", "certified" anything we are not.
- "GST compliant" or "GST-ready" for ERP templates until the GST spec is verified and reviewed by an accountant
  (master plan section 10).
- Customer counts, logos, testimonials, awards or case studies that do not exist with written consent (BRIEF).
- "Replaces Power Platform / Zoho / Tally" or comparisons without a dated, sourced table.
- Uptime or response-time promises the founder cannot meet alone.

---

## 8. Prioritised checklist

Costs are **Estimates** in INR, excluding GST on professional fees.

### 8.1 Before the pilot (much of it before LWD)

| Task | Who | Cost |
|---|---|---|
| Lawyer reads employment contract, IP clause, code of conduct; advice on release request | lawyer (founder pays personally) | 5,000-15,000 |
| Name shortlist, IP India search, domains in personal name | founder; lawyer search opinion | 2,000-5,000 domains; 5,000-15,000 opinion |
| Incorporate private limited company on LWD+1 (SPICe+, DSC, DIN, PAN/TAN) | CA or CS | 8,000-20,000 |
| Founder-to-company IP assignment deed | lawyer | 5,000-15,000 |
| Pilot agreement, beta EULA, NDA, diagnostics/data note | lawyer | 20,000-45,000 |
| Bank account; Udyam registration | founder | free |
| Trademark TM-A, classes 9 and 42, after Udyam | founder or lawyer | 9,000 govt + 3,000-10,000 professional |
| Fill `SECURITY.md` contact and response times | founder | free |
| Open-source notices check for the release and the offline bundle (LGPL source offer, Apache NOTICE files) | founder; lawyer confirms | included above |

### 8.2 Before taking money

| Task | Who | Cost |
|---|---|---|
| GST registration (voluntary, before first invoice); invoice template with SAC codes | CA | 2,000-5,000 |
| Accounting set-up and monthly CA retainer (GST returns, TDS, books) | CA | 3,000-8,000 per month |
| Final EULA, order form, support SLA, DPA | lawyer | 25,000-60,000 |
| Payment terms that account for customer TDS | founder with CA | free |
| PI and cyber insurance quotes | broker | 20,000-80,000 per year (**Unverified**) |
| Payment gateway or bank transfer set-up | founder | free to low |
| DPIIT recognition application | founder or CA | free to 10,000 |

### 8.3 Before public launch

| Task | Who | Cost |
|---|---|---|
| Website privacy policy, terms, AUP, refund and grievance pages; DPDP notice language for our own data (duties from May 2027) | lawyer | 15,000-40,000 |
| Our own DPDP readiness: data map, retention, breach runbook including CERT-In 6-hour and DPDP 72-hour timelines | founder; lawyer review | 10,000-30,000 |
| Outside security review completed and fixed | security firm | 1,50,000-5,00,000 (**Unverified**) |
| Reseller/partner agreement | lawyer | 15,000-40,000 |
| Continuity / escrow clause in EULA | lawyer | included |
| Marketing claims review against section 7 | founder | free |

### 8.4 Before selling abroad

| Task | Who | Cost |
|---|---|---|
| GST LUT for the financial year | CA | low |
| EDF process with the bank (FEMA 2026 rules), realisation tracking | CA and bank | low |
| GDPR Art. 28 DPA, SCCs, transfer assessment; EU/UK representative if needed | lawyer (EU-qualified for final review) | 50,000-2,00,000 plus representative fee (**Unverified**) |
| Madrid trademark filing for target markets | lawyer | ₹5,000 handling plus WIPO and country fees |
| Foreign tax and permanent-establishment check; withholding tax and DTAA forms | CA | 20,000-60,000 |
| Localised EULA governing law and venue | lawyer | 20,000-50,000 |

---

## Sources

Employment: [Desai & Diwanji](https://desaidiwanji.com/insights/articles/validity-of-non-solicitation-and-non-compete-clauses-in-employment-agreements);
[LVL1 Accelerator](https://lvl1accelerator.com/blog/start-startup-while-employed-india-legal/).

Entities and registrations: [LegalRaasta](https://www.legalraasta.com/blog/pvt-ltd-vs-llp-vs-opc-in-india/);
[Taxmann on small company limits](https://www.taxmann.com/post/blog/mca-raises-small-company-thresholds-to-rs-10-cr-capital-and-rs-100-cr-turnover);
[MCA](https://www.mca.gov.in); [Startup India recognition](https://www.startupindia.gov.in/content/sih/en/startupgov/startup_recognition_page.html);
[Cashfree on Udyam](https://www.cashfree.com/blog/udyam-registration-online/).

Tax: [Xflow on GST for software](https://www.xflowpay.com/blog/gst-on-software-services);
[VJM Global on registration exemption](https://www.vjmglobal.com/blog/exempt-suppliers-services-through-an-e-commerce-platform-obtaining-compulsory-registration);
[Tally on e-invoicing 2026](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/);
[TDSMAN on section 393](https://blog.tdsman.com/2026/07/tds-on-fees-for-professional-and-technical-services-section-3931-194j/);
[TaxGarden on new TDS numbers](https://taxgarden.in/blog/income-tax-act-2025-section-393-tds-new-numbers-old-194c-194j-194q).

IP: [S.S. Rana trademark fees](https://ssrana.in/ip-laws/trademarks-in-india/tm-filing-fees-forms-india/);
[IP India public search](https://tmrsearch.ipindia.gov.in/tmrpublicsearch/);
[S.S. Rana on AI authorship](https://ssrana.in/articles/who-owns-what-the-machine-makes-authorship-and-ownership-of-ai-generated-works-under-indian-law/);
[DPIIT Working Paper Part 1](https://www.dpiit.gov.in/static/uploads/2025/12/ff266bbeed10c48e3479c941484f3525.pdf);
[Mayer Brown on Thaler](https://www.mayerbrown.com/en/insights/publications/2026/03/supreme-court-denies-review-in-ai-authorship-case);
repository files `THIRD-PARTY-NOTICES.md`, `docs/admin/installation.md`, `docs/research/building-blocks.md` (licence risk table).

Data protection and security: [ConsentOS DPDP status](https://consentos.in/learn/dpdp-rules-notification-status/);
[PIB DPDP Rules document](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf);
[Shardul Amarchand Mangaldas alert](https://www.amsshardul.com/wp-content/uploads/2025/11/Regulatory-Alert-Enforcement-of-DPDP-Act-and-Notification-of-DPDP-Rules.pdf);
[Taxmann on Rule 7](https://www.taxmann.com/post/blog/personal-data-breach-intimation-rule-7-dpdp);
[Wikipedia: DPDP Rules](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025);
[GDPR-text: EDPB territorial scope guidelines](https://gdpr-text.com/en/guidelines/territorialscope/);
[Nishith Desai on CERT-In FAQs](https://nishithdesai.com/research-and-articles/hotline/technology-law-analysis/cert-in-releases-faqs-explaining-the-direction-on-cybersecurity-6139);
[InCorpX on CERT-In](https://www.incorpx.io/blog/cert-in-cybersecurity-compliance-2026).

Other: [TaxGuru on EDF](https://taxguru.in/rbi/export-declaration-form-edf-services-fema-declaration-1-october-2026.html);
[CA Somu on the deemed EDF rule](https://casomu.com/learning/edf-export-declaration-form-services/);
[Trilegal on e-commerce rules](https://trilegal.com/knowledge-repository/consumer-protection-e-commerce-rules-2020/);
[BimaKavach on PI insurance](https://www.bimakavach.com/blog/professional-indemnity-insurance-for-it-companies-what-you-need-to-know/);
[Razorpay KYC docs](https://razorpay.com/docs/payments/business-types-kyc-documents/) (returned US content).
