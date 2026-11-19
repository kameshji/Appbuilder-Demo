import { url, shot, badge, iconBox, ctaBand, crumbs, docs, esc, NAME } from "../layout.mjs";

export const solutionsIndex = {
  path: "/solutions/",
  og: "solutions",
  title: "Solutions",
  description: "Who {name} is for: small manufacturers first, and other organisations of 20 to 50 people that outgrew Excel and WhatsApp.",
  build() {
    const cr = crumbs([["/", "Home"], ["/solutions/", "Solutions"]]);
    this.jsonld = [cr.ld];
    return `<section class="page-hero"><div class="container">${cr.html}<span class="eyebrow">Solutions</span><h1>Who ${esc(NAME)} is for</h1><p class="lead">We start narrow on purpose: small manufacturers in India, where the gap between Tally and the shop floor is widest. The same platform fits other small organisations with registers and requests in spreadsheets.</p></div></section>
<section class="section-tight"><div class="container"><div class="grid grid-2">
<a class="card card-link" href="${url("/solutions/manufacturing/")}">${iconBox("factory")}<h2 class="h3">Manufacturing</h2><p>Production logs, quality inspection and maintenance registers around Tally.</p><span class="more">Manufacturing →</span></a>
<a class="card card-link" href="${url("/solutions/other-teams/")}">${iconBox("people")}<h2 class="h3">Other teams</h2><p>Trading, services, institutes and trusts that outgrew Excel and WhatsApp.</p><span class="more">Other teams →</span></a>
</div></div></section>${ctaBand()}`;
  },
};

const example = (title, built, cols, extras) => `<div class="card">
  <h3>${title}</h3>
  <p class="small muted">Example of what can be built today. Not a customer project.</p>
  <p>${built}</p>
  <p><strong>Tables and columns:</strong> ${cols}</p>
  <ul class="checks">${extras.map((e) => `<li>${e}</li>`).join("")}</ul>
</div>`;

export const manufacturing = {
  path: "/solutions/manufacturing/",
  og: "manufacturing",
  title: "For small manufacturers",
  description: "Production logs, quality inspection and maintenance registers for small manufacturers, built on {name} today on a PC in the plant office. Ready-made templates are planned.",
  build() {
    const cr = crumbs([["/", "Home"], ["/solutions/", "Solutions"], [this.path, "Manufacturing"]]);
    this.jsonld = [cr.ld];
    return `<section class="page-hero"><div class="container">${cr.html}
<span class="eyebrow">Manufacturing</span>
<h1>The shop-floor records that Tally does not keep</h1>
<p class="lead">Tally runs the accounts. The production log, the inspection sheet and the breakdown register run on paper, Excel and WhatsApp. ${esc(NAME)} is for that layer: apps your supervisors, QC and maintenance staff use every day, on a PC in the plant office, with the data staying in the plant.</p>
<div class="btn-row"><a class="btn btn-primary" href="${url("/pilot/")}">Request a pilot</a><a class="btn btn-secondary" href="#examples">See examples</a></div>
</div></section>

<section class="section-tight"><div class="container">
<div class="feature">
  <div><h2>One table, three views of it</h2>
  <p>The supervisor of Line 1 sees and edits only Line 1's batches. The plant manager sees every line in their department. Accounts sees cost columns nobody else sees. That is one table with security roles, not three spreadsheets.</p>
  <p class="small muted">Screenshot with sample data.</p></div>
  ${shot("restricted-supervisor-grid", { alt: "A Production table as seen by a line supervisor: batches B-101 to B-103 on Line 1 with quantities 120, 80 and 40, and system columns marked read-only." })}
</div>
</div></section>

<section class="section section-alt" id="examples" aria-labelledby="ex-h"><div class="container">
<div class="section-head"><span class="eyebrow">What you can build today ${badge("available")}</span><h2 id="ex-h">Three apps most plants start with</h2>
<p class="lead">These are built from the platform's parts today: tables, forms, formulas, roles, tasks, comments and scheduled email reports. We build the first one with you in a pilot.</p></div>
<div class="grid grid-3">
${example("Production log", "Supervisors enter output per batch, line and shift. Totals by line and day are kept by the server; the plant manager gets a daily email report.", "Batch, Line, Shift, Product, Planned qty, Good qty, Rejected qty, Downtime minutes, Remarks.", ["Row rules: each supervisor sees their own line", "Validation: Good + Rejected cannot exceed Planned", "Daily 8 AM report by email, per line"])}
${example("Quality inspection and NCR", "Inspectors fill in a checklist per lot, attach photos of defects, and raise a non-conformance with an owner and due date.", "Inspection (Lot, Product, Inspector, Result pass/fail, Photos), NCR (Inspection, Cause, Action, Owner, Due date, Status).", ["Tasks and @mentions on each NCR", "Timeline shows who changed what", "Closed NCRs read-only for everyone but QC head"])}
${example("Maintenance register", "Operators log a breakdown, the technician records what was done, and downtime per machine adds up by itself.", "Machine (Name, Line, Make), Breakdown (Machine, Start, End, Cause, Action, Technician, Spares used).", ["Rollup: total downtime per machine", "Formula column: hours down per breakdown", "Assigned technician gets a notification"])}
</div>
</div></section>

<section class="section-tight"><div class="container">
<h2>What is planned for manufacturing ${badge("planned")}</h2>
<div class="grid grid-2">
<div class="card"><h3>Templates</h3><p>A manufacturing pack with production log and OEE, quality inspection with NCR, and breakdown and preventive maintenance, installable in one step. Planned, not built.</p></div>
<div class="card"><h3>On the floor</h3><p>Phone layouts for entry at the machine, WhatsApp alerts and PDF reports such as a daily OEE sheet. Planned, not built. Today, entry is best on a desktop or laptop.</p></div>
<div class="card"><h3>Tally</h3><p>There is no Tally connector today. A data exchange with Tally is planned as an optional connector, built when a pilot needs it.</p></div>
<div class="card"><h3>Approvals</h3><p>Purchase requests, material issues and rework sign-off with approvals. Flows and approvals are <a href="${url("/product/automation/")}">in progress</a>.</p></div>
</div>
<p class="small muted mt">Background research behind this page: <a href="${docs("research/manufacturing.md")}">manufacturing sector research</a> (November 2026).</p>
</div></section>
${ctaBand("en", "Run a plant of 20 to 200 people?", "We are looking for one or two small manufacturers to be our first pilots. We install it with you and build the first apps together.")}`;
  },
};

