import { url, crumbs, ctaBand, faq, config, esc, NAME, docs, badge, iconBox } from "../layout.mjs";
import { formOpen, formClose, field } from "../forms.mjs";

const S = config.site;
const hero = (cr, eyebrow, h1, lead) => `<section class="page-hero"><div class="container">${cr.html}<span class="eyebrow">${eyebrow}</span><h1>${h1}</h1><p class="lead">${lead}</p></div></section>`;

const sizeOpts = [["", "Choose one"], ["under-20", "Fewer than 20"], ["20-50", "20 to 50"], ["51-100", "51 to 100"], ["over-100", "More than 100"]];

export const pilot = {
  path: "/pilot/",
  og: "pilot",
  title: "Pilot programme",
  description: "Become a design partner: we install {name} on your machine and build your first apps with you. Written pilot terms first; your data stays with you.",
  sitemap: { priority: "0.9" },
  build() {
    const cr = crumbs([["/", "Home"], ["/pilot/", "Pilot programme"]]);
    const f = faq([
      ["How much does the pilot cost?", "Pilot terms are agreed in writing before anything is installed. We expect pilots to be free or close to it in exchange for time and feedback; we will not surprise you with a bill."],
      ["What machine do we need?", "A Windows 10/11 PC or Windows Server 2016 or newer with at least 8 GB of memory, or an Ubuntu/Debian server or VPS with 4 GB. It can be an existing PC that stays on during working hours."],
      ["Who owns the apps and data?", "You own your data, and it stays on your machine. The apps we build together for your process are yours to keep using and changing."],
      ["What if it does not work out?", "You can stop at any time. Export your data as CSV or a full backup; it is a standard PostgreSQL database."],
      ["When do pilots start?", "From February 2027. Applications are welcome now, so we can plan the first installs together."],
    ]);
    this.jsonld = [cr.ld, f.ld];
    return `${hero(cr, "Pilot programme", "Be one of the first organisations to use it", `We are looking for a small number of design partners, starting with small manufacturers in India. You bring a real process that lives in spreadsheets and chat. We install ${esc(NAME)} with you and build the first apps together.`)}
<section class="section-tight"><div class="container">
<div class="grid grid-3">
<div class="card">${iconBox("factory")}<h2 class="h3">Who it is for</h2><ul><li>20 to 200 people, ideally a manufacturer</li><li>A process that hurts today: production log, inspection, maintenance, purchase requests</li><li>A PC or server that can run it</li><li>One person who can give it a few hours a week</li></ul></div>
<div class="card">${iconBox("people")}<h2 class="h3">What you get</h2><ul><li>Installation on your machine, done with you</li><li>Your first one to three apps, built together</li><li>Direct line to the founder</li><li>A say in what gets built next, such as approvals, phone layouts or a Tally exchange</li></ul></div>
<div class="card">${iconBox("doc")}<h2 class="h3">What we agree first</h2><ul><li>Written pilot terms: length, cost (if any), support hours</li><li>What happens to your data when the pilot ends</li><li>That we may describe the pilot publicly only with your written permission</li></ul></div>
</div>
<div class="note warn mt"><p><strong>Honest timing.</strong> ${esc(NAME)} is version ${S.version} with no customers yet. The Windows installer has been run on one Windows PC so far, not yet on a customer machine, flows and approvals are still being built, and there has been no outside security review. Pilots are expected to start from February 2027.</p></div>
</div></section>

<section class="section section-alt" aria-labelledby="apply-h"><div class="container narrow">
<h2 id="apply-h">Apply for the pilot</h2>
<p class="muted">Takes about three minutes. We reply within a few working days.</p>
${formOpen({ id: "pilot-form", subject: `Pilot application: ${NAME}` })}
<div class="form-row">
${field({ name: "name", label: "Your name", required: true, autocomplete: "name" })}
${field({ name: "email", label: "Work email", type: "email", required: true, autocomplete: "email" })}
</div>
<div class="form-row">
${field({ name: "organisation", label: "Organisation", required: true, autocomplete: "organization" })}
${field({ name: "city", label: "City", autocomplete: "address-level2" })}
</div>
<div class="form-row">
${field({ name: "size", label: "Number of people", type: "select", required: true, options: sizeOpts })}
${field({ name: "industry", label: "Industry", type: "select", options: [["", "Choose one"], ["manufacturing", "Manufacturing"], ["trading", "Trading or distribution"], ["services", "Services"], ["education", "Education"], ["other", "Other"]] })}
</div>
${field({ name: "process", label: "Which process would you move off spreadsheets first?", type: "textarea", required: true, hint: "For example: daily production log for 3 lines, today in Excel and WhatsApp photos.", rows: 4 })}
${field({ name: "today", label: "What do you use today?", hint: "For example: Tally, Excel, Google Sheets, an ERP, paper registers." })}
${field({ name: "machine", label: "Where would it run?", type: "select", options: [["", "Not sure yet"], ["office-pc", "A PC or server in our office or plant"], ["vps", "A rented server (VPS)"]] })}
${field({ name: "phone", label: "Phone (optional)", type: "tel", autocomplete: "tel" })}
${formClose({ submit: "Send application" })}
</div></section>

<section class="section-tight" aria-labelledby="pfaq-h"><div class="container narrow"><h2 id="pfaq-h">Pilot questions</h2>${f.html}</div></section>`;
  },
};

