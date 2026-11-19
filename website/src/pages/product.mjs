import { url, shot, badge, icon, iconBox, ctaBand, crumbs, docs, config, esc, NAME, softwareLd } from "../layout.mjs";

const hero = (cr, eyebrow, h1, lead, extra = "") => `
<section class="page-hero"><div class="container">
  ${cr.html}
  <span class="eyebrow">${eyebrow}</span>
  <h1>${h1}</h1>
  <p class="lead">${lead}</p>
  ${extra}
</div></section>`;

const feature = (flip, eyebrow, h2, body, shotHtml) => `
<div class="feature${flip ? " flip" : ""}">
  <div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ""}<h2>${h2}</h2>${body}</div>
  ${shotHtml}
</div>`;

const notYet = (items, heading = "Not built yet") => `
<div class="note warn"><p><strong>${heading}</strong></p><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;

const docLinks = (links) => `<section class="section-tight"><div class="container"><h2 class="h3">Read more in the documentation</h2><ul class="pill-list">${links.map(([p, l]) => `<li><a href="${docs(p)}">${l}</a></li>`).join("")}</ul></div></section>`;

const P = (path, label) => [["/", "Home"], ["/product/", "Product"], [path, label]];

export const productIndex = {
  path: "/product/",
  og: "product",
  title: "Product overview",
  description: "What {name} does today: apps and Studio, data and security, collaboration, environments, backups and installers. Automation is in progress; more is planned.",
  sitemap: { priority: "0.8" },
  build() {
    const cr = crumbs([["/", "Home"], ["/product/", "Product"]]);
    this.jsonld = [softwareLd(), cr.ld];
    const card = (href, ic, h, b, p) => `<a class="card card-link" href="${url(href)}">${iconBox(ic)}<h2 class="h3">${h} ${badge(b)}</h2><p>${p}</p><span class="more">Read more →</span></a>`;
    return `${hero(cr, "Product", `What ${esc(NAME)} does`, `One install on your own machine that gives a 20 to 50 person organisation apps, data with security built in, collaboration and safe ways to change things. Each page shows real screenshots and says plainly what is not built yet.`)}
<section class="section-tight"><div class="container"><div class="grid grid-3">
${card("/product/apps-studio/", "apps", "Apps and Studio", "available", "Design screens by drag and drop, write behaviour in Excel-style formulas, and give people apps that open as tabs.")}
${card("/product/data-security/", "shield", "Data and security", "available", "Tables, validation rules, formula columns, rollups, a visual data model, and roles down to rows and columns.")}
${card("/product/automation/", "flow", "Automation", "progress", "Flows on data changes, schedules and buttons; approvals. Scheduled email reports already work.")}
${card("/product/collaboration/", "chat", "Collaboration", "available", "Tasks, comments, mentions and a timeline on every record; live updates and notifications.")}
${card("/product/admin-operations/", "server", "Admin and operations", "available", "Environments with deploy, nightly backups and restore, installers, updates, logs and audit.")}
<a class="card card-link" href="${url("/#road-h")}">${iconBox("clock")}<h2 class="h3">What's coming ${badge("planned")}</h2><p>Phone layouts, PDF output, dashboards, WhatsApp alerts, templates, chat, AI agents and more.</p><span class="more">See the plan →</span></a>
</div></div></section>
${ctaBand()}`;
  },
};

export const appsStudio = {
  path: "/product/apps-studio/",
  og: "apps-studio",
  title: "Apps and Studio",
  description: "Build business apps by drag and drop with Excel-style formulas. Start from a table, add search, filters and buttons, preview, and give people apps that open as tabs.",
  build() {
    const cr = crumbs(P(this.path, "Apps and Studio"));
    this.jsonld = [cr.ld];
    return `${hero(cr, "Apps and Studio " + badge("available"), "If you can write an Excel formula, you can build the app", "The Studio is a canvas for designing screens. You place UI components (tables, forms, inputs, buttons, galleries, dialogs and more), connect them to your tables, and describe what they do with short formulas.")}
