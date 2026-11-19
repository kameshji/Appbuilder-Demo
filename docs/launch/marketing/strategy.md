# Marketing strategy: lean in India, then global

Status: draft for owner review, 19 Nov 2026. Author: marketing workstream.
Binding inputs: [BRIEF.md](../BRIEF.md) (product facts and constraints), [sector research](../../research/README.md),
[master plan](../../plan/master-plan.md). Sources are linked inline. **Assumption** marks a number or judgement
that is not sourced. **Inference** marks reasoning from sources. **Unverified** marks something searched for but
not confirmed.

The product's name is not chosen. This document writes it as `<NAME>`.

Companion files: [lead-generation.md](lead-generation.md), [ad-creatives.md](ad-creatives.md),
[brand-foundations.md](brand-foundations.md), [chatgpt-prompts.md](chatgpt-prompts.md).

---

## 0. The honest starting point (read this first)

| Fact | Consequence for marketing |
|---|---|
| Version 0.5.0. No customer, no pilot, no outside security review, Windows installer not yet run on a customer machine ([BRIEF](../BRIEF.md)) | There is nothing to "launch" yet. Phase A is about building an audience and finding one design partner, not about reach. |
| The founder is serving notice at an employer with a no-moonlighting policy until about end of January 2027 ([BRIEF](../BRIEF.md)) | **No public, branded, commercial marketing before the employment ends**, unless the owner has written clearance. Before then: private preparation only (see Phase A0). Ask the lawyer whether even unbranded "research interviews" with prospects are safe during notice. |
| No product name, no domain, no trademark check | No paid ads, no logo, no printed material, no website promotion, no Product Hunt, no press until the name is cleared. Anything built around a working name has to be thrown away. |
| The master plan puts the pilot after P3 (flows, phone layout, PDF, WhatsApp, templates) ([master plan §5, §9](../../plan/master-plan.md)) | The pilot date is set by engineering, not marketing. The manufacturing research says plainly: without flows, a phone layout and WhatsApp alerts, do not lead with manufacturing ([manufacturing.md §7](../../research/manufacturing.md)). |
| No budget figure | The plan works at zero spend. Each budget tier (§7) is optional and has a precondition. |
| DPDP Rules: most obligations apply from about 13 May 2027 ([manufacturing.md §5](../../research/manufacturing.md)) | Our own lead lists are personal data. Build them compliantly from the first day, because Phase C lands inside the DPDP window. |

**What should NOT be spent yet (before a name and a pilot):** paid ads of any kind; trade-show stalls; PR agencies or
paid "launch" services; bought contact databases or scraped lists; logo and brand-identity agencies; video production
agencies; SEO agencies; review-site (G2/Capterra) paid placements; awards entry fees; merchandise. Each of these needs
either a name, a working demo or a customer story to pay back, and none exists yet.

What a zero budget *can* buy now: the founder's time on content, conversations and a short list of the right accounts.

---

## 1. Ideal customer profiles (ranked)

Ranking logic (**Inference**): (a) how much of the value today's product can deliver, (b) how short the path from
first conversation to pilot is, (c) how much each customer teaches us about the next one, (d) reachability by one founder
from Bhopal.

### ICP 1 (first): owner or plant head of a 20-200 person manufacturer in India running Tally + Excel + WhatsApp