export const contact = {
  path: "/contact/",
  og: "contact",
  title: "Contact",
  description: "Book a demo, ask about pricing or the pilot programme, or report a correction. Contact the {name} founder directly.",
  build() {
    const cr = crumbs([["/", "Home"], ["/contact/", "Contact"]]);
    this.jsonld = [cr.ld];
    return `${hero(cr, "Contact", "Talk to the founder", `There is no sales team: messages go to the person who builds ${esc(NAME)}. For a demo, we share a screen and walk through the product on real data you bring, or on sample data.`)}
<section class="section-tight"><div class="container">
<div class="grid grid-2">
<div>
${formOpen({ id: "contact-form", subject: `Website enquiry: ${NAME}` })}
${field({ name: "topic", label: "What is it about?", type: "select", required: true, options: [["demo", "Book a demo"], ["pilot", "Pilot programme"], ["pricing", "Pricing"], ["partner", "Partnering or reselling"], ["correction", "A correction to this website"], ["other", "Something else"]] })}
<div class="form-row">
${field({ name: "name", label: "Your name", required: true, autocomplete: "name" })}
${field({ name: "email", label: "Email", type: "email", required: true, autocomplete: "email" })}
</div>
${field({ name: "organisation", label: "Organisation (optional)", autocomplete: "organization" })}
${field({ name: "message", label: "Message", type: "textarea", required: true, hint: "For a demo: a few times that suit you (IST) and what you would like to see." })}
${formClose({ submit: "Send message" })}
</div>
<div>
<div class="card"><h2 class="h3">Other ways</h2>
<p><strong>Email:</strong> <a href="mailto:${esc(S.contactEmail)}">${esc(S.contactEmail)}</a></p>
<p><strong>Security reports:</strong> see the <a href="${url("/security/")}">security page</a>. Please do not send vulnerabilities through this form.</p>
<p><strong>Based in:</strong> ${esc(S.location)}. We reply in English or Hindi.</p>
<p class="small muted">Contact details are placeholders until the company and domain are set up.</p></div>
</div>
</div>
</div></section>`;
  },
};

