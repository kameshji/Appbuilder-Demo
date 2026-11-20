# The Manufacturing pack

A ready-made solution for a small plant (20 to 50 people): what was made on which machine and shift, why machines
stopped, what quality found and what was decided about it, what maintenance did and what is due, and what one shift hands
to the next. It installs from **Templates > Solutions > Manufacturing** like any solution template
([Templates](templates.md)): Linked (upgradable) by default, through the binding step and the plan screen, in one step
that either completes or changes nothing.

It records; it does not certify. Nothing in it makes a plant compliant with a standard; it keeps the records people
usually ask for (inspection results, NCRs with their disposition and approval, maintenance history).

## What it contains

| Part | What |
| --- | --- |
| Tables (16 + 1 shared) | Masters: **Lines**, **Machines** (code, line, ideal cycle, status, technician), **Shifts**, **Downtime reasons**, **Defect types**; Products is the common business model's table (shared). Production: **Work orders**, **Production log**, **Downtime**. Quality: **Inspection plans**, **Inspections**, **Inspection defects**, **Non-conformance reports** (NCRs). Maintenance: **Maintenance requests** (the maintenance work orders), **Preventive maintenance plans**, **Preventive maintenance tasks**. **Shift handovers**. |
| Phone apps (3) | **Shop floor** (operators: scan the machine's QR code, log production with a photo, record a stoppage; works offline), **Inspection** (inspectors: scan the lot, result, measured value, photo, signature, defects; works offline), **Maintenance** (technicians: my open requests, acknowledge, close with cause, action and signature; preventive tasks; report a breakdown; works offline). |
| Desktop apps (4) | **Supervisor console** (today, production log, downtime, work orders, shift handover), **Quality desk** (inspections with defects, NCRs and sending them for approval, inspection plans, defect types; prints), **Maintenance planner** (requests, plans, tasks, machine status, MTTR and MTBF), **Plant setup** (lines, machines and their QR labels, shifts, downtime reasons). |
| Flows (10, arrive off) | Raise an NCR for a failed inspection; NCR disposition approval; Breakdown creates a maintenance request; Route and escalate a maintenance request (technician of the machine, else the Maintenance role; plant manager after 30 minutes without acknowledgement); External repair cost approval (above Rs 25,000); Create preventive maintenance tasks (daily 06:00); Daily OEE PDF to the plant managers (daily 07:00); Remind owners of overdue NCR actions (09:30, Monday to Saturday); Tell the next supervisor about a handover; Remind supervisors to write the handover (05:45, 13:45, 21:45). Times are India time (Asia/Kolkata). |
| Approval policies (2) | NCR disposition (the Quality role, not the person who asked), External repair cost (the Plant manager role). |
| Dashboards (3) | **Plant overview** (the built-in Production overview: OEE gauge, good quantity, scrap rate, availability/performance/quality by shift, good by day, downtime Pareto, output by machine; plus first-pass yield, inspections, NCRs, defects by type, MTTR, open requests, PM compliance, schedule adherence), **Shift board**, **Quality and maintenance**. |
| Print templates (6) | Inspection report (the built-in one, bound to the pack), Daily OEE summary (the built-in one over the pack's production log, for yesterday), NCR, Maintenance work order, Shift handover sheet, Machine QR labels. |
| Roles (5) | Operator, Supervisor, Quality, Maintenance, Plant manager (who sees what: below). |
| Number sequences (5) | `WO/2026-27/0001`, `INS/2026-27/00001`, `NCR/2026-27/0001`, `MR/2026-27/0001`, `PM/2026-27/0001`: they restart every financial year (April to March). |
| Reference rows | Shifts A (06:00-14:00), B (14:00-22:00), C (22:00-06:00), 30 minutes of breaks, 450 planned minutes; 12 downtime reasons in the six categories; 8 defect types. |
| SAMPLE rows (optional) | A fictional press shop: 2 lines, 4 machines (`SAMPLE-P1` to `SAMPLE-P4`), 3 days of production and stoppages, inspections, an NCR, requests, plans and a handover. **Remove sample data** on the Templates page deletes exactly these rows. |

The names of shifts, downtime reasons and defect types are **data**: they come in English with Hindi
(`Mechanical breakdown · यांत्रिक खराबी`); change them into your plant's words and language in Plant setup. The phone
apps' button texts are named formulas at the top of each app (**Settings > App.Formulas**, for example `TxtLogProduction`),
so a maker translates them in one place. Appbuilder itself does not switch languages per person.

## The first day in the plant

1. **Install** (an administrator, best in a sandbox environment first): Templates > Solutions > Manufacturing > Use.
   The common business model is installed first (its Products table is shared). If you already have a table called
   `ProductionLog` (or any other name the pack uses), choose **use the pack's prefixed name** (`MfgProductionLog`) or
   map it. Tick **Add the SAMPLE rows** to try it out. Review the plan, **Install**.
2. **Switch on the flows** you want (the last step of the install, or Flows later). They run as the administrator who
   installed the pack.
3. **Assign people to roles** (Admin console > Users): the pack carries no people. Put each supervisor's operators in a
   **team** with the supervisor (Admin console > Organisation): the supervisor's "team" scope means rows of the team's
   members.
4. **Plant setup**: replace the SAMPLE lines and machines with yours (code, ideal cycle time in seconds, the technician
   who gets its breakdowns), check the shifts (start and end hour, planned minutes), the downtime reasons and defect
   types. Then **Remove sample data** (Templates > Installed).
5. **Print the machine QR labels** (Plant setup > Machines > Print QR labels) and stick them where the operator stands.
   The label holds the machine code; a handheld scanner or the phone camera reads it.
6. **Email**: the daily OEE PDF and email notifications need the server's email settings (Admin console) and an **Email
   connection** in this environment (Connections > New > Email). The daily PDF goes to everyone with the Plant manager
   role.
7. **Phones**: the camera and working offline need HTTPS ([Phones on the local network](../../admin/phones.md)). Open
   each phone app once with a connection on each phone ([Phone apps](phone-apps.md)).
8. **Deploy**: when it works in the sandbox, deploy the solutions to production (Solutions > the solution > Deploy):
   first the common business model's, then the Manufacturing pack's. Flows arrive off in production too.

## Who sees what

| Role | Production log, downtime | Inspections, defects, NCRs | Maintenance requests | PM plans and tasks | Shift handovers | Masters (lines, machines, shifts, reasons, defect types) |
| --- | --- | --- | --- | --- | --- | --- |
| Operator | adds; sees and edits **own** rows | none | adds; sees **own**; repair cost and its approval hidden | none | none | reads |
| Supervisor | adds; sees and edits the **team's** rows | reads | adds; reads all; edits own | reads tasks | adds; reads and edits all (acknowledges) | reads; work orders: adds and edits |
| Quality | reads all | adds and edits all; NCR disposition approval | none | none | none | reads; inspection plans and defect types: adds and edits |
| Maintenance | reads all | none | adds, reads and edits all | adds, reads and edits all | none | reads; machines: edits (status, technician) |
| Plant manager | reads and edits all | reads all; NCRs: edits | reads and edits all; repair cost approval | plans: all; tasks: reads | reads | adds and edits all |

Administrators see everything. The flows run as the installing administrator, so the requests and NCRs they create
belong to that administrator (an operator sees the requests they reported themselves, not those a breakdown created).

## How the numbers are computed

OEE, availability, performance, quality, scrap rate, first-pass yield, MTTR and schedule adherence are the built-in
measures of [Dashboards](dashboards.md) (sums over the rows, never averages of ratios). The pack's columns keep the
names those measures use (`LoggedOn`, `Shift`, `Machine` as a text code, `Good`, `Scrap`, `PlannedMin`, `RunMin`,
`IdealCycleSec`; `StartedOn`, `Reason`, `Minutes`), so the presets work on the pack's tables.

- **Rejected quantity** (`Scrap`) is every unit that was not good the first time, scrapped or reworked; **Of which
  reworked** says how many of them were reworked. So quality and first-pass yield are good / (good + rejected).
- The server fills the **ideal cycle** from the machine and the **planned minutes** from the shift when an entry leaves
  them blank, and the operator from the person who saved it. The phone prefills **run minutes** with the shift's planned
  minutes: the operator subtracts the stoppages.
- **MTBF** (Maintenance planner) is run minutes / breakdowns over all rows; a dashboard tile reads one table, so MTBF is
  not a tile.
- **PM compliance**: tasks done by their due date / tasks due (skipped tasks left out).

## Rules the pack adds

Before saving: machine codes in capitals and must exist; quantities not negative and rework within rejected; run minutes
within the planned minutes; a stoppage ends after it starts (minutes computed from the times, the category from the
detail); an inspection measured outside its plan's limits is saved as **Fail**; an NCR needs a disposition before it is
sent for approval and an approved disposition and an action before it closes; a maintenance request closes with a cause
and an action, and an external repair above Rs 25,000 needs the plant manager's approval first; a handover is
acknowledged by someone other than the person who wrote it. Change the limit in the table's events (Tables > Maintenance
requests > Events) and in the flow's description.

## Upgrades

The pack is Linked: a newer version shows **Upgrade** on the Templates page, with every component you changed listed
(keep is the default). Your data rows are never changed by an upgrade; new columns and reference rows are added; a
reference row you edited (a downtime reason you renamed) is kept.

## Not included (honest list)

- Production planning (MRP), BOMs, stores and stock, costing, payroll, attendance; machine connections (PLC, OPC UA,
  sensors): counts are typed or scanned by people.
- **Scheduled reports** cannot be part of a pack yet: the daily OEE PDF is a scheduled **flow** that emails the PDF; set
  up a scheduled report or a dashboard snapshot by hand if you prefer those.
- WhatsApp alerts: the flows notify in the app and by email. Add a WhatsApp step to a flow yourself
  ([WhatsApp](whatsapp.md)) once your connection is set up.
- The shift handover is on the desktop (Supervisor console), not in a phone app.
- List column headings in the apps are the column names (spaced), not the display names.
- Escalation after 30 minutes and the Rs 25,000 limit are fixed in the flow and the rules; edit them there.
- After **Remove sample data**, a pack table left empty (for example Lines, if you added none) blocks **Uninstall
  keeping tables** while a table you keep looks it up: add your own rows first, or tick **Delete tables with data**.
- Data Matrix labels need Chrome on Android or a handheld scanner; QR and Code 128 work on every phone.
- Not tried on a real phone yet: the checks ran in Chrome's phone emulation.
