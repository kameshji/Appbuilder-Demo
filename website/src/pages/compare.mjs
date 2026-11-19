import { url, crumbs, ctaBand, esc, NAME, docs, config } from "../layout.mjs";

const CHECKED = "19 November 2026";

/* Every competitor claim on these pages points to one of these sources. Keep the list and the text in step. */
const SOURCES = {
  pp: [
    ["Microsoft, Power Apps pricing (Power Apps Premium US$20 per user/month paid yearly; Developer Plan free for building and testing; Premium includes 250 MB database and 2 GB file capacity, pooled per tenant; Dataverse database add-on US$40 per GB/month)", "https://www.microsoft.com/en-us/power-platform/products/power-apps/pricing"],
    ["Microsoft Licensing news, Power Apps Premium price update (US$20 to US$22 per user/month, effective 1 January 2027)", "https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update"],
    ["Microsoft Learn, What is an on-premises data gateway? (a locally installed Windows client that bridges on-premises data and Microsoft cloud services, including Power Apps and Power Automate)", "https://learn.microsoft.com/en-us/data-integration/gateway/service-gateway-onprem"],
    ["Microsoft Power Platform Licensing Guide (Power Apps use rights included with Microsoft 365: standard connectors; premium and custom connectors need Power Apps Premium; Dataverse for Teams only)", "https://www.microsoft.com/licensing/guidance/Power-Platform"],
    ["Microsoft Learn, Power Fx overview (\u201cthe low-code language that Microsoft Power Platform uses\u201d; it \u201cborrows heavily from the Excel formula language\u201d)", "https://learn.microsoft.com/en-us/power-platform/power-fx/overview"],
    ["Microsoft Learn, Develop offline-capable canvas apps (offline in the native Power Apps Mobile players on iOS, Android and Windows; canvas apps in web browsers cannot run offline)", "https://learn.microsoft.com/en-us/power-apps/maker/canvas-apps/offline-apps"],
  ],
  zoho: [
    ["Zoho Creator pricing (Standard US$8, Professional US$20, Enterprise US$25 per user/month billed annually; US$12, US$30, US$37 billed monthly; 15-day free trial; free edition; prices vary by country)", "https://www.zoho.com/creator/pricing.html"],
    ["Zoho Creator On-premise overview (“an installable low-code platform”)", "https://www.zoho.com/creator/help/on-premise/overview.html"],
    ["Zoho Creator Help, Understand hybrid deployment (build in the cloud, run on your own infrastructure; app data stored on-premise; paid plans; contact the On-premise sales team)", "https://help.zoho.com/portal/en/kb/creator/developer-guide/hosting/articles/understand-hybrid-deployment-and-associating-apps"],
    ["Zoho Creator features (drag-and-drop builder; Deluge listed under automation; apps built on the web available as native Android and iOS apps; \u201c1000+ apps ready to integrate\u201d)", "https://www.zoho.com/creator/features.html"],
  ],
  erp: [
    ["frappe/erpnext on GitHub (GPL-3.0 licence; modules include accounting, order management, manufacturing, asset management and projects; self-hosting with Docker; managed hosting on Frappe Cloud)", "https://github.com/frappe/erpnext"],
    ["Frappe, ERPNext pricing (self-hosted is free; Frappe Cloud sites from US$5 or ₹410 per month; “not per user”)", "https://frappe.io/erpnext/pricing"],
    ["Frappe documentation, DocType (custom forms created from Setup > Customize > DocType > New)", "https://docs.frappe.io/erpnext/user/manual/en/customize-erpnext/doctype"],
    ["frappe/frappe on GitHub (\u201cLow code web framework for real world applications, in Python and Javascript\u201d)", "https://github.com/frappe/frappe"],
  ],
  xl: [
    ["Microsoft Support, Protect a worksheet (“Worksheet level protection isn't intended as a security feature.”)", "https://support.microsoft.com/en-us/office/protect-a-worksheet-3179efdb-1285-4d49-a9c3-f4ca36276de6"],
    ["Microsoft Support, Excel specifications and limits (1,048,576 rows by 16,384 columns per worksheet)", "https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3"],
  ],
};