export const docsPage = {
  path: "/docs/",
  og: "docs",
  title: "Documentation",
  description: "{name} documentation: getting started, maker guides for the Studio, formulas and data, administration, security model and references.",
  build() {
    const cr = crumbs([["/", "Home"], ["/docs/", "Documentation"]]);
    this.jsonld = [cr.ld];
    const g = (title, items) => `<div class="card"><h2 class="h3">${title}</h2><ul>${items.map(([p, l]) => `<li><a href="${docs(p)}">${l}</a></li>`).join("")}</ul></div>`;
    return `${hero(cr, "Documentation", "Documentation", "The documentation lives with the source code for now. These links open it on GitHub. A searchable documentation site is planned.")}
<section class="section-tight"><div class="container"><div class="grid grid-3">
${g("Start here", [["guide/getting-started.md", "Getting started: install and first app"], ["guide/signing-in.md", "Signing in"], ["guide/settings.md", "Settings"], ["guide/troubleshooting.md", "Troubleshooting"]])}
${g("For makers", [["guide/maker/studio.md", "The Studio"], ["guide/maker/formulas.md", "Formulas tutorial"], ["guide/maker/data.md", "Tables and data"], ["guide/maker/data-model.md", "Data model designer"], ["guide/maker/security-for-makers.md", "Security for makers"], ["guide/maker/flows.md", "Flows (in progress)"], ["guide/maker/scheduled-reports.md", "Scheduled reports"], ["guide/maker/solutions.md", "Solutions"]])}
${g("For administrators", [["admin/installation.md", "Installation"], ["admin/users-and-roles.md", "Users and roles"], ["admin/environments.md", "Environments"], ["admin/backup-and-restore.md", "Backup and restore"], ["admin/upgrades.md", "Upgrades"], ["admin/security-model.md", "Security model"], ["admin/hardening-checklist.md", "Hardening checklist"]])}
${g("Reference", [["reference/formulas.md", "Formula functions"], ["reference/ui-components.md", "UI components"], ["reference/flows.md", "Flow steps"], ["reference/connector-actions.md", "Connector actions"]])}
${g("Project", [["README.md", "Documentation index"], ["plan/master-plan.md", "Master plan and phases"], ["research/README.md", "Sector research"]])}
</div>
<p class="small muted mt">If a link does not open, the repository may still be private. <a href="${url("/contact/")}">Ask us</a> for access or a copy.</p>
</div></section>`;
  },
};

export const security = {
  path: "/security/",
  og: "security",
  title: "Security",
  description: "How {name} protects data, what we do not claim, and how to report a vulnerability responsibly.",
  build() {
    const cr = crumbs([["/", "Home"], ["/security/", "Security"]]);
    this.jsonld = [cr.ld];
    return `${hero(cr, "Security", "Security, stated plainly", "What the product does to protect your data, what it does not do, and how to tell us about a problem. We make no guarantees, and you should not trust any vendor that does.")}
<section class="section-tight"><div class="container prose">
<h2>What the product does today</h2>
<ul class="checks">
<li>Every data request is checked on the server against the user's roles: tables, rows and columns. Hiding a field in a screen is never the only protection.</li>
<li>Passwords are hashed with scrypt; common passwords are refused. Two-step verification with an authenticator app or email codes, with recovery codes.</li>
<li>Sessions can be listed and ended; sign-in attempts are throttled.</li>
<li>An audit log of changes and a sign-in log.</li>
<li>Backups can be encrypted with a passphrase (AES-256-GCM). Stored connection passwords are encrypted with a key on your machine.</li>
<li>Outbound connections from flows and connectors go only to hosts an administrator allowed.</li>
<li>Releases are signed; the updater refuses unsigned or tampered packages and rolls back a failed update.</li>
<li>The server listens only on the machine itself; network access goes through an HTTPS reverse proxy the installer sets up on request.</li>
</ul>
<h2>What we do not claim</h2>
<ul>
<li><strong>No outside security review yet.</strong> One is planned before pilots go beyond one company. Our own review notes are in the repository.</li>
<li><strong>No certifications</strong> (such as ISO 27001 or SOC 2).</li>
<li><strong>Data is not encrypted at rest</strong> in the database. Protect the machine and its disks.</li>
<li><strong>Administrators can see everything</strong>, and anyone who controls the machine or the database can read the data. Row and column rules do not apply to them.</li>
<li><strong>The audit log is not tamper-proof</strong> and does not record reads.</li>
<li><strong>No single sign-on or passkeys</strong> yet (planned).</li>
<li><strong>One machine</strong>: no high availability.</li>
</ul>
<p>The full list is under “Explicit limitations” in the <a href="${docs("admin/security-model.md")}">security model</a>. Before going live, work through the <a href="${docs("admin/hardening-checklist.md")}">hardening checklist</a>.</p>
<h2 id="disclosure">Reporting a vulnerability</h2>
<p>Please do not open a public issue for a security problem. Report it privately to <a href="mailto:${esc(S.securityEmail)}">${esc(S.securityEmail)}</a>, with the steps to reproduce, the version or commit you tested and what an attacker gains. Do not include real personal data, and only test systems you own.</p>
<p>The full policy, scope and what to expect are in <a href="${S.githubRepo}/blob/main/SECURITY.md">SECURITY.md</a>. Response times and the reporting address are still being confirmed by the owner; until then, there may be no monitored address.</p>
<h2>This website</h2>
<p>This site is static: no cookies, no trackers, no third-party scripts or fonts, and a strict Content Security Policy. Forms do not upload anything; they open an email in your own mail app.</p>
</div></section>`;
  },
};