| Field | Detail |
|---|---|
| Who | Owner-managers, second-generation directors, plant heads, sometimes the "computer person" in accounts. Job shops, auto components, plastics moulding, fabrication, packaging, food processing. |
| Where first | Bhopal (Govindpura), Mandideep (Raisen district; the industrial association's treasurer says "more than 450 small and big industries" operate there), then Pithampur (over 1,250 industries) and Dewas (about 1,200 units) ([ThePrint, figures from officials and associations, not independently verified](https://theprint.in/economy/what-ails-industry-growth-in-agri-led-mp-growth-centred-in-clusters-govt-fixes-too-late/1836601)). |
| Context | Only about [21% of MSMEs use ERP or custom business software (CII-ISB study of 2,919 MSMEs)](https://www.business-standard.com/amp/economy/news/two-thirds-of-msmes-use-ai-but-only-21-deploy-business-software-study-126101301191_1.html). Tally is the ledger of record; [more than 2.7 million businesses in India use TallyPrime](https://tallysolutions.com/business-guides/why-businesses-trust-tallyprime/). |
| Jobs to be done | "Show me yesterday's production, rejects and downtime without chasing three people." "Stop machines from breaking down twice for the same reason." "Pass the customer's quality audit without a week of paper hunting." "Approve purchase requests without signing paper on my car bonnet." |
| Pains | Paper log sheets typed into Excel the next day; photos of defects lost in WhatsApp groups; no MTTR or OEE figure anyone trusts; supervisors who see each other's salary sheet in a shared Excel; ERP projects that ran over budget (a vendor survey says [61% of ERP implementations ran over budget and 9% were rolled back](https://www.bsquare.in/images/BSquare_ERP_Adoption_Report_2026_FINAL_updated%20.pdf), vendor-run and self-reported). |
| Triggers | A customer audit or an OEM's supplier-quality demand; a big breakdown; a new plant or line; a key Excel person leaving; a failed ERP attempt; a son or daughter joining the business with "let's digitise" energy; GST audit pain. |
| Objections | "We already have Tally." "ERPNext is free." "Who will build the apps? We have no IT person." "What if you shut down?" "Our operators only use phones." "Our internet is bad." "Will my data be safe on your server?" |
| Our honest answers today | We sit next to Tally, not instead of it. Data stays on your PC/server (self-hosted). Backups and restore are built in. **But:** phone layouts, WhatsApp alerts, PDF output and the manufacturing templates are planned, not built ([BRIEF](../BRIEF.md)); flows and approvals are in progress. Until they ship, the honest offer is "design partner", not "product". |
| Where attention goes | WhatsApp (groups of the local industries association, supplier and customer groups); YouTube (how-to videos, often Hindi/Hinglish; **Assumption**, not measured); in-person association meetings and the District Industries Centre; their CA and Tally partner; IndiaMART as a selling channel; trade fairs such as [IMTEX 2027, 21-27 Jan 2027, BIEC Bengaluru](https://www.imtex.in/). LinkedIn reaches the second-generation owners and plant heads more than first-generation owners (**Assumption**). |

### ICP 2: Power Platform consultants and freelancers who would resell or implement

| Field | Detail |
|---|---|
| Who | Independent Power Apps / Power Automate developers, small Microsoft partners, Dynamics freelancers, in India first and in the UK/GCC later. |
| Why ranked second | They already know the canvas-plus-formula model, so our one distinct asset (Excel-style formulas everywhere, [building-blocks.md (c)](../../research/building-blocks.md)) is legible to them in minutes. They can do the configuration work that ICP 1 cannot. One partner can bring several ICP 1 customers. They are also the most credible early critics. |
| Jobs to be done | "Offer my small clients something when Microsoft licensing kills the deal." "Deliver on-prem when the client won't go to the cloud." "Earn recurring revenue, not just project fees." |
| Pains | Per-user licensing that small clients balk at: Power Apps Premium is US$20 per user per month and [rises to US$22 from 1 January 2027](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update); premium connector gates; deprecation of free on-ramps ([power-platform README §12](../../research/power-platform/README.md)). |
| Triggers | A lost deal on price; a client asking for on-prem; the January 2027 price rise; a client that only needs 3-5 apps for 30 people. |
| Objections | "Is it mature enough to stake my reputation on?" "Is there a partner margin?" "Will my Power Fx skills transfer?" (partly: the formula language is Excel-like, not a Power Fx clone; do not claim compatibility). "Who supports it when it breaks at 9 pm?" |
| Where attention goes | LinkedIn; YouTube tutorials; Microsoft community forums and user groups (do not spam them; see §11); Reddit r/PowerApps and r/PowerPlatform (**Unverified** activity levels); freelance marketplaces. UK demand is real: [3,516 UK permanent job ads cited Power Platform in the six months to 18 Nov 2026](https://www.itjobswatch.co.uk/jobs/uk/power%20platform.do). |

### ICP 3: ops or IT generalist at a small services firm (20-50 staff) that outgrew Excel and WhatsApp

| Field | Detail |
|---|---|
| Who | Office manager, "the person who knows Excel", operations lead at a logistics firm, clinic group, CA firm, real-estate developer, NGO, distributor. |
| Why third | The product fits desk work today (tables, security, scheduled reports, tasks and comments). But the segment is broad and hard to target, so it is a good inbound and partner-led segment, not an outbound one. |
| Jobs to be done | "Turn our 14 shared Excel files into one system where people only see their rows." "Get a Monday report without building it by hand." |
| Pains | Version chaos in Excel; everybody sees everything; no audit trail; SaaS tools that each solve one thing at per-user prices. |
| Triggers | A data leak scare; a new manager; a client audit; a staff member leaving with the "master file". |
| Objections | "Zoho Creator / Airtable / Google Sheets does this." "Who hosts it?" |
| Where attention goes | LinkedIn; YouTube Excel channels; Google search ("leave tracker excel template", "approval workflow without coding"); their CA. |

### ICP 4 (later): coaching institute back office

| Field | Detail |
|---|---|
| Who | Owner or office head of a coaching institute or small multi-branch group. |
| Why last | The [education research](../../research/education.md) found a crowded, cheap market where the buyer judges the product by the parent/student app, payment gateway and WhatsApp, none of which we have. The narrow opening is back-office (leads, batches, instalments, refunds) and DPDP-readiness before 13 May 2027. |
| Rule | Do not market to this ICP until phone layouts, payment-gateway integration and WhatsApp exist. Capture inbound interest only. |

---

## 2. Positioning

### Positioning statement (working, to be tested in conversations)

> For owners and plant heads of small Indian manufacturers who run the business on Tally, Excel and WhatsApp,
> `<NAME>` is a business app platform you install on your own computer or server, so the shop-floor and approval
> work that Tally does not cover gets proper apps with "who can see what" built in.
> Unlike ERPs, it does not ask you to replace Tally or change how you work all at once; unlike per-user cloud
> tools, your data stays on your premises and the price does not grow with every operator you add
> (pricing model not yet decided; do not quote this as a promise until it is).

Partner version (ICP 2):

> For Power Platform consultants whose small clients balk at per-user licences or refuse the cloud, `<NAME>` is a
> self-hosted app platform with an Excel-style formula language, built-in row and column security and dev/test/production
> environments, installed once on the client's own server.

### Messaging house

**Roof (primary message):** *Your business apps, on your own computer, with "who sees what" built in.*
Hindi-English: *Aapke business ke apps, aapke apne computer par, aur kaun kya dekhega, yeh aapke haath mein.*

| Pillar | Message | Proof that exists today | Proof still needed |
|---|---|---|---|
| 1. Yours, on your premises | One install on your own PC, server or small VPS. Your data stays with you. Backup and restore are built in. | Windows and Linux installers exist; install guide ([getting-started.md](../../guide/getting-started.md)); backup and restore screens ([backups-restore-dialog.png](../../images/backups-restore-dialog.png)) | Windows installer run on a real customer machine ([README known limits](../../../README.md#known-limits)); an install-time video; a restore drill done by someone other than the founder |
| 2. Built like Excel, behaves like software | Makers build by drag and drop and write Excel-like formulas; validation rules, formula columns and rollups; visual data model | Screens of formula bar ([studio-filter-formula.png](../../images/studio-filter-formula.png)), validation rules ([events-validation-rule.png](../../images/events-validation-rule.png)), data model ([datamodel-canvas.png](../../images/datamodel-canvas.png)) | A recorded "Excel sheet to app in 30 minutes" by a non-developer; template apps for manufacturing (planned) |
| 3. Right people, right rows | Roles with row- and column-level security; "test as user" and "who can see this row"; two-step verification; environments so changes are tested before production | Screens [roles-test-as-user-why.png](../../images/roles-test-as-user-why.png), [restricted-supervisor-grid.png](../../images/restricted-supervisor-grid.png) | An outside security review (none yet; **never** claim "secure", "bank-grade", "certified") |

Supporting points that are true but secondary: live updates; tasks, comments, mentions, record timelines; notifications;
scheduled email reports. **Coming, must be labelled "planned" or "in progress" every time:** flows and approvals
(in progress); phone layouts, PDF, dashboards, WhatsApp, templates marketplace, manufacturing pack, chat, AI agents,
portals, single sign-on (planned).

> Note for the owner: the docs include phone-size app screens ([studio-phone-app.png](../../images/studio-phone-app.png)) and
> a flows run history ([flows-run-detail.png](../../images/flows-run-detail.png)), while BRIEF lists phone layouts as
> planned and flows as in progress. Marketing follows BRIEF until BRIEF is updated.

### Category naming options

| Option | Pros | Cons | Use |
|---|---|---|---|
| "Self-hosted business app platform" | Accurate; searchable by ICP 2 | Means nothing to ICP 1 | Website meta, partner material |
| "On-premise low-code platform" | Searchable; Power Platform people understand it | "Low-code" is jargon for owners | SEO comparison pages, ICP 2 |
| "Shop-floor apps next to Tally" | Concrete for ICP 1; matches the research wedge ([manufacturing.md §7](../../research/manufacturing.md)) | Narrow; only true once templates ship | ICP 1 messaging from Phase B |
| "Your own Power Platform on your own server" | Instantly clear to ICP 2 | Trademark risk using Microsoft's mark in a tagline; invites feature-by-feature comparison we lose today | Only in factual comparison pages, never as a tagline or ad headline |
| "Private app builder" / "Apps that stay in your office" | Plain language for owners | Vague | Ad and landing-page headline tests |

Recommendation: lead with the job ("apps for the work Tally doesn't cover") for ICP 1, and with the category
("self-hosted low-code platform") for ICP 2 and search.

---

## 3. Competitive positioning (factual; each with "when they are the better choice")

Prices and licences are as linked; re-check before publishing any comparison. Comparison pages must link sources,
carry a "last checked" date and a correction contact.

| Competitor | Factual summary | Where `<NAME>` differs (only what is true today) | When they are the better choice |
|---|---|---|---|
| **Microsoft Power Platform** | Cloud platform; Power Apps Premium US$20/user/month, [rising to US$22 from 1 Jan 2027](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update); premium connectors and capacity add-ons ([power-platform README](../../research/power-platform/README.md)) | Self-hosted on the customer's machine; one formula language for apps, validation, formula columns; pricing model planned per install, not per user (not decided) | You already pay for Microsoft 365 E3/E5 and Teams, need deep Microsoft 365/Entra integration, phone apps and a huge partner ecosystem today |
| **Zoho Creator** | Cloud low-code with mobile apps; India list price [₹480 / ₹1,200 / ₹1,500 per user per month](https://www.zoho.com/creator/pricing) (Standard/Professional/Enterprise, annual), free edition available | Runs on your own server; data never leaves the premises | You want mobile apps, a mature partner network and a hosted service now, and per-user pricing is fine for your headcount |
| **ERPNext / Frappe** | Open-source ERP (GPL-3.0) with manufacturing, workflows, print formats; framework MIT; [no per-user fee on Frappe Cloud](https://frappe.io/erpnext) ([building-blocks.md (c)](../../research/building-blocks.md)) | Not an ERP: an app builder with Excel-style formulas for the gaps; does not ask you to move your accounting out of Tally | You want a full ERP (accounts, stock, manufacturing) in one system and have an implementer; budget is near zero |
| **Odoo** | Modular ERP; Studio only on Custom plan, about [₹1,080-1,350/user/month in India](https://oec.sh/odoo-pricing/india) (third-party tracker) | Self-hosted platform focus; formulas rather than Python for makers | You want a polished, broad ERP suite with an app store and you are ready for an implementation project |
| **Tally** | The ledger; Silver [₹22,500 one-time](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/) | Complement, not competitor: covers shop-floor, quality, maintenance, approvals (templates planned) | Accounting, GST, inventory valuation: always use Tally (or your ERP) for these |
| **Budibase** | Open-source (GPL-3.0 + BSL pro) internal-app builder with automations and RBAC; [2026 roadmap adds data-scoped AI agents](https://budibase.com/blog/updates/future-of-budibase-2026/) | Excel-style formulas instead of JavaScript/handlebars; native Windows single install | You have a developer who is comfortable with Docker and JavaScript and want a mature open-source tool today |
| **NocoBase** | Plugin low-code platform (Apache-2.0 + terms), row/field permissions, workflows, [AI employees](https://www.nocobase.com/fr/highlights/ai-employee) | Formula-based maker experience; Windows installer | You want a plugin ecosystem and workflows now and run Linux/Docker |
| **Appsmith / ToolJet** | Developer-oriented internal tools on any DB (Apache-2.0 CE / AGPL-3.0) | Built-in database with security and environments; aimed at Excel users, not JavaScript developers | Your builders are developers who want JavaScript and Git sync |

Rules for comparison content: no "X is insecure"; no screenshots of competitors' UI without permission; no use of
competitor trademarks in our ad headlines (search ads on competitor *keywords* are a separate decision, see §5 and §7); always
include the "when they are better" line. This is also the most credible content we can publish.

---

## 4. Phased plan

| Phase | Dates (Assumption; engineering and employment decide) | Goal | Exit check |
|---|---|---|---|
| **A0 Private prep** | now → end of notice (~end Jan 2027) | Be ready to start the day employment ends, without public activity | Name shortlist cleared by lawyer; positioning and 12 weeks of content drafted; target account list (50) built from public, lawful sources; lead magnets drafted |
| **A Pre-pilot audience** | ~Feb → pilot start (P3 exit; unknown) | Build a small, real audience; find 1-3 design partners | 1 signed design-partner agreement; 150+ opt-in contacts (waitlist + WhatsApp community); 20 recorded discovery conversations |
| **B Pilot proof** | pilot start → +3 months | Turn one pilot into a case study **with written permission** | Pilot exit check met ([master plan §1](../../plan/master-plan.md): ≥10 daily users, ≥3 apps, approvals and alerts, nightly backups); signed case-study consent; 2nd and 3rd pilots |
| **C India launch** | after B, and after outside security review | Paid customers in 1-2 clusters; partner channel live | 10 paying installs; 5 active partners; CAC and payback measured |
| **D Global** | after C shows repeatable sales | First countries via partners | 3 partners and 3 customers outside India |

### Phase A0 (private, before employment ends)

Do: write (unpublished) the content backlog in §10; draft lead magnets ([lead-generation.md](lead-generation.md) §5); build the cluster account
list from public, lawful sources (company names and addresses are not personal data; record provenance); prepare the
demo script; take screenshots and screen recordings of the real product; shortlist names with the launch-plan workstream
and get trademark/domain checks; set up analytics (§13) on a placeholder domain only once the name is chosen.

Do not: publish anything under the product's brand; contact prospects to sell; post "building in public" about the
product; register for events as an exhibitor. **Check with the lawyer** whether "learning conversations" with
manufacturers are allowed during notice.

### Phase A (pre-pilot audience building), zero to ₹25k/month

1. **Founder-led content**, 3 posts/week on LinkedIn (English) and 1 short video/week on YouTube (Hindi-English),
   documenting real problems: "the 7 paper registers in a typical small plant", "OEE explained with a real Excel".
   Build-in-public about the product itself is fine *after* employment ends, but always shows real screens and labels
   planned features.
2. **Waitlist and design-partner page**: one landing page, two forms: "Join the waitlist" and "Apply to be a design
   partner (3 places)". Honest copy: version 0.5, what exists, what is planned.
3. **Local presence**: attend Govindpura and Mandideep association meetings as a member/guest (check membership
   rules); offer a free 45-minute "Excel to app clinic" (lead-generation.md §6).
4. **Partners (ICP 2) outreach**: 10 Power Platform freelancers in India get early access in exchange for blunt
   feedback (no commission promises yet).
5. **WhatsApp community** (opt-in only) for "small plant digitisation" tips; content first, product second.

Target funnel for Phase A (monthly, **Assumption**, low / base / high):

| Stage | Low | Base | High | Assumption behind it |
|---|---|---|---|---|
| Content impressions (LinkedIn + YouTube) | 5,000 | 15,000 | 40,000 | New account, 12 posts + 4 videos/month |
| Landing page visits | 150 | 400 | 1,000 | 2-3% of impressions click |
| Waitlist sign-ups | 10 | 30 | 80 | 7-8% visit-to-signup |
| Design-partner applications | 1 | 3 | 6 | 10% of signups from ICP 1 |
| Outbound + in-person conversations | 8 | 15 | 25 | lead-generation.md cadence |
| Qualified design-partner candidates | 1 | 2 | 4 | |

### Phase B (pilot proof)

- Work inside the pilot weekly; capture before/after numbers the customer agrees to share (for example "breakdown
  tickets logged per week", "time to compile the daily report"). Measure; do not estimate.
- Get **written** consent for: company name, logo use, quotes (exact wording approved), screenshots with their data
  (blur where needed), and numbers. No consent → anonymised story ("a 90-person auto-components plant in MP") and
  no logo.
- Produce: one case study page, one 3-minute video (customer on camera only if they volunteer), one LinkedIn carousel,
  one Hindi-English YouTube walkthrough.
- Use the pilot as a reference visit for 2-3 nearby plants in the same cluster (with the customer's agreement).

### Phase C (India launch)

Preconditions: name and trademark filed; pilot case study approved; outside security review done (or explicitly
scoped claims); pricing decided; support process ([../support/](../support/)) live; DPDP-ready lead handling.

- Launch moment: a cluster event (association hall demo day) plus LinkedIn and YouTube, then Indian startup media
  only if there is a real story (customer outcome, funding, or open-source release). Skip paid "PR packages".
- Turn on paid search at the ₹25k-₹1 lakh tier (§7), only on high-intent keywords.
- Recruit partners (§8): 5 Tally partners or ERP implementers and 5 Power Platform freelancers in MP, Gujarat,
  Maharashtra.
- Second cluster: Pithampur/Indore or a sub-sector (plastics, auto components) where templates are most specific.

### Phase D (global)

Reasoning (**Inference** unless linked):

| Market | For | Against | Verdict |
|---|---|---|---|
| **UK** | High Power Platform consultant density ([3,516 permanent job ads in 6 months](https://www.itjobswatch.co.uk/jobs/uk/power%20platform.do)); English; Microsoft-literate buyers; B2B email to corporate subscribers allowed without prior consent under PECR, with identity and opt-out rules ([ICO](https://cy.ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)) | No data-localisation mandate (UK not covered in the source; EU GDPR regulates transfers, not storage ([ComplyJet](https://www.complyjet.com/blog/data-residency-laws-by-country))); UK GDPR obligations on us; support time zone | **D1 via partners (ICP 2)**: consultants who lose deals on per-user licensing |
| **UAE and wider GCC** | English widely used in business; close time zone; many Indian-run SMEs and manufacturers (**Assumption**); Zoho prices the region separately and lower ([Zoho Creator regional pricing](https://www.zoho.com/creator/pricing)), a sign of price sensitivity; UAE restricts health data storage abroad ([ComplyJet](https://www.complyjet.com/blog/data-residency-laws-by-country)) | Saudi data rules **Unverified** in this research; Arabic needed for some buyers | **D1 alongside UK**, through Indian-diaspora networks and local partners |
| **Kenya, Nigeria, South Africa** | English; Zoho lists cheaper Africa pricing (KES, NGN, ZAR) ([Zoho](https://www.zoho.com/creator/pricing)); connectivity and USD licence costs favour on-prem (**Inference**) | Payment collection, support distance; local data-protection laws not checked here (**Unverified**) | **D2** via partners only |
| **Australia / NZ** | English; no storage-in-Australia mandate but APP 8 overseas-disclosure duties ([ComplyJet](https://www.complyjet.com/blog/data-residency-laws-by-country)) | High expectations for polish and support | D3 |
| **US** | Largest market | Highest competition and cost; no general localisation mandate ([ComplyJet](https://www.complyjet.com/blog/data-residency-laws-by-country)) | Later; only via open-source/community distribution, not paid acquisition |
| **Indonesia, Vietnam** | Conditional localisation rules ([ComplyJet](https://www.complyjet.com/blog/data-residency-laws-by-country)) | Not English-first; needs localisation | Later |

Phase D channel: partners first (ICP 2), English content and SEO comparison pages, a public trial download. No paid
acquisition abroad until partner-led deals close.

---

## 5. Channel plan per phase

| Channel | A0 | A | B | C | D |
|---|---|---|---|---|---|
| LinkedIn organic (founder) | draft | **core** | core | core | core |
| YouTube (Hindi-English how-tos) | draft | **core** | core | core | English channel |
| WhatsApp community (opt-in) | – | start | grow | core | – |
| Association meetings / clinics | observe (lawyer check) | **core** | core | core | – |
| Partner programme | design | 10 feedback partners | 3-5 | **core** | **core** |
| SEO (templates, comparisons) | write | publish | publish | core | core |
| Email newsletter (opt-in) | – | monthly | fortnightly | fortnightly | fortnightly |
| Google search ads | – | – | small test (₹5-10k) | yes | partners' markets only |
| LinkedIn ads | – | – | – | retargeting only | partner recruitment |
| Meta/Instagram ads | – | – | – | test (Hindi reels, cluster geo) | – |
| YouTube ads | – | – | – | test (remarketing) | – |
| Trade fairs | visit only | visit | visit | small shared stall (with association) | – |
| Product Hunt / Show HN | – | – | – | when public download exists | yes |
| Indian startup media | – | – | – | with a real story | – |

---

## 6. Funnel maths (Phase C, monthly, base budget tier ₹1 lakh)

All numbers are **Assumptions** for planning, to be replaced by measured data after 8 weeks.

| Source | Volume | Rate to qualified lead (low/base/high) | Qualified leads | Rate to paid install | Paid installs |
|---|---|---|---|---|---|
| Outbound to cluster accounts (lead-generation.md) | 200 accounts researched, ~80 contactable lawfully | 5% / 10% / 15% | 4 / 8 / 12 | 10% / 20% / 30% | 0.4 / 1.6 / 3.6 |
| Partners (5 active) | 5 partners × 1 intro | 40% / 60% / 80% | 2 / 3 / 4 | 25% / 35% / 50% | 0.5 / 1 / 2 |
| Paid search (₹40k at ₹40-80 CPC, **Assumption**) | ~500-1,000 clicks | 1% / 2% / 3% | 5 / 15 / 30 | 3% / 6% / 10% | 0.2 / 0.9 / 3 |
| Clinics / demo days (2 per month) | 30 attendees | 10% / 20% / 30% | 3 / 6 / 9 | 15% / 25% / 35% | 0.5 / 1.5 / 3 |
| Content / SEO / referrals | – | – | 2 / 5 / 10 | 10% / 15% / 20% | 0.2 / 0.8 / 2 |
| **Total** | | | **16 / 37 / 65** | | **~2 / ~6 / ~14** |

Read this honestly: at base, about 6 installs a month needs ~37 qualified leads and a founder who can run ~20 demos a
month while also building. The founder's time, not ad money, is the constraint; this is why partners matter.

---

## 7. Budget tiers (per month)

| Tier | Precondition | What it buys | What it does not buy |
|---|---|---|---|
| **Zero** | none | Founder content (LinkedIn, YouTube with phone + free editing), clinics, opt-in WhatsApp community, Umami analytics (MIT, self-hosted, cookie-less) ([comparison](https://dev.to/selfhostingsh/plausible-vs-umami-which-analytics-tool-3595)), Google Search Console, free ChatGPT/Canva tier for drafts, manual outreach | Reach beyond the founder's network |
| **₹25k** | name chosen, landing page live | Domain + hosting; a good USB microphone once; Canva Pro or similar; printing 200 flyers for one event; association membership fee (**Unverified** amounts); a small Google search test (₹10-15k) on 10 high-intent keywords; WhatsApp Business Platform per-message costs for opted-in updates ([pricing per message since 1 July 2025](https://developers.facebook.com/docs/whatsapp/pricing/)) | Brand agency, video agency, LinkedIn ads (US$10/day minimum ≈ ₹25k/month alone ([LinkedIn](https://business.linkedin.com/advertise/ads/best-practices/maximize-your-budget))) |
| **₹1 lakh** | pilot case study approved | Search ads ₹40k; Meta reels test ₹20k (Hindi, cluster geo); a freelance designer and video editor ₹25k; event costs (clinic hall, tea) ₹10k; partner enablement material ₹5k | Trade-show stall; PR agency |
| **₹5 lakh** | 5+ paying customers, CAC under 12 months of licence revenue (**Assumption** threshold) | One full-time sales/partner associate (₹40-60k/month, **Assumption**); search + Meta + LinkedIn ₹1.5-2 lakh; shared stall at a regional fair; Hindi video series production; review programme on G2/Capterra (organic reviews from real customers, not paid placements) | Brand campaigns, TV/print, influencers |

---

## 8. Partner channel design

| Partner type | What they do | Why they would | Margin options (to be decided with pricing) | Risks |
|---|---|---|---|---|
| **Tally partners** (certified resellers) | Introduce, install, first-line support | They visit SME offices already; some work with hundreds of CAs (one partner [claims 500+ CA and GST practitioners across 19 states](https://tallysolutions.com/partners/growth-partners)) | (a) 20-30% recurring of licence for referral + install; (b) one-time referral fee; (c) partner buys at discount and resells | Their Tally contract may restrict competing products (**Unverified**; ask); they sell products, not projects |
| **CAs and GST practitioners** | Trusted introduction | Clients ask them about software | Non-monetary preferred: free licence for their own office, CPE-style talks, co-branded checklists. **Unverified:** ICAI ethics rules may limit CAs in practice from accepting commission; let each CA confirm with ICAI guidance | Conflict of interest; ethics rules |
| **ERP implementers** (ERPNext, small Odoo/SAP B1 partners) | Use `<NAME>` for the gaps their ERP leaves | Project revenue on top of ERP | Services margin (they bill configuration); 10-20% referral on licence | They may prefer their ERP's own builder |
| **Power Platform freelancers** (ICP 2) | Build apps for clients on `<NAME>` | Win deals lost on licensing | They keep 100% of services; 20-30% recurring of licence for deals they bring (**Assumption**) | Quality of their builds reflects on us; need certification-lite training |
| **IT hardware/networking vendors in industrial areas** | Supply the server PC, install | Hardware sale + service | Referral fee | Weak software skills |

Partner programme steps: (1) Phase A: 10 "founding partners" get free NFR (not-for-resale) licences and a private
WhatsApp group with the founder; (2) Phase B: a 2-day training (recorded) and a partner kit; (3) Phase C: margin
contract reviewed by lawyer/CA, listing on website only with the partner's consent.

---

## 9. SEO plan

Search volumes were **not** checked (no keyword tool available in this research). Validate each cluster with Google
Keyword Planner and Search Console before writing more than two pages per cluster.

| Cluster | Example queries | Intent | Page type | Phase |
|---|---|---|---|---|
| Shop-floor formats (Hindi + English) | "production report format excel", "daily production report format in hindi", "breakdown register format", "preventive maintenance checklist excel", "QC inspection report format", "NCR format" | Informational / template download | Free template page + "turn this into an app" CTA | A |
| KPIs | "OEE calculation formula", "OEE calculator excel", "MTTR MTBF calculation" | Informational | Calculator + explainer, sourced to [OEE.com](https://www.oee.com/calculating-oee/) | A |
| Tally gap | "tally production entry", "tally shop floor software", "tally with approval workflow" | Problem-aware | Explainer: what Tally does and doesn't do (factual, no Tally trademark misuse) | A/B |
| Category | "self-hosted low code platform", "on premise low code", "open source power apps alternative" (we are not open source; don't target "open source" unless that changes) | Solution-aware | Category page | B |
| Comparisons | "power apps alternative on premise", "zoho creator alternative self hosted", "erpnext vs [category]" | Commercial | Fair comparison pages with "when they are better" sections and sources (§3) | C |
| Programmatic templates (later) | "[industry] [register/app] template" e.g. "plastic moulding production log app" | Template | One page per template in the (planned) catalogue, generated from real templates only | after templates ship |

Rules: no AI-generated thin pages; every template page links a real downloadable file or a real app; every comparison
page has a "last checked" date.

---

## 10. Content calendar: first 12 weeks of Phase A

Week 1 starts the week after the employment ends (**Assumption**: early February 2027). L = LinkedIn post,
Y = YouTube (Hindi-English unless marked), N = newsletter, B = blog/SEO page.

| Week | Theme | Titles |
|---|---|---|
| 1 | Why I'm building this | L: "I spent [N] years building Power Platform apps for big companies. Here's what small plants need instead." · L: "What version 0.5 can and can't do (honest list)" · B: "About `<NAME>`: what exists, what's planned" |
| 2 | The paper registers | L: "The 7 registers I find in every small plant" · Y: "Factory ke 7 register jo Excel mein bhi galat hain" · B: "Breakdown register format (free Excel)" |
| 3 | OEE without jargon | L: "OEE in one picture" · Y: "OEE kya hai? Real factory data ke saath (free calculator)" · B: "OEE calculator Excel + explainer" |
| 4 | Who sees what | L: "Why your supervisor can see everyone's salary in the shared Excel" · Y: "Row-level security explained with a production table" (real product screens) · N1: "First issue: what this newsletter is" |
| 5 | Tally and the gap | L: "Tally is brilliant. It just isn't a shop-floor system." · B: "What Tally covers and what it doesn't: a factual guide" · Y: "Tally ke saath shop-floor apps kaise jodein (concept)" (label planned connector) |
| 6 | Build in public | L: "Building a QC inspection app live: part 1" · Y: "Excel sheet se app: 30 minute live build" · B: "QC inspection report format (free)" |
| 7 | Backups and data ownership | L: "If your laptop dies tonight, what happens to the plant data?" · Y: "Backup aur restore: 3 minute demo" · B: "A backup checklist for small plants" |
| 8 | Approvals | L: "Indent approvals on WhatsApp: what goes wrong" · Y: "Purchase approval process for small factories" (flows labelled in progress) · N2 |
| 9 | Partner week | L: "To Power Platform freelancers: when a client says 'too expensive per user'" · B: "For consultants: how `<NAME>` compares with Power Apps (facts, sources, when to pick which)" |
| 10 | Maintenance | L: "MTTR and MTBF from a WhatsApp group: an experiment" · Y: "Preventive maintenance checklist banana seekhein" · B: "PM checklist template" |
| 11 | Clinic recap | L: "What 12 plant owners asked at our Excel-to-app clinic" (only with attendees' consent; no names) · Y: recording of the clinic (with consent) |
| 12 | Design-partner call | L: "3 design-partner places: what you get, what we need from you" · N3 · B: "Design partner programme: terms in plain words" |

---

## 11. Community plan

- **Own community:** one WhatsApp Community ("Small plant digitisation, MP"), opt-in by QR or link only, never by
  adding people. Rules: no selling by members, weekly tip, monthly clinic invite. Note the draft CCPA guidelines list
  "adding consumers to promotional groups without consent" as unsolicited communication
  ([Khaitan & Co summary of the draft](https://www.khaitanco.com/sites/default/files/2026-10/Ergo_CCPA%20Guidelines_6%20October%202026.pdf)).
- **Existing communities:** contribute answers in Power Platform forums, Reddit and Excel groups under the founder's
  name; mention `<NAME>` only when directly relevant and with disclosure ("I build this"). Do not post promotional
  content in Microsoft-run community spaces.
- **Local:** associations (Govindpura, Mandideep, Pithampur), District Industries Centre, MSME-DFO Indore
  ([MSME-DI Indore](https://msmeindore.nic.in/)), ICAI Bhopal branch (talk offers on digital record keeping, not sales).
- **Partners:** private group for founding partners; monthly call.

---

## 12. PR, launch platforms and events

| Platform | When | When not |
|---|---|---|
| **Product Hunt** | When anyone can download and try a release under the final name, with docs and a demo video | Before the name; with a waitlist-only page; never buy upvote services |
| **Hacker News (Show HN)** | When the install zip is public and people can try it; the rules say "Show HN is for something you've made that other people can play with", "Don't post landing pages", and "Please don't ask friends to upvote or comment" ([HN Show HN rules](https://news.ycombinator.com/showhn.html)) | Waitlist stage; marketing-speak posts; with an unproven Windows installer (HN will test it) |
| **Indian startup media** (YourStory, Inc42, Entrackr etc.) | With a real story: first customer outcome with consent, funding, or an open-source release | "Founder launches app" with no customer; paid features presented as news |
| **Trade fairs** (IMTEX 21-27 Jan 2027, [imtex.in](https://www.imtex.in/)) | Visit to learn (this one falls inside the notice period: visit only, no selling) | Own stall before Phase C |
| **Association events** | Phase A onwards: clinics, talks | Hard selling at the meeting |
| **UN MSME Day (27 June)** | A clinic or content theme (**Assumption** that local bodies hold events) | – |

---

## 13. Measurement plan

**North-star metric (from Phase B):** *weekly active production apps* = apps in a customer's production environment
used by ≥5 distinct people in the week. On-prem installs send nothing by default, so measure it through an
**opt-in** licence check-in or a monthly customer-reported number; never collect usage silently.
**Pre-pilot north star (Phase A):** qualified design-partner conversations per month.

| Funnel metric | Definition | Tool |
|---|---|---|
| Reach | Impressions and views (LinkedIn, YouTube) | Native analytics (free) |
| Site visits by source | UTM-tagged sessions | Umami self-hosted (MIT, cookie-less, no consent banner needed per the [comparison](https://dev.to/selfhostingsh/plausible-vs-umami-which-analytics-tool-3595)) or Plausible cloud (from US$9/month) |
| Leads | Waitlist, design-partner form, lead magnet download (with consent checkbox) | Form → our own CRM template later; a spreadsheet now |
| Qualified leads | Meets lead score ≥ 60 (lead-generation.md §8) | CRM |
| Demos held | Live or recorded demo with a decision-maker | Calendar |
| Pilots / installs | Signed agreement and install done | CRM |
| Activation | First app used by ≥5 people within 30 days | Customer check-in |
| Search performance | Queries, clicks, positions | Google Search Console (free) |

**Attribution on a tiny budget:** UTM on every link (convention: `utm_source=linkedin&utm_medium=organic&utm_campaign=w03-oee`);
a required "How did you hear about us?" field with fixed options; unique QR codes per event and flyer; unique WhatsApp
click-to-chat pre-filled text per source (e.g. "Hi, I saw the Mandideep flyer"); a monthly 30-minute review.
Do not install Meta Pixel or Google Ads tags until paid campaigns start, and then only with a consent banner.

---

## 14. Risks and what to avoid

| Risk | Avoid | Do instead |
|---|---|---|
| Moonlighting breach during notice | Public brand activity before end of employment | A0 private prep; lawyer/HR confirmation |
| Overclaiming security | "Secure", "bank-grade", "enterprise-grade security", "DPDP compliant", "certified" | Describe mechanisms: "roles with row and column access", "two-step verification", "backups you control". Add "outside security review: not yet done" in FAQ until it is |
| Overclaiming AI | Any AI claim (agents are planned, P4) | Say nothing about AI in ads; in roadmap pages label "planned" |
| Selling planned features | "WhatsApp alerts", "mobile app", "PDF reports", "templates" in ads | Label "planned" or leave out of ads entirely |
| Vanity spend | Stalls, awards, PR packages, follower ads, Product Hunt "launch services" | §7 tiers with preconditions |
| Fake proof | Mock testimonials, stock "customer" photos, invented logos or user counts | Label every mock-up "Example"; use real screenshots with sample data |
| Trademark trouble | Using a name before clearance; Microsoft/Tally marks in headlines | Clear the name first; factual comparisons only |
| Data-protection exposure | Bought lists, scraping, cold WhatsApp, 10-digit telemarketing | lead-generation.md compliance section |
| Founder burnout | Doing every channel | Max 8-10 marketing hours/week in Phase A (lead-generation.md §10) |
| Leading with manufacturing too early | Promising floor apps without phone/flows/WhatsApp | Design-partner framing until P2/P3 ship |