const ref = (n) => `<sup><a href="#src-${n}" aria-label="Source ${n}">${n}</a></sup>`;
const sourceList = (key) => `<section class="section-tight" aria-labelledby="src-h"><div class="container narrow">
<h2 id="src-h" class="h3">Sources</h2>
<p class="small muted">All checked on ${CHECKED}. Prices are list prices in US dollars as shown on the official pages, before tax; your price may differ by country, contract or currency. If something here is out of date or wrong, <a href="${url("/contact/?topic=correction")}">tell us</a> and we will correct it.</p>
<ol class="sources">${SOURCES[key].map(([t, u], i) => `<li id="src-${i + 1}">${esc(t)}. <a href="${u}" rel="noopener">${esc(u)}</a></li>`).join("")}</ol>
<p class="small muted">Facts about ${esc(NAME)} come from its own documentation: <a href="${docs("admin/installation.md")}">installation</a>, <a href="${docs("admin/security-model.md")}">security model</a>, <a href="${docs("reference/formulas.md")}">formulas</a>.</p>
</div></section>`;

const table = (other, rows) => `<div class="table-wrap"><table>
<caption class="visually-hidden">${esc(NAME)} compared with ${esc(other)}, checked ${CHECKED}</caption>
<thead><tr><th scope="col">Topic</th><th scope="col">${esc(NAME)}</th><th scope="col">${esc(other)}</th></tr></thead>
<tbody>${rows.map(([k, a, b]) => `<tr><th scope="row">${k}</th><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody></table></div>`;

const page = ({ path, og, name, title, description, lead, rows, otherBetter, weFit, srcKey, extra = "" }) => ({
  path, og, title, description,
  build() {
    const cr = crumbs([["/", "Home"], ["/compare/", "Compare"], [path, `vs ${name}`]]);
    this.jsonld = [cr.ld];
    return `<section class="page-hero"><div class="container">${cr.html}
<span class="eyebrow">Comparison · checked ${CHECKED}</span>
<h1>${esc(NAME)} and ${esc(name)}</h1>
<p class="lead">${lead}</p>
</div></section>
<section class="section-tight"><div class="container">
${table(name, rows)}
${extra}
<div class="grid grid-2 mt">
<div class="card"><h2 class="h3">When ${esc(name)} is the better choice</h2><ul>${otherBetter.map((x) => `<li>${x}</li>`).join("")}</ul></div>
<div class="card"><h2 class="h3">When ${esc(NAME)} may fit better</h2><ul>${weFit.map((x) => `<li>${x}</li>`).join("")}</ul></div>
</div>
<p class="small muted mt">${esc(name)} is a trademark of its owner. This page is our own summary, not endorsed by them. We are a new product; they are established ones.</p>
</div></section>
${sourceList(srcKey)}
${ctaBand()}`;
  },
});

const US = {
  where: "Your own Windows PC or server, or a Linux VPS you rent. Listens on the machine itself; HTTPS on the LAN or a domain through the bundled Caddy setup.",
  price: "Not decided. Planned: one licence per install by team size (25, 50, 100 people) with passes. No per-app, per-flow or per-connector fees.",
  maturity: "Version 0.5.0, November 2026. No customers yet. One founder.",
  mobile: "Runs in a browser. Phone layouts are planned, not built.",
};

export const comparePP = page({
  path: "/compare/power-platform/", og: "compare-power-platform", name: "Microsoft Power Platform",
  title: "Compared with Microsoft Power Platform",
  description: "A fair, sourced comparison of {name} and Microsoft Power Platform (Power Apps, Power Automate): where each runs, how it is priced, and when Power Platform is the better choice.",
  lead: `Power Platform is the market leader in low-code business apps, deeply tied into Microsoft 365. ${esc(NAME)} takes a similar idea (canvas apps with formulas, a database with security, automation) and packages it as one install on your own machine.`,
  srcKey: "pp",
  rows: [
    ["Where it runs", US.where, `Microsoft's cloud. On-premises data is reached through the on-premises data gateway, a Windows app that bridges local data to Microsoft cloud services.${ref(3)}`],
    ["How you pay", US.price, `Per user per month. Power Apps Premium: US$20 per user/month, paid yearly${ref(1)}, rising to US$22 from 1 January 2027${ref(2)}. Building and testing is free with the Developer Plan; running apps in production needs a paid licence.${ref(1)}`],
    ["Database", "PostgreSQL on your machine; size limited by your disk.", `Dataverse: Premium includes 250 MB database and 2 GB file capacity, pooled across the tenant; extra database capacity US$40 per GB/month.${ref(1)}`],
    ["Connectors", "PostgreSQL, MySQL/MariaDB, Google Sheets, data files, HTTP with OpenAPI import, email. A few, and growing.", `Hundreds of connectors. Premium and custom connectors need Power Apps Premium; the Power Apps rights included with Microsoft 365 cover standard connectors and Dataverse for Teams only.${ref(4)}`],
    ["Formulas", "Excel-style, with function names familiar to Power Apps makers. Our own engine: not compatible, and apps cannot be imported from Power Apps.", `Power Fx, a low-code language that borrows heavily from the Excel formula language.${ref(5)}`],
    ["Phone and offline", US.mobile, `Native Power Apps Mobile players on iOS, Android and Windows, which can run canvas apps offline; in a web browser they cannot.${ref(6)}`],
    ["Maturity", US.maturity, "An established Microsoft product."],
  ],
  otherBetter: [
    "You already pay for Microsoft 365 and your apps live inside Teams, SharePoint and Outlook.",
    "You need many ready-made connectors, mobile apps, offline use or AI features today.",
    "You want Microsoft to run the infrastructure, with its compliance certifications and support.",
    "You need a proven product, with partners in every city.",
  ],
  weFit: [
    "Your data has to stay on a machine in your office or plant.",
    "Per-user monthly pricing in US dollars is hard to justify for 20 to 50 people, many of whom only enter data.",
    "You want one licence per install without separate metering for connectors or flow runs.",
    "You are willing to be an early pilot and shape the product.",
  ],
});