export const about = {
  path: "/about/",
  og: "about",
  title: "About",
  description: "{name} is built by one founder in Bhopal, India, for small organisations that outgrew Excel and WhatsApp. An early product, built in the open.",
  build() {
    const cr = crumbs([["/", "Home"], ["/about/", "About"]]);
    this.jsonld = [cr.ld];
    return `${hero(cr, "About", "Founder-led, early, and honest about it", `${esc(NAME)} is being built by one person in ${esc(S.location)}, working with AI coding tools, for organisations like the ones around us: small manufacturers and offices that run on Tally, Excel and WhatsApp.`)}
<section class="section-tight"><div class="container prose">
<h2>Why</h2>
<p>Small companies need what large ones get from low-code platforms: forms, registers, approvals, and the right people seeing the right data. But per-user cloud licences in US dollars, connector tiers and a long list of products make it hard to start. ${esc(NAME)} is an attempt at the same idea as one install, on a machine you own, at a price per install.</p>
<p class="small muted">[Founder bio and photo: to be written by the owner.]</p>
<h2 id="status">Where we are</h2>
<dl class="facts">
<dt>Version</dt><dd>${S.version}, November 2026</dd>
<dt>Customers</dt><dd>None yet. No testimonials or logos on this site, because there are none to show.</dd>
<dt>Pilots</dt><dd>Applications open; pilots expected from February 2027</dd>
<dt>Team</dt><dd>One founder</dd>
<dt>Company</dt><dd>Not yet incorporated. The product name is a working name.</dd>
<dt>Security review</dt><dd>Internal only so far</dd>
</dl>
<h2>How we work</h2>
<ul>
<li>Documentation is written with the code, and screenshots on this site are real.</li>
<li>Third-party components in the core are under permissive licences, checked automatically.</li>
<li>We label what is built, in progress and planned, and we say when another product is the better choice.</li>
</ul>
<p><a href="${url("/pilot/")}">Join the pilot programme</a> or <a href="${url("/contact/")}">get in touch</a>.</p>
</div></section>`;
  },
};

const draft = `<div class="draft-banner" role="note">Draft, to be reviewed by a lawyer. This page is a skeleton for the owner and their legal adviser. It is not legal advice and is not yet in force.</div>`;

