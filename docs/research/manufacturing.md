# Sector research: small and mid-size manufacturing (India focus)

Research date: 18 November 2026. Prices, laws and product status were checked on that date where a source is linked. Anything marked **Inference** is the author's judgement, not a sourced fact. Anything marked **Unverified** could not be confirmed.

## Executive summary

1. Indian manufacturing SMEs are only partly digitised. A CII-ISB survey of 2,919 MSMEs found [21% use ERP or custom business software](https://www.business-standard.com/amp/economy/news/two-thirds-of-msmes-use-ai-but-only-21-deploy-business-software-study-126101301191_1.html); a vendor-run survey of 500 manufacturers puts Tally-only plus Excel/manual at about 24%, with many ERP owners using under half of their ERP.
2. The ledger of record is almost always Tally (or an ERP). Appbuilder must sit beside Tally, not replace it. TallyPrime only exposes its XML interface [on a running machine, default port 9000](https://help.tallysolutions.com/tallyprime-as-server/), so a cloud-hosted app needs a local agent.
3. The sweet spot is the gap between Tally and the shop floor: production logs, quality inspection, maintenance, stores issue/receipt, dispatch checklists. These are now Excel sheets, paper registers and WhatsApp groups.
4. The same vendor survey reports that [79% of 2025 ERP evaluators called a shop-floor mobile app a must-have](https://www.bsquare.in/images/BSquare_ERP_Adoption_Report_2026_FINAL_updated%20.pdf). A desktop-landscape-only platform fails that test on the shop floor.
5. Must-have automations for a sale: approval flows (indent, PO, gate pass), low-stock and breakdown alerts on WhatsApp, and a daily production/OEE report. Flows are not built yet, so this is the biggest gap.
6. The KPIs are standard and easy to compute from good shop-floor data: OEE = availability × performance × quality ([OEE.com](https://www.oee.com/calculating-oee/); [ISO 22400-2](https://www.iso.org/standard/54497.html)), MTBF/MTTR, first-pass yield, on-time delivery.
7. Regulatory pull is real but indirect: GST records must be kept for [72 months after the annual return due date](https://www.gstgyaan.com/section-36-period-of-retention-of-accounts-records); e-invoicing applies above [₹5 crore AATO](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/); the Factories Act was [replaced by the OSH Code on 21 Nov 2025](https://www.keka.com/compliance/acts/occupational-safety-health-and-working-conditions-code). Tally and GSPs already handle the tax side.
8. Incumbents are strong and cheap at the low end: Tally Silver is [₹22,500 one-time](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/); ERPNext is [open source with no per-user fee on Frappe Cloud](https://frappe.io/erpnext); Odoo Custom (with Studio) is about [₹1,080-1,350 per user per month](https://oec.sh/odoo-pricing/india); Zoho Creator is a direct low-code rival at about [₹480-1,500 per user per month](https://codroiditlabs.com/zoho-creator-pricing-india/).
9. **Inference:** a general low-code platform will lose against ERPs for full ERP scope. The realistic wedge is "Tally-companion shop-floor apps" sold as finished templates with a flat site price, installed on a plant LAN PC or cheap hosting, configured by the seller.
10. First three templates: (1) Production log + OEE board, (2) QC inspection and NCR, (3) Maintenance breakdown/PM log. Each needs a phone-friendly entry screen and WhatsApp alerts to be sellable.

---

## 1. Apps manufacturers need

Fit ratings are for the current Appbuilder (desktop landscape, MySQL, roles with row and column security, attachments, no flows, no mobile layout, no offline mode). "Today" reflects common practice; where no source is linked it is **Inference** from typical Indian SME practice.

| Function | App | Main users | Core screens | What they use today | Fit now | Why |
|---|---|---|---|---|---|---|
| Production planning | Production plan / work orders | Planner, plant head | Sales-order backlog, work-order list, capacity by machine/shift, Gantt or day plan | Excel plan, whiteboard; ERP work orders where ERP exists (ERPNext has [work orders and job cards](https://frappe.io/erpnext)) | Good | Office desk work at a desktop; needs a simple scheduler view |
| Shop-floor data capture | Shift production log (output, rejects, downtime reasons) | Operators, line supervisors | Shift entry form, downtime entry, supervisor sign-off | Paper log sheets typed into Excel next day | Partial to poor | Entry happens at the machine on a phone/tablet; landscape desktop forms do not work there |
| Shop-floor data capture | Machine monitoring (auto counts, run/stop) | Supervisor, maintenance | Live machine status board, stoppage list | Mostly none; IoT add-ons such as [Leanworx](https://themachinemaker.com/news/leanworx-secures-inr-8-3-crore-in-seed-funding-led-by-yournest-venture-capital/) or [TrackMyMachines](https://www.capterra.in/software/1071514/TrackMyMachines) | Poor | Needs PLC/sensor integration (OPC UA, MQTT, Modbus); a board display is fine but the data feed is not something we have |
| Quality | Incoming, in-process and final inspection; NCR/CAPA | QC inspector, QA head | Inspection plan per item, inspection entry with readings, NCR form with photos, CAPA tracker | Paper checksheets, Excel, photos on WhatsApp | Good (lab/office), partial (line-side) | Inspection rooms often have a PC; photos at line need phone |
| Maintenance | Breakdown log, preventive maintenance (PM) schedule, spares | Maintenance engineer, technicians | Asset register, breakdown ticket, PM calendar/checklist, spare issue | Paper history cards, Excel PM plan, phone calls | Partial | Ticket raising is mobile; PM planning and history are desktop |
| Inventory / stores | Material receipt (GRN), issue to production, stock ledger, reorder levels | Storekeeper | GRN, issue slip, stock by bin, reorder list | Tally inventory, Excel, bin cards | Partial | Double entry with Tally is the risk; barcode/QR scanning wanted |
| Purchase | Indent → RFQ → PO → follow-up | Purchase officer, approvers | Indent form, quote comparison, PO print, pending-PO list | Tally/ERP PO, email, WhatsApp to vendors | Partial | Needs approvals (flows) and PDF PO; PO usually ends up in Tally anyway |
| Sales / dispatch | Order book, packing list, dispatch plan, gate pass | Dispatch clerk, sales coordinator | Pending orders, packing list, vehicle/LR entry, gate pass print | Tally invoice + e-way bill; Excel dispatch plan | Partial | E-invoice and e-way bill are generated by Tally/GSP; we only plan and track |
| Job work / subcontracting | Material sent out and received back | Stores, purchase | Challan out, receipt, pending-at-vendor | Tally job-work vouchers, registers | Partial | Legal challan lives in Tally |
| Safety / EHS | Incident and near-miss reporting, permit-to-work, safety inspections, training records | Safety officer, all staff | Incident form, PTW form, audit checklist, training matrix | Paper registers, Excel | Partial | Reporting from the floor needs mobile; registers fit desktop |
| HR / attendance | Attendance, shifts, overtime, contract labour, leave | HR, supervisors | Daily muster, OT approval, contractor headcount | Biometric devices (eSSL/ZKTeco class) + Excel; payroll in Tally or a payroll SaaS | Partial | Needs biometric device feed; payroll is better bought |
| Management | Daily MIS / plant dashboard | Owner, plant head | KPIs by day/shift/line, trend charts, exceptions | Excel MIS mailed or posted on WhatsApp | Good | Desktop dashboard is the natural place; charts depth is the limit |

**Inference:** the office-side apps (planning, QC lab, maintenance history, MIS) fit today. The floor-side apps, which carry the most value, are blocked by the lack of a phone layout and offline tolerance.

## 2. Automations

Trigger → action examples. "Must-have" means a buyer is likely to reject the product without it (**Inference**, based on the survey findings above and typical sales conversations).

| # | Trigger | Action | Must-have? |
|---|---|---|---|
| 1 | Indent or PO created above a value limit | Route to HOD then owner for approval; notify by WhatsApp/email; lock edits after approval | Must-have |
| 2 | Stock of an item falls below reorder level | Alert storekeeper and purchase on WhatsApp; draft an indent | Must-have |
| 3 | Breakdown ticket raised | Notify maintenance on WhatsApp; escalate to plant head if not acknowledged in 30 min or not closed in 4 h | Must-have |
| 4 | End of shift / 8 am daily | Compute OEE, output vs plan, rejects; send PDF or image summary to owner's WhatsApp | Must-have |
| 5 | PM due date reached | Create PM work order; remind technician; flag overdue | Must-have for maintenance template |
| 6 | Inspection result out of tolerance | Raise NCR automatically; hold the lot; notify QA head | Strongly wanted |
| 7 | PO delivery date passed with open quantity | Daily vendor follow-up list; optional message to vendor | Strongly wanted |
| 8 | Dispatch marked done | Generate gate pass/packing list PDF; message customer with LR number | Wanted |
| 9 | GRN approved / dispatch made | Push voucher or stock journal to Tally (via local agent and Tally XML) | Must-have for stores/dispatch apps; optional for QC/maintenance |
| 10 | Biometric punches arrive | Import punches, compute shift attendance and OT; flag missed punches | Must-have for HR app |
| 11 | Calibration certificate expiry in 30 days | Remind QA | Wanted |
| 12 | Safety incident logged | Notify safety officer and plant head immediately; schedule investigation | Wanted |

Messaging constraints in India: WhatsApp Business Platform moved to [per-message pricing on 1 July 2025](https://developers.facebook.com/docs/whatsapp/pricing/), with utility templates free inside an open customer-service window. SMS needs DLT registration: entity, sender header and every content template must be registered, and since October 2024 [URLs in SMS must be whitelisted](https://www.messagecentral.com/sms-guideline/india) (vendor summary; verify against TRAI before building). **Inference:** for factory alerts, WhatsApp through a BSP is the expected channel; SMS is a fallback.

## 3. KPIs

| KPI | Formula | Data needed | Source for definition |
|---|---|---|---|
| Availability | Run time ÷ planned production time | Shift calendar, planned breaks, downtime events with reasons | [OEE.com](https://www.oee.com/calculating-oee/) |
| Performance | (Ideal cycle time × total count) ÷ run time | Ideal cycle time per item/machine, total count | [OEE.com](https://www.oee.com/calculating-oee/) |
| Quality (OEE factor) | Good count ÷ total count | Good and reject counts per run | [OEE.com](https://www.oee.com/calculating-oee/) |
| OEE | Availability × performance × quality = (good count × ideal cycle time) ÷ planned production time | All of the above | [OEE.com](https://www.oee.com/calculating-oee/); OEE is also among the KPIs in [ISO 22400-2:2014](https://www.iso.org/standard/54497.html) (formal text not read; paywalled) |
| TEEP | OEE with calendar time as the denominator | Calendar time plus OEE data | [Teeptrak summary](https://teeptrak.com/en/availability-performance-quality/) |
| First-pass yield (FPY) | Units passing first time without rework ÷ units started | Inspection results, rework flag | Common definition; reworked units are not "good" in the OEE quality rate either ([Teeptrak](https://teeptrak.com/en/availability-performance-quality/)) |
| Scrap rate | Scrapped quantity ÷ total produced (by count or weight) | Scrap entries by reason | Common definition |
| MTBF | Total operating time ÷ number of failures | Breakdown tickets, run hours | [UpKeep](https://www.upkeep.com/blog/improve-reliability-with-mtbf-and-mttr) |
| MTTR | Total repair time ÷ number of repairs (agree whether the clock starts at failure or response) | Ticket open/close times | [UpKeep](https://www.upkeep.com/blog/improve-reliability-with-mtbf-and-mttr) |
| Inherent availability | MTBF ÷ (MTBF + MTTR) | As above | [UpKeep](https://www.upkeep.com/blog/improve-reliability-with-mtbf-and-mttr) |
| PM compliance | PM tasks done on time ÷ PM tasks due | PM schedule, completion dates | Common definition |
| Schedule adherence | Work orders (or quantity) completed as planned in the period ÷ planned | Plan and actuals by day | Common definition |
| On-time in-full (OTIF) / on-time delivery | Order lines delivered by promised date and in full ÷ order lines due | Order promise date, dispatch date and quantity | Common definition |
| Inventory turns | Cost of goods sold ÷ average inventory value | COGS from Tally, stock values at period start/end | Common accounting definition |
| Days of inventory | 365 ÷ inventory turns | As above | Common definition |
| Supplier on-time rate | PO lines received by due date ÷ PO lines due | PO and GRN dates | Common definition |
| Lost-time injury frequency rate | Lost-time injuries × 1,000,000 ÷ hours worked (some firms use 200,000) | Incident log, man-hours | Common EHS convention (**Unverified** for a single Indian standard) |
| Absenteeism | Absent man-days ÷ scheduled man-days | Attendance | Common definition |

The OEE benchmark often quoted as "world class" is 85% ([Teeptrak](https://teeptrak.com/en/availability-performance-quality/)). **Inference:** most Indian SMEs that start measuring honestly see far lower numbers, which is itself a selling point: the first month of data usually exposes hidden downtime.

## 4. Data model

### Standards to borrow from

ISA-95 (IEC 62264) separates business systems (Level 4, ERP) from manufacturing operations management (Level 3, MOM/MES) and control (Levels 1-2, PLC/SCADA); Level 0 is the physical process ([OPC Foundation ISA-95 companion spec](https://reference.opcfoundation.org/specs/OPC-10030/4.1)). It defines information models exchanged between Level 3 and Level 4, among them **personnel, equipment, physical asset and material** (the four covered by the OPC UA companion spec), plus process segments and operations definition, schedule and performance ([same source](https://reference.opcfoundation.org/specs/OPC-10030/4.1)). Appbuilder sits at Level 3. **Inference:** naming tables after these models (equipment hierarchy site → area → line → work unit; material definition/lot; operations schedule = work orders; operations performance = production records) makes later MES or ERP integration much easier and gives the product credibility with engineers.

### Proposed core schema

| Table | Key fields | Relations | RLS (who sees which rows) | Column security |
|---|---|---|---|---|
| site | id, name, gstin, address | 1-n area | User sees own site(s) | — |
| area / line | id, site_id, name, type | n-1 site; 1-n work_unit | Supervisor sees own line | — |
| work_unit (machine) | id, line_id, code, ideal_cycle_time, status | n-1 line; 1-n downtime_event | By line | — |
| asset | id, work_unit_id, make, model, serial, install_date, criticality | physical asset behind equipment | By site | Purchase cost (finance only) |
| item (material definition) | id, code, name, uom, type (RM/WIP/FG/spare), hsn, reorder_level, tally_stock_item | 1-n bom_line, lot | All | Standard cost (finance/management) |
| bom / bom_line | parent_item_id, child_item_id, qty, scrap_pct | self-relation via item | All | — |
| lot | id, item_id, lot_no, qty, status (ok/hold/reject), source (GRN/WO) | n-1 item | By site | — |
| customer, supplier | id, name, gstin, contact, tally_ledger | 1-n sales_order / po | Sales sees own customers (optional) | Credit limit, rates |
| sales_order / so_line | id, customer_id, promise_date, item_id, qty, rate | 1-n work_order, dispatch | Sales by own customers | Rate, value |
| work_order (operations schedule) | id, so_line_id, item_id, qty, line_id, planned_start/end, status | 1-n production_record | Supervisor by line | — |
| shift | id, site_id, name, start, end, planned_break_min | — | By site | — |
| production_record (operations performance) | id, work_order_id, work_unit_id, shift_id, date, operator_id, good_qty, reject_qty, rework_qty, run_min | n-1 work_order | Operator own rows; supervisor own line | — |
| downtime_event | id, work_unit_id, start, end, reason_code, planned (y/n) | n-1 work_unit | By line | — |
| inspection_plan / inspection_result | item_id, stage, characteristic, spec min/max; result: lot_id, value, pass/fail, inspector_id, photo | n-1 lot | QC all; production read-only own line | — |
| ncr / capa | id, lot_id, defect, disposition, root_cause, action, owner, due | n-1 lot | QA + owner of action | — |
| breakdown_ticket | id, asset_id, reported_by, reported_at, ack_at, closed_at, cause, action | n-1 asset | Maintenance all; requester own | — |
| pm_plan / pm_task | asset_id, frequency, checklist; task due/done | n-1 asset | Maintenance | — |
| stock_txn | id, item_id, lot_id, type (GRN/issue/transfer/adjust), qty, ref, tally_voucher_id, synced_at | n-1 item | Stores by site | Value |
| indent / po / po_line / grn | standard purchase fields, approval_status, approver_id | chain indent → po → grn | Requester own; purchase all | Rates, negotiated terms |
| dispatch | id, so_id, vehicle_no, lr_no, eway_bill_no, einvoice_irn | n-1 sales_order | Dispatch | — |
| employee | id, emp_code, name, dept, shift_id, contractor_id, skill | personnel model | HR all; supervisor own team | Salary, bank, Aadhaar, medical |
| attendance_punch / attendance_day | emp_id, timestamp, device_id; day status, OT minutes | n-1 employee | HR; supervisor own team | — |
| incident / permit | id, type, location, injured_emp_id, description, investigation | n-1 site | Safety officer all; reporter own | Injured person's medical details |
| audit_log | who, when, table, row, before/after | all | Admin only | — |

### Data volumes (Inference, for a 150-person, single-plant firm with 30 machines and 2 shifts)

| Table | Rows per year (order of magnitude) |
|---|---|
| production_record (one per machine per shift per WO) | 20k-40k |
| downtime_event | 20k-60k |
| inspection_result (one row per characteristic) | 50k-300k |
| stock_txn | 20k-100k |
| attendance_punch | 100k-200k (150 staff × 2-4 punches × 300 days) |
| breakdown_ticket + pm_task | 2k-5k |
| PO lines, SO lines | 2k-20k |

**Implication:** Appbuilder currently [loads at most 5,000 rows per table into an app](../../README.md#known-limits). Several manufacturing tables pass that within weeks, so server-side filtering, paging and aggregation (for OEE and dashboards) must work without loading whole tables.

## 5. Architecture and deployment

**How they deploy today (Inference unless linked).** Tally Gold is a [multi-user licence on a local network](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/), so many plants already have one "server PC" in the accounts office. ERP users split between on-premise and hosted. Plant internet is often a single broadband line; outages are common in industrial estates. Shop floors use Android phones; tablets are rare; supervisors have shared PCs.

**Integrations they expect:**

- **Tally.** TallyPrime acts as a server for third-party apps over XML/HTTP, can import masters and vouchers, and exposes some collections over ODBC; it must be running with its HTTP listener enabled ([Tally help](https://help.tallysolutions.com/tallyprime-as-server/)). **Inference:** a cloud or shared-hosted Appbuilder cannot reach Tally directly; a small Windows agent on the Tally PC that pulls masters and pushes approved vouchers is required. Fedena, for example, already lists [Tally integration](https://www.softwareadvice.com/school-management/fedena-profile/) as a feature, so buyers treat it as normal.
- **GST e-invoice and e-way bill.** E-invoicing is mandatory once AATO crossed ₹5 crore in any year since 2017-18; businesses at ₹10 crore and above must report to the IRP within 30 days; e-way bill login needs two-factor authentication since 1 April 2025 ([Tally Solutions, Sept 2026](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/)). **Inference:** leave this to Tally/GSP; store the IRN and e-way bill numbers as references.
- **Biometric attendance.** eSSL/ZKTeco-class devices can push punches to a server URL (ADMS/"push" mode), but third-party integrators report that [firmware support varies and ADMS can be unreliable](https://forum.camsbiometrics.com/how-to-integrate-zkteco-biometric-attendance-system-with-cloud-application/). Expect to support either a push endpoint or a CSV export import.
- **Barcode/QR.** Labels on lots, bins and assets; scanning from a phone camera or a USB scanner (a USB scanner types like a keyboard and works today in a desktop text box).
- **Weighing scales.** Serial/USB scales at GRN and dispatch. Needs a local bridge. Poor fit without one.
- **Machines.** PLC/SCADA via OPC UA or MQTT gateways for counts and run/stop status. **Inference:** out of scope for v1; partner with an IoT vendor and accept their data through an API/CSV.

**Mobile vs desktop split (Inference).** Roughly: planner, stores, purchase, QA head, maintenance planner, HR, management on desktop; operators, inspectors at the line, technicians, safety reporters on phones. In headcount terms, most users are on phones.

**Multi-site.** Common in the 200-500 staff band (two plants, a warehouse). Needs site-scoped row security and consolidated reports.

**Regulation:**

- **Labour.** The OSH Code came into force on 21 November 2025 and repealed the Factories Act 1948 among 13 laws; a "factory" is now 20+ workers with power or 40+ without; filings default to the Shram Suvidha portal; the central OSH rules were notified on 8 May 2026 and state rules are at different stages ([Keka compliance guide](https://www.keka.com/compliance/acts/occupational-safety-health-and-working-conditions-code); HR vendor summary, verify per state). **Inference:** the register formats are being re-defined state by state. This is a template opportunity (muster roll, OT register, accident register) but also a moving target; do not promise "statutory compliance" without a labour-law partner.
- **GST record keeping.** Books and records must be kept until 72 months after the due date of the annual return for that year, and electronic records are allowed if accessible at each place of business ([GST Gyaan on s.36 and Rule 56](https://www.gstgyaan.com/section-36-period-of-retention-of-accounts-records)). **Inference:** any stock or dispatch record Appbuilder holds that supports GST returns should be kept for at least 7-8 years, with a non-editable audit trail.
- **Data protection.** The DPDP Rules 2025 were notified on 14 November 2025; most obligations (notice, consent, security safeguards, breach notification, retention) apply from about **13 May 2027**, and a January 2026 proposal to shorten the timeline to 12 months had not been notified as of October 2026 ([MirvoLegal](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/); [The Privacy Labs](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts)). Security safeguards in Rule 6 include access control, logging and backups, and logs must be kept at least one year ([MirvoLegal](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/)). For manufacturers this mostly touches employee data (Aadhaar, bank, medical).

## 6. Gap analysis against Appbuilder

What the platform already covers: relational tables on MySQL; desktop forms and galleries; Excel-style formulas; roles with row filters (own-row scope) and column access; attachments (inspection photos, certificates); CSV/Excel import; basic bar/line/area/pie charts; a server-side audit log; solution packaging (useful for shipping templates); offline use on a single PC.

Ranked by how much each gap blocks a sale (**Inference**):

| Rank | Gap | Why it blocks | Effort hint |
|---|---|---|---|
| 1 | Multi-user hosting (PHP gateway / LAN mode) | Today the server listens only on 127.0.0.1; a plant needs 5-50 concurrent users | Already planned; LAN mode on a plant PC may be a faster first step than shared hosting |
| 2 | Flows: approvals, scheduled jobs, escalations | Indent/PO approvals, PM reminders and daily reports are must-haves | Large |
| 3 | Phone/portrait layouts | Floor data capture is the core value; operators use phones | Large (responsive or a separate phone form factor) |
| 4 | WhatsApp (and SMS) notifications | Breakdown and stock alerts are expected on WhatsApp | Medium (BSP API; templates) |
| 5 | Server-side aggregation and paging beyond 5,000 rows | Production and inspection tables exceed 5,000 rows quickly; OEE needs sums over months | Medium |
| 6 | Tally connector (local agent) | Without it, stores and dispatch apps double the data entry | Medium; must run on the Tally PC |
| 7 | PDF generation (PO, gate pass, NCR, reports) | Printed documents travel with goods and to vendors | Medium |
| 8 | Barcode/QR scanning and label printing | Stores and lot traceability | Small for USB scanner (works as keyboard) and QR image generation; medium for phone camera |
| 9 | Dashboards depth (targets, drill-down, Pareto, shift heatmaps) | MIS is what the owner sees and pays for | Medium |
| 10 | Offline tolerance on floor devices | Intermittent Wi-Fi on the floor | Large; LAN hosting reduces the need |
| 11 | Hierarchical row security (site → line → team) | "Supervisor sees own line" is more than own-row scope | Small-medium (**verify** what row filters support today) |
| 12 | Biometric and scale integration | HR and weighbridge apps | Medium; may be partner-led |
| 13 | Machine (OPC UA/MQTT) integration | Auto OEE | Large; partner instead |

### First 3 apps to build as templates

1. **Shift production log + OEE board.** Captures what no ledger holds (output, rejects, downtime reasons by machine and shift) and turns it into the KPI owners ask about first. Desktop board works today; the entry form needs a phone layout. Needs a daily WhatsApp/PDF summary to be sticky.
2. **Quality inspection + NCR.** Inspection plans, readings with photos as attachments, automatic NCR on failure, CAPA tracker. Fits the current platform best (inspection rooms often have PCs; attachments exist); customer audits (and ISO 9001-certified customers) create pull. Needs a PDF inspection report.
3. **Maintenance: breakdown tickets + PM schedule.** Small data, clear ROI (MTTR, MTBF, PM compliance), and little overlap with Tally or ERP. Needs escalations (flows) and phone ticket entry.

Why not stores/purchase first: they overlap with Tally and ERPs, need the Tally agent to avoid double entry, and are where incumbents are strongest.

## 7. Market reality check

**Incumbents (verified where linked):**

| Product | What it is | Price signal |
|---|---|---|
| TallyPrime | Accounting, GST, inventory; de facto ledger for Indian SMEs | Silver ₹22,500 + GST one-time; Gold ₹67,500; rental from ₹750/month; TSS renewal ₹4,500-13,500/year ([Tally, July 2026](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/)) |
| ERPNext (Frappe) | Open-source ERP with manufacturing (multi-level BOM, work orders, job cards, subcontracting, quality) and a no-code builder | Software free; Frappe Cloud hosting is compute-based with no per-user fee, tiers from about $14/month ([Frappe](https://frappe.io/erpnext)) |
| Odoo | Modular ERP incl. MRP; Studio low-code only on the Custom plan | About ₹580-725 (Standard) and ₹1,080-1,350 (Custom) per user per month in India ([oec.sh, Oct 2026](https://oec.sh/odoo-pricing/india); third-party tracker) |
| SAP Business One | Mid-market ERP via partners | Partner-quoted; one Indian partner cites implementation of about ₹10-50 lakh for 5-100 users ([Silver Touch](https://sap.silvertouch.com/blog/sap-business-one-pricing); figures dated) |
| Zoho Creator | Low-code platform, direct substitute for Appbuilder | About ₹480 / ₹1,200 / ₹1,500 per user per month for Standard / Professional / Enterprise ([Codroid, Sept 2026](https://codroiditlabs.com/zoho-creator-pricing-india/); partner page, **verify on Zoho**) |
| Machine-monitoring startups | Sensor + cloud OEE (e.g. Leanworx, Factana, TrackMyMachines) | Per-machine subscriptions; not verified in INR |

**Why a small manufacturer would choose a low-code platform:** their process does not fit an ERP (job shops, mixed make-to-order); they already "live in Excel" and want structured Excel with permissions; they want one or two apps (QC, maintenance) without an ERP project. The vendor survey's figures that [61% of ERP implementations ran over budget and 9% were rolled back](https://www.bsquare.in/images/BSquare_ERP_Adoption_Report_2026_FINAL_updated%20.pdf) (vendor-run, self-reported) support the "small, fast app" pitch.

**Why they would not:** owners buy outcomes, not platforms. They have no in-house "maker". ERPNext already includes a manufacturing module, quality checks and a no-code builder for free, and Zoho Creator has mobile apps, a partner network and a brand. A desktop-only, single-PC product with no flows is not competitive with either today.

**Realistic wedge (Inference):**
- Sell **finished templates** (production log/OEE, QC/NCR, maintenance) with a flat yearly site price (for example ₹30-60k/year per plant, **untested**), not per-user licences that punish shop-floor headcount.
- Position as **"the shop-floor layer next to Tally"**, with a Tally agent as the moat that generic low-code tools lack.
- Install on the existing Tally/server PC in the plant (LAN), which also answers poor internet and data-ownership worries.
- Do the configuration as a service; the low-code Studio is your delivery tool and the customer's later customisation option, not the headline.
- Target a cluster (one industrial estate or one sub-sector such as auto components or plastics moulding) so templates can be specific.

Blunt view: if you cannot ship flows, a phone layout and WhatsApp alerts, do not lead with manufacturing. ERPNext, Zoho Creator and Tally plus Excel are good enough for most buyers, and the floor-side apps where you could win need exactly the features you lack.

## Sources

- [CII-ISB MSME study (Business Standard, Oct 2026)](https://www.business-standard.com/amp/economy/news/two-thirds-of-msmes-use-ai-but-only-21-deploy-business-software-study-126101301191_1.html)
- [B-Square Indian Manufacturing ERP Adoption Report 2026 (vendor survey)](https://www.bsquare.in/images/BSquare_ERP_Adoption_Report_2026_FINAL_updated%20.pdf)
- [OEE.com: Calculating OEE](https://www.oee.com/calculating-oee/)
- [ISO 22400-2:2014 catalogue page](https://www.iso.org/standard/54497.html)
- [Teeptrak: Availability, performance, quality](https://teeptrak.com/en/availability-performance-quality/)
- [UpKeep: MTBF and MTTR](https://www.upkeep.com/blog/improve-reliability-with-mtbf-and-mttr)
- [OPC Foundation: ISA-95 companion specification overview](https://reference.opcfoundation.org/specs/OPC-10030/4.1)
- [Tally Help: TallyPrime as server](https://help.tallysolutions.com/tallyprime-as-server/)
- [Tally Solutions: TallyPrime total cost of ownership](https://tallysolutions.com/business-guides/tallyprime-total-cost-of-ownership-india/)
- [Tally Solutions: What changed in e-invoicing compliance in 2026](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/)
- [GST Gyaan: Section 36 retention of accounts](https://www.gstgyaan.com/section-36-period-of-retention-of-accounts-records)
- [Keka: OSH Code 2020 compliance guide](https://www.keka.com/compliance/acts/occupational-safety-health-and-working-conditions-code)
- [MirvoLegal: DPDP Rules compliance timeline (Sept 2026)](https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/)
- [The Privacy Labs: What starts on 13 November 2026](https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts)
- [Meta: WhatsApp Business Platform pricing](https://developers.facebook.com/docs/whatsapp/pricing/)
- [Message Central: India SMS/DLT guidelines](https://www.messagecentral.com/sms-guideline/india)
- [CAMS forum: ZKTeco push integration](https://forum.camsbiometrics.com/how-to-integrate-zkteco-biometric-attendance-system-with-cloud-application/)
- [Frappe: ERPNext](https://frappe.io/erpnext)
- [oec.sh: Odoo pricing in India](https://oec.sh/odoo-pricing/india)
- [Silver Touch: SAP Business One pricing](https://sap.silvertouch.com/blog/sap-business-one-pricing)
- [Codroid: Zoho Creator pricing India 2026](https://codroiditlabs.com/zoho-creator-pricing-india/)
- [The Machine Maker: Leanworx seed funding](https://themachinemaker.com/news/leanworx-secures-inr-8-3-crore-in-seed-funding-led-by-yournest-venture-capital/)
- [Capterra: TrackMyMachines](https://www.capterra.in/software/1071514/TrackMyMachines)
- [Software Advice: Fedena profile (Tally integration listed)](https://www.softwareadvice.com/school-management/fedena-profile/)
