# Sector research

Market and requirements research for selling Appbuilder to small and mid-size Indian organisations. Research date: 18 November 2026. Each file separates sourced facts (linked inline) from the author's inference (labelled).

| File | Sector |
|---|---|
| [manufacturing.md](manufacturing.md) | Small and mid-size manufacturers (10-500 staff) |
| [education.md](education.md) | Schools, coaching institutes, colleges |

## Summary of each

**Manufacturing.** The value is in the shop-floor layer that Tally and most ERPs do not cover: production logs, quality inspection, maintenance, stores movements, dispatch checklists. These run on paper, Excel and WhatsApp today. Office-side apps (planning, QC lab, maintenance history, MIS) fit Appbuilder now. Floor-side apps need a phone layout, flows and WhatsApp alerts. Tally is the system of record and can only be reached through a local agent on the Tally PC. Incumbents: Tally, ERPNext (free, has manufacturing and a no-code builder), Odoo, SAP Business One, Zoho Creator. Suggested first templates: production log + OEE, QC inspection + NCR, maintenance breakdown + PM.

**Education.** A crowded, cheap market of ready-made school ERPs (Entab, Teachmint/MyClassCampus, Fedena and many others) that all include a parent mobile app, online fees, SMS/WhatsApp and board-specific report cards. Parents and teachers are mobile users; only the office is on desktops. DPDP verifiable parental consent applies from about 13 May 2027, with a narrow carve-out for schools. Appbuilder's row and column security fits the access rules well. Suggested first templates: admission enquiry CRM, fee ledger with dues ageing and reminders, attendance with absent alerts. Realistic targets are coaching institutes and colleges/trusts with niche workflows, not standard K-12 schools.

## Comparison

| Factor | Manufacturing | Education |
|---|---|---|
| Who uses the apps | Office staff on desktop; operators, inspectors and technicians on phones | Office on desktop; teachers, parents and students on phones (the majority) |
| Share of value reachable with today's desktop-only platform | Medium (QC, maintenance history, planning, MIS) | Low to medium (admissions desk, fee office, exam cell) |
| Strength of ready-made competition at SME scale | Strong for accounting/ERP (Tally, ERPNext, Odoo); weak for shop-floor apps | Very strong and cheap for K-12 schools; weaker for coaching back-office and college niches |
| Must-have integrations | Tally (local agent), WhatsApp, later biometric, scales, machines | Payment gateway, WhatsApp/SMS with DLT, PDF report cards and receipts |
| Must-have platform features we lack | Multi-user hosting, flows, phone layout, WhatsApp, paging beyond 5,000 rows | The same, plus parent accounts at scale, payment gateway, and a parent-facing mobile experience |
| Regulatory pull | Indirect (GST records 72 months; OSH Code registers in flux; DPDP for employee data) | Direct (DPDP parental consent from May 2027; UDISE+/APAAR data; CBSE disclosures; coaching guidelines) |
| Data sensitivity | Moderate (employee data) | High (children's data, health, concessions) |
| Fit of Appbuilder's row and column security | Good (site/line scoping, cost and salary columns) | Very good (teacher/parent/student scoping, medical and concession columns) |
| Deployment that fits | Plant LAN server, often the Tally PC; poor internet | Internet-hosted for parents; multi-tenant for resellers |
| Price expectation | Per site or per app; per-user pricing is a poor fit for floor headcount | Per student per year, roughly ₹50-600 (secondary source) |

## Which sector to target first

**Inference: manufacturing, narrowly.** Three reasons:

1. More of the value can be delivered by a desktop-plus-LAN product. QC inspection, maintenance history and the daily OEE/MIS board are office or lab work, while in education the paying customer judges the product by the parent app.
2. The competition is weaker in the specific gap. Tally does not do shop-floor capture, and many SMEs do not run an ERP. In K-12 education, cheap complete products already exist.
3. Hosting is easier. A plant can run Appbuilder on its existing server PC, which suits the current architecture better than serving thousands of parents over the internet.

Conditions: you still need flows, at least one phone-friendly entry form and WhatsApp alerts before a manufacturing sale is credible, plus a Tally agent before you touch stores or dispatch. If the PHP gateway and multi-tenant hosting arrive before mobile layouts, coaching-institute back-office apps (leads, batches, instalments, refunds) are the best second target, and DPDP consent tooling is a time-limited opening before May 2027.

Shared roadmap order implied by both files (inference): multi-user hosting → flows (approvals, schedules, reminders) → WhatsApp → server-side paging/aggregation → PDF output → phone layout → connectors (Tally agent; payment gateway).