export const compareZoho = page({
  path: "/compare/zoho-creator/", og: "compare-zoho-creator", name: "Zoho Creator",
  title: "Compared with Zoho Creator",
  description: "A fair, sourced comparison of {name} and Zoho Creator: deployment, pricing, maturity, and when Zoho Creator is the better choice.",
  lead: `Zoho Creator is a mature low-code platform from an Indian company, part of the wider Zoho suite. It is cloud-first and also offers an installable on-premise edition. ${esc(NAME)} is install-first and much younger.`,
  srcKey: "zoho",
  rows: [
    ["Where it runs", US.where, `Zoho's cloud. Zoho also offers Zoho Creator On-premise, an installable edition${ref(2)}, and hybrid deployment: build in the cloud, run on your own infrastructure with app data stored on-premise (paid plans, enabled through the On-premise sales team).${ref(3)}`],
    ["How you pay", US.price, `Per user per month: Standard US$8, Professional US$20, Enterprise US$25, billed annually (US$12, US$30, US$37 billed monthly). 15-day free trial and a free edition. Prices vary by country.${ref(1)}`],
    ["Builder experience", "Drag-and-drop canvas with Excel-style formulas, a visual data model designer.", `Drag-and-drop builder, with Zoho's own Deluge language for automation.${ref(4)}`],
    ["Security model", "Roles with row rules and hidden or read-only columns, enforced on the server for every app; “test as user”.", "Roles and permissions; we have not compared the details. Check Zoho's documentation for your case."],
    ["Phone", US.mobile, `Apps built on the web are available as native Android and iOS apps.${ref(4)}`],
    ["Integrations", "A few connectors (databases, Google Sheets, HTTP, email).", `\u201c1000+ apps ready to integrate\u201d.${ref(4)}`],
    ["Maturity", US.maturity, "An established product, part of the Zoho suite."],
  ],
  otherBetter: [
    "You already use Zoho CRM, Books or People and want apps that talk to them.",
    "You need mobile apps, many integrations or a hosted service today.",
    "You want an established vendor with Indian partners, support and invoicing in place.",
  ],
  weFit: [
    "You want to install the full product yourself, from one download, without a sales process for the on-premise edition.",
    "You prefer Excel-style formulas over a scripting language for app logic.",
    "You want row and column security that applies the same way to every app, report and flow.",
    "You are willing to be an early pilot.",
  ],
});

export const compareERP = page({
  path: "/compare/erpnext/", og: "compare-erpnext", name: "ERPNext",
  title: "Compared with ERPNext",
  description: "A fair, sourced comparison of {name} and ERPNext (Frappe): licence, hosting, scope, and when ERPNext is the better choice.",
  lead: `ERPNext is free, open-source ERP software from Frappe, an Indian company, with accounting, stock and manufacturing built in. It is a complete ERP; ${esc(NAME)} is a platform for building your own apps. They solve different problems, and can sit side by side.`,
  srcKey: "erp",
  rows: [
    ["What it is", "An app-building platform: you build the apps your process needs.", `A full ERP. Modules include accounting, order management, manufacturing, asset management and projects.${ref(1)}`],
    ["Licence and cost", US.price, `Free and open source under GPL-3.0.${ref(1)} Self-hosting is free; managed hosting on Frappe Cloud starts at US$5 (₹410) per month for a site, and is not priced per user.${ref(2)}`],
    ["Where it runs", US.where, `Self-hosted (for example with Docker) or on Frappe Cloud.${ref(1)}`],
    ["Customising", "Build any table and screen by drag and drop and formulas.", `Custom forms (DocTypes) can be created from the user interface${ref(3)}; deeper changes are made on the Frappe Framework, which is written in Python and JavaScript.${ref(4)}`],
    ["Accounting and GST", "None. Use Tally or your ERP for the books.", `Built-in accounting module.${ref(1)}`],
    ["Maturity", US.maturity, "An established open-source project."],
  ],
  otherBetter: [
    "You want an ERP: accounts, stock, purchasing, sales and manufacturing in one system, free to install.",
    "You are ready to adapt your processes to a standard ERP and have someone to implement it.",
    "You want open-source software you can change yourself.",
  ],
  weFit: [
    "You are happy with Tally for accounts and need the shop-floor and office records around it.",
    "You want people who know Excel to build and change the apps, without a developer.",
    "A full ERP feels too big for what you need now.",
  ],
});