<section class="section-tight"><div class="container">
${feature(false, "Start from your data", "From a table to a working app in one click", `<p>Pick a table and choose <strong>Start with data</strong>. ${esc(NAME)} creates an app with a list of rows and a form to add and edit them, then opens it in the Studio for you to shape.</p><ul class="checks"><li>Desktop design sizes (Full HD and larger) with responsive or fit-to-window scaling</li><li>Screens, dialogs, sheets and navigation between them</li><li>Undo, copy and paste, snapping, alignment and auto-layout</li></ul>`,
  shot("home-start-with-data", { alt: "The Start with data dialog on the Home page: the Equipment table is selected, with a choice of design size, and a Create app button." }))}
${feature(true, "Formulas", "Behaviour in a language you already know", `<p>Formulas look like Excel: <code>Filter</code>, <code>If</code>, <code>DateAdd</code>, <code>Today</code>, <code>Patch</code> to save a record, <code>Notify</code> to show a message. The formula bar checks them as you type and shows the result.</p><p>Filters, sorting and totals over tables run in the database, so a table with a million rows stays usable.</p>`,
  shot("studio-button-onselect", { alt: "The Studio with a Check out button selected and its OnSelect formula: Patch the selected equipment row with CheckedOut true, the current user and a due date seven days from today, then Notify." }))}
${feature(false, "For your users", "Apps open like browser tabs", `<p>People who only use apps get <strong>User mode</strong>: a launcher with search and recently opened apps, and every app they open becomes a tab. Makers switch to <strong>Dev mode</strong> to build. Apps can also run in their own window.</p><p>Apps and whole solutions can be exported as packages and imported on another install.</p>`,
  shot("user-mode-tabs", { alt: "User mode: the My apps launcher with two apps, Contacts app and Contacts mobile, each opened as a tab under the top bar." }))}
${notYet(["Layouts designed for phones, and an offline phone app (planned)", "Ready-made app templates for manufacturing, CRM and ERP (planned)", "Generating PDF documents from an app (planned)"], "Not built yet (planned)")}
</div></section>
${docLinks([["guide/maker/studio.md", "The Studio"], ["guide/maker/formulas.md", "Formulas tutorial"], ["reference/formulas.md", "Formula reference"], ["reference/ui-components.md", "UI components reference"], ["guide/maker/apps.md", "Apps"]])}
${ctaBand()}`;
  },
};

export const dataSecurity = {
  path: "/product/data-security/",
  og: "data-security",
  title: "Data and security",
  description: "A built-in PostgreSQL database with validation rules, formula columns, rollups and a visual data model; role-based, row-level and column-level security enforced by the server; two-step verification and an audit log.",
  build() {
    const cr = crumbs(P(this.path, "Data and security"));
    this.jsonld = [cr.ld];
    return `${hero(cr, "Data and security " + badge("available"), "A real database, with rules about who sees what", `Your tables live in PostgreSQL on your own machine. The server checks every request against your security roles, for every app, so a rule written once applies everywhere. <a href="${url("/security/")}">What we do and do not claim about security</a>.`)}
<section class="section-tight"><div class="container">
${feature(false, "Tables", "Columns with types, and rules the server keeps", `<p>Text, numbers, currency, dates, choices, lookups to other tables, images, file attachments and autonumbers. Import CSV files, connect Excel, CSV and JSON files as data files, or link existing PostgreSQL, MySQL/MariaDB databases and Google Sheets.</p><ul class="checks"><li><strong>Validation rules</strong>: a formula that must be true, checked on every save from every app, import and API call</li><li><strong>Formula columns</strong>: values the server calculates, such as <code>Qty * Price</code></li><li><strong>Rollups</strong>: totals and counts from related rows, kept up to date</li></ul>`,
  shot("events-validation-rule", { alt: "Validation rules tab of the Invoice lines table: a rule named Positive quantity with the formula Qty > 0 and the message Quantity must be more than 0." }))}