export const privacy = {
  path: "/legal/privacy/",
  og: "default",
  title: "Privacy notice (draft)",
  description: "Draft privacy notice for the {name} website. To be reviewed by a lawyer before launch.",
  build() {
    const cr = crumbs([["/", "Home"], ["/legal/privacy/", "Privacy (draft)"]]);
    this.jsonld = [cr.ld];
    return `${hero(cr, "Legal", "Privacy notice", `Last updated: ${S.lastUpdated} (draft)`)}
<section class="section-tight"><div class="container prose">${draft}
<h2>Who we are</h2><p>[Legal entity name, address and contact: to be filled in once the company is set up.] Contact: <a href="mailto:${esc(S.contactEmail)}">${esc(S.contactEmail)}</a>.</p>
<h2>What this website collects</h2>
<p>This website sets no cookies, uses no analytics or advertising trackers, and loads nothing from third parties. The web server that hosts it may keep standard access logs (IP address, time, page, browser) for security and operations. [Hosting provider and log retention period: to be filled in.]</p>
<p>The theme switch stores your choice (light or dark) in your browser's local storage. It never leaves your device.</p>
<h2>Forms</h2>
<p>The pilot, demo and contact forms do not send data to us directly. They open an email in your own mail app, which you choose to send. We then hold your email and what you wrote. [If a form endpoint is enabled later: name the processor, where data is stored and for how long.]</p>
<h2>Why we use it and for how long</h2>
<p>Only to reply to your request and, if you join a pilot, to run it. Based on your consent, which you can withdraw at any time. [Retention period: to be decided, for example 24 months after last contact.]</p>
<h2>Your rights</h2>
<p>You can ask to see, correct or delete what we hold about you, and withdraw consent. [To be completed for India's Digital Personal Data Protection Act, 2023 and its Rules, and for the EU/UK GDPR if we market there: grievance officer, response times, complaint routes.]</p>
<h2>The product</h2>
<p>${esc(NAME)} is installed on the customer's own machine. We do not receive or host the data customers keep in it. [Pilot support access, if any: to be described in the pilot terms.]</p>
</div></section>`;
  },
};

export const terms = {
  path: "/legal/terms/",
  og: "default",
  title: "Terms of use (draft)",
  description: "Draft terms of use for the {name} website. To be reviewed by a lawyer before launch.",
  build() {
    const cr = crumbs([["/", "Home"], ["/legal/terms/", "Terms (draft)"]]);
    this.jsonld = [cr.ld];
    return `${hero(cr, "Legal", "Terms of use", `Last updated: ${S.lastUpdated} (draft)`)}
<section class="section-tight"><div class="container prose">${draft}
<h2>About these terms</h2><p>These terms cover the use of this website. The software licence and pilot terms are separate documents. [Entity name and governing law: to be filled in.]</p>
<h2>Information on this site</h2><p>We try to keep it accurate and label what is planned. Comparisons with other products reflect official sources on the dates shown. Nothing on this site is an offer or a guarantee of features, dates or prices.</p>
<h2>Trademarks</h2><p>${esc(NAME)} is a working name. Other product names are trademarks of their owners and are used only to identify those products.</p>
<h2>Liability</h2><p>[To be drafted by a lawyer.]</p>
<h2>Contact</h2><p><a href="mailto:${esc(S.contactEmail)}">${esc(S.contactEmail)}</a></p>
</div></section>`;
  },
};

export const notFound = {
  path: "/404.html",
  og: "default",
  title: "Page not found",
  description: "This page does not exist.",
  noindex: true,
  sitemap: false,
  build() {
    this.jsonld = [];
    return `<section class="page-hero"><div class="container narrow"><span class="eyebrow">404</span><h1>This page does not exist</h1>
<p class="lead">It may have moved, or the link may be wrong.</p>
<div class="btn-row"><a class="btn btn-primary" href="${url("/")}">Go to the home page</a><a class="btn btn-secondary" href="${url("/docs/")}">Documentation</a></div>
<p class="mt">Popular pages: <a href="${url("/product/")}">Product</a> · <a href="${url("/pricing/")}">Pricing</a> · <a href="${url("/pilot/")}">Pilot programme</a> · <a href="${url("/compare/")}">Compare</a></p></div></section>`;
  },
};