export const otherTeams = {
  path: "/solutions/other-teams/",
  og: "other-teams",
  title: "For other teams that outgrew Excel",
  description: "Trading firms, service companies, institutes and trusts of 20 to 50 people can use {name} for registers, requests and trackers that live in spreadsheets today.",
  build() {
    const cr = crumbs([["/", "Home"], ["/solutions/", "Solutions"], [this.path, "Other teams"]]);
    this.jsonld = [cr.ld];
    const uses = [
      ["Enquiries and follow-ups", "Leads with an owner, next action and date; overdue ones in a daily email."],
      ["Requests and registers", "Purchase, leave, asset and visitor registers with the right people seeing the right rows."],
      ["Field and service jobs", "Jobs, visits and checklists, entered from the office today (phone layouts planned)."],
      ["Admissions and fees desk", "For coaching institutes and colleges: enquiries, batches, instalments, with salary and concession columns hidden by role."],
    ];
    return `<section class="page-hero"><div class="container">${cr.html}
<span class="eyebrow">Other teams</span><h1>For offices that outgrew Excel and WhatsApp</h1>
<p class="lead">If your organisation has 20 to 50 people, a handful of shared sheets nobody trusts, and approvals that happen in chat, ${esc(NAME)} may fit. Manufacturing is our first focus, so expect to be an early adopter.</p></div></section>
<section class="section-tight"><div class="container">
<div class="grid grid-2">${uses.map(([h, p]) => `<div class="card"><h2 class="h3">${h}</h2><p>${p}</p><p class="small muted">Example use, not a customer project.</p></div>`).join("")}</div>
<div class="note mt"><p><strong>Good fit:</strong> most work is done at desks; you want data on your own machine; one person enjoys Excel formulas. <strong>Not yet a fit:</strong> most users are on phones, you need a parent or customer portal, online payments, or WhatsApp messages today. Those are planned, not built.</p></div>
</div></section>
${ctaBand()}`;
  },
};