${feature(true, "Data model", "See and design your tables as a diagram", `<p>The data model designer shows tables and their relationships on a canvas. Add tables and columns, draw relationships with delete behaviour, apply common patterns, review a draft before it is applied, and create read-only reporting views. A backup is taken before changes are applied.</p>`,
  shot("datamodel-canvas", { alt: "The data model designer: Invoice and Invoice line tables joined by a cascade relationship, a reporting area with dimension and fact views, and an inspector panel on the right." }))}
${feature(false, "Security roles", "Rows and columns, not just apps", `<p>A role says what its members may create, read, update and delete in each table, which rows (their own, their team's, their department's, or any condition), and which columns are hidden or read-only. Roles also decide which apps people can open.</p><ul class="checks"><li><strong>Test as user</strong> shows exactly what one person can see, and why</li><li><strong>Who can see this row?</strong> lists every person with access and the rule that grants it</li><li>Record sharing, teams, departments and an organisation chart</li></ul>`,
  shot("roles-rule-builder", { alt: "A security role editor: table privileges for create, read, update, delete and share, and a row rule that limits a Production table to lines where the supervisor is the current user." }))}
${feature(true, "What a user sees", "The same table, trimmed for each person", `<p>Here a supervisor opens the Production table: only the rows for their line, with system columns read-only. Another role might not see the table at all. The rules are enforced on the server, not just hidden in the screen.</p>`,
  shot("restricted-supervisor-grid", { alt: "The Production table as seen by the supervisor Ravi Kumar: three batches on Line 1, with a notice that id, createdOn, Modified on, createdBy and owner are read-only for him." }))}
${feature(false, "Sign-in and audit", "Two-step verification and an audit log", `<p>Passwords are hashed with scrypt and checked against a list of common passwords. Two-step verification works with an authenticator app or email codes, with recovery codes. Administrators can see and end sessions. A sign-in log and an audit log record who signed in and who changed data, apps and settings.</p>`,
  shot("identity-second-step", { alt: "The two-step verification screen asking for the 6-digit code from an authenticator app, with an option to remember the device for 30 days." }))}
${notYet(["Single sign-on with a company identity provider, and passkeys (planned)", "Encryption of data at rest (backups can be encrypted with a passphrase today)", "A review by an outside security firm (planned before pilots go beyond one company)"], "Not built or not done yet")}
</div></section>
${docLinks([["guide/maker/data.md", "Tables and data"], ["guide/maker/data-model.md", "Data model designer"], ["guide/maker/security-for-makers.md", "Security for makers"], ["admin/security-model.md", "Security model"], ["admin/users-and-roles.md", "Users and roles"]])}
${ctaBand()}`;
  },
};

export const automation = {
  path: "/product/automation/",
  og: "automation",
  title: "Automation: flows and approvals (in progress)",
  description: "Flows and approvals for {name} are in progress. The flow engine runs in development builds; the visual designer and approvals are being built. Scheduled email reports are available now.",
  build() {
    const cr = crumbs(P(this.path, "Automation"));
    this.jsonld = [cr.ld];
    return `${hero(cr, "Automation " + badge("progress"), "Flows and approvals are being built", "This page describes work in progress. It is not in the 0.5.0 release. We show it because pilots will decide how it ends up, and because a purchase request with an approval is usually the first thing a small company wants automated.")}
<section class="section-tight"><div class="container">
<div class="note warn"><p><strong>Status, November 2026.</strong> Development builds already run flows: triggers on table changes, schedules, a button in an app or a web request; steps such as conditions, loops, create or update a row, notify, send email, call a connector, and wait. Flows are defined in a JSON editor with validation, and every run is recorded step by step. Still to come: the visual flow designer and approvals (an inbox, approve or reject from email). Nothing here is metered per run.</p></div>
${feature(false, "Run history", "Every run, every step, inputs and outputs", `<p>When a flow runs you can open it and see each step, how long it took, and what went in and out, with secrets removed. Failed runs can be resubmitted from the start or from the failed step.</p><p class="small muted">Screenshot from a development build. Example flow: mark purchase requests above a limit for review and log them.</p>`,
  shot("flows-run-detail", { alt: "Run detail of a flow called Big purchase check: four steps (Message, Mark, Log, Tell) all succeeded, with the Log step expanded to show its input and output." , label: "Development build" }))}