export const compareXL = page({
  path: "/compare/excel-whatsapp/", og: "compare-excel-whatsapp", name: "Excel and WhatsApp",
  title: "Compared with Excel and WhatsApp",
  description: "When spreadsheets and chat groups are enough, and when a small organisation is better served by an app with a database, roles and an audit log.",
  lead: "Most small organisations run on Excel and WhatsApp, and for good reasons: everyone knows them, they cost little, and they are already installed. This page is about when that stops being enough.",
  srcKey: "xl",
  rows: [
    ["Who can change what", "Roles decide who may create, read, update or delete each row and column, enforced by the server.", `Anyone who can open a file can change it. Microsoft says worksheet protection “isn't intended as a security feature”.${ref(1)}`],
    ["One version of the truth", "One database; everyone sees changes live.", "Files get copied, emailed and forwarded unless everyone works on one shared copy."],
    ["Size", "Tables with a million rows stay usable; filters and totals run in the database.", `Up to 1,048,576 rows per worksheet${ref(2)}; shared workbooks get slow well before that.`],
    ["Approvals and history", "Comments, tasks and a timeline on each record; audit log. Approvals in progress.", "Decisions live in chat history, separate from the record."],
    ["Cost and effort", "Software price not decided; someone has to install it and build the first apps (we help in a pilot).", "Usually already paid for. Nothing to install or learn."],
  ],
  otherBetter: [
    "You are a handful of people, and one person keeps the sheet.",
    "The process changes every week and nobody needs to control who sees what.",
    "You need something today and nobody has time to set anything up.",
  ],
  weFit: [
    "Several people update the same records, and you keep finding conflicting copies.",
    "Some columns (cost, salary, supplier rates) should not be visible to everyone.",
    "You want to know who changed what, and when, without scrolling through chat.",
  ],
});

export const compareIndex = {
  path: "/compare/",
  og: "compare",
  title: "Comparisons",
  description: "Fair, sourced comparisons of {name} with Microsoft Power Platform, Zoho Creator, ERPNext, and Excel with WhatsApp, including when each of them is the better choice.",
  build() {
    const cr = crumbs([["/", "Home"], ["/compare/", "Compare"]]);
    this.jsonld = [cr.ld];
    const c = (h, n, p) => `<a class="card card-link" href="${url(h)}"><h2 class="h3">vs ${n}</h2><p>${p}</p><span class="more">Read the comparison →</span></a>`;
    return `<section class="page-hero"><div class="container">${cr.html}<span class="eyebrow">Compare</span><h1>How ${esc(NAME)} compares, honestly</h1>
<p class="lead">Every claim about another product links to its official page, with the date we checked it. Every page also says when the other option is the better choice, because often it is.</p></div></section>
<section class="section-tight"><div class="container"><div class="grid grid-2">
${c("/compare/power-platform/", "Microsoft Power Platform", "The market leader, in Microsoft's cloud, priced per user per month.")}
${c("/compare/zoho-creator/", "Zoho Creator", "Mature, cloud-first, with an on-premise edition and mobile apps.")}
${c("/compare/erpnext/", "ERPNext", "Free, open-source ERP with manufacturing, accounting and stock.")}
${c("/compare/excel-whatsapp/", "Excel and WhatsApp", "What most small organisations use today, and when it stops being enough.")}
</div>
<p class="small muted mt">Also on our radar, not compared here yet: Odoo, Budibase, NocoBase, Appsmith, ToolJet and Tally. Comparisons checked ${CHECKED}.</p>
</div></section>${ctaBand()}`;
  },
};