${feature(true, "", "Flows list with health at a glance", `<p>The Flows page lists each flow with its trigger, state, success rate over seven days, last run and owner. Flows run as their owner, the person who triggered them, or a service account chosen by an administrator, and they go through the same security rules as apps.</p>`,
  shot("flows-list", { alt: "The Flows page listing a flow named Big purchase check, triggered by the PurchaseRequests table, on, with 100 percent success over seven days, and a recent runs table below.", label: "Development build" }))}
${feature(false, "Available now " + badge("available"), "Scheduled reports by email", `<p>Build a report by clicking (columns, filters, sorting, grouping and totals) or with a formula, pick a schedule and recipients, and each person receives a table and a CSV file with only the rows and columns they are allowed to see.</p>`,
  shot("reports-builder", { alt: "The New scheduled report dialog: an Open orders report on the Sales orders table, filtered to status Open, with a preview of three customers and amounts, and a daily schedule at 9 AM." }))}
${notYet(["Visual flow designer (in progress)", "Approvals with an inbox and approve/reject from email (in progress)", "WhatsApp messages from flows (planned)", "PDF documents from flows (planned)"], "Not built yet")}
</div></section>
${docLinks([["guide/maker/flows.md", "Flows (maker guide)"], ["guide/maker/scheduled-reports.md", "Scheduled reports"], ["guide/maker/notifications.md", "Notifications"], ["guide/maker/connections-and-actions.md", "Connections and actions"]])}
${ctaBand("en", "Have an approval that runs on WhatsApp today?", "Purchase requests, leave, material issues, rework sign-off: tell us which one. Pilots decide what the approval module does first.")}`;
  },
};

export const collaboration = {
  path: "/product/collaboration/",
  og: "collaboration",
  title: "Collaboration",
  description: "Tasks, comments, @mentions and a timeline on every record; live updates when several people work on the same data; notifications in the app or by email.",
  build() {
    const cr = crumbs(P(this.path, "Collaboration"));
    this.jsonld = [cr.ld];
    return `${hero(cr, "Collaboration " + badge("available"), "Talk about the record, on the record", "Instead of a WhatsApp message saying “see the batch from Tuesday”, the comment, the task and the mention sit on the batch itself, and only people who may see the batch can see them.")}
<section class="section-tight"><div class="container">
${feature(false, "Timeline", "Comments, tasks and files on any row of any table", `<p>Every record can have a timeline: comments with @mentions, tasks with owners and due dates, attached files, and who followed or changed it. Nothing has to be set up per table.</p>`,
  shot("core-timeline", { alt: "A record timeline for Asha Rao: a comment box, buttons to add a task or file, and a comment from Bea Maker mentioning Ada Admin.", sizes: "(max-width: 900px) 100vw, 560px", cls: "shot-small" }))}
${feature(true, "Tasks and mentions", "Everyone's own list", `<p>People see the tasks assigned to them and their teams, and the places where someone mentioned them, in User mode. Mentions also arrive as notifications.</p>`,
  shot("core-tasks", { alt: "The Tasks page in User mode: tasks assigned to the user or their teams, with a field to add a task and a due date." }))}
${feature(false, "Live", "Several people, the same data, no surprises", `<p>Changes made by others appear without reloading. You can see who else has an app open, and if two people edit the same record, the second person is told before anything is overwritten.</p>`,
  shot("live-presence-app", { alt: "The top of a running app showing two other people's initials as presence avatars next to the New contact button.", sizes: "(max-width: 900px) 100vw, 540px", cls: "shot-small" }))}
${feature(true, "Notifications", "In the app, by email, or as a digest", `<p>Each person chooses how they hear about mentions, assignments and other events: in the app, by email right away, or in an hourly or daily digest, with quiet hours. Administrators can set defaults.</p>`,
  shot("live-notifications", { alt: "A notification card reading Please review the Pune contacts, two new leads came in this morning, from Ada Admin.", sizes: "(max-width: 900px) 100vw, 560px", cls: "shot-small" }))}
${notYet(["Team chat with channels and direct messages (planned; the chat panel is a placeholder today)", "WhatsApp notifications (planned)", "Built-in document, sheet and slide editors, and a mail client (planned)"], "Not built yet (planned)")}
</div></section>
${docLinks([["guide/maker/core-data-model.md", "Core data model: tasks, comments, mentions"], ["guide/maker/notifications.md", "Notifications"]])}
${ctaBand()}`;
  },
};

export const adminOps = {
  path: "/product/admin-operations/",
  og: "admin-operations",
  title: "Admin and operations",
  description: "Environments with deploy between them, nightly backups with restore, installers for Windows and Linux, signed updates, server logs, audit log and a diagnostics bundle.",
  build() {
    const cr = crumbs(P(this.path, "Admin and operations"));
    this.jsonld = [cr.ld];
    return `${hero(cr, "Admin and operations " + badge("available"), "Built to be looked after by a small IT team, or none", "On-premises software is only useful if someone can install it, back it up and update it without a specialist on call. That has been part of the product from the start.")}
<section class="section-tight"><div class="container">
${feature(false, "Install", "One script on Windows or Linux", `<p>The installer brings its own Node.js and PostgreSQL, sets ${esc(NAME)} up as a service that starts with the machine, and can put HTTPS in front of it for your office network or a domain name. Minimum: 4 GB of memory on Windows, 2 GB on Linux; 8 GB recommended for Windows.</p><ul class="checks"><li>Windows 10 or 11, Windows Server 2016 or newer</li><li>Ubuntu 22.04 or 24.04, Debian 12 (also on a small rented VPS)</li><li>Offline install bundle for sites without good internet</li></ul><p class="small muted">Honest status: the Linux installer is tested end to end on clean Ubuntu and Debian systems. The Windows installer has passed automated checks but has not yet been run on a real Windows machine; we do the first installs with you.</p>`,
  shot("setup-admin", { alt: "The first-run setup screen: enter the one-time setup code, name, email and a password to create the administrator." }))}
${feature(true, "Environments", "Production, sandbox and developer workspaces", `<p>Each environment has its own tables, apps, roles and data. Lock production so it only changes through a deploy. Package apps and tables as a solution, deploy from sandbox to production, and see what will be added or changed first.</p>`,
  shot("environments-admin", { alt: "Admin console, Environments: a Default production environment and a Sales sandbox, with details of the sandbox such as its database schema and size." }))}
${feature(false, "Backups", "Nightly backups from the first day, and a restore that has been drilled", `<p>A nightly backup of the whole install is on from the first start. Make one any time, keep a schedule, encrypt backups with a passphrase, browse what is inside, and restore as a new environment, in place, or just selected tables. Copy backups to another disk.</p>`,
  shot("backups-list", { alt: "Admin console, Backups: a notice that the last install backup is less than an hour old, and a list with one verified manual backup and Restore, Download and Delete actions." }))}
${feature(true, "Day two", "Updates, logs and a diagnostics bundle", `<p>Upload a signed release in the Admin console or run one command to update; a failed update rolls back. Server logs show health checks, and the diagnostics bundle collects what support needs without secrets. The audit log shows who changed what.</p>`,
  shot("admin-updates", { alt: "Admin console, Updates: the installed version 0.5.0 and an uploaded release package with its notes, ready to install." }))}
${notYet(["High availability or more than one server per database", "A Docker image, macOS installer, MSI or WinGet package", "A hosted version run by us (not planned for now)"], "Not supported")}
</div></section>
${docLinks([["admin/installation.md", "Installation"], ["admin/environments.md", "Environments"], ["admin/backup-and-restore.md", "Backup and restore"], ["admin/upgrades.md", "Upgrades"], ["admin/hardening-checklist.md", "Hardening checklist"]])}
${ctaBand()}`;
  },
};
