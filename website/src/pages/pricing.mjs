import { url, crumbs, faq, ctaBand, config, esc, NAME, icon, badge } from "../layout.mjs";

const P = config.pricing;
const money = (n) => `${P.currencySymbol}${Number(n).toLocaleString("en-IN")}`;

export function roiEstimator() {
  const R = config.roi;
  const row = (name, label, hint, val, min, max, step, unit) => `<div class="field">
  <label for="roi-${name}">${label}</label><span class="hint" id="roi-${name}-hint">${hint}</span>
  <div class="range-row"><input type="range" id="roi-${name}-r" data-sync="${name}" min="${min}" max="${max}" step="${step}" value="${val}" aria-describedby="roi-${name}-hint" aria-label="${esc(label)} (slider)">
  <input type="number" id="roi-${name}" name="${name}" data-sync="${name}" min="${min}" max="${max}" step="${step}" value="${val}" inputmode="decimal" aria-describedby="roi-${name}-hint"></div>${unit ? `<span class="visually-hidden">${unit}</span>` : ""}</div>`;
  return `<form class="roi" data-roi data-currency="${esc(P.currencySymbol)}" aria-labelledby="roi-h" novalidate>
  <div class="form">
    ${row("people", "People who keep records by hand", "Supervisors, office staff and others who type, copy, chase or consolidate data each week.", R.people, 1, 100, 1)}
    ${row("hours", "Hours each of them spends on it per week", "Re-typing, finding the latest file, chasing updates on WhatsApp, making the weekly summary.", R.hoursPerWeek, 0, 20, 0.5)}
    ${row("share", "Share of that time an app could save (%)", "Our default of 30% is an assumption, not a measurement. Set your own.", R.share, 0, 80, 5)}
    ${row("cost", `Cost of one hour of their time (${P.currencySymbol})`, "Salary plus overheads divided by working hours. Change it to your own figure.", R.hourlyCost, 50, 2000, 10)}
    ${row("weeks", "Working weeks per year", "", R.weeksPerYear, 1, 52, 1)}
    <div class="btn-row"><button class="btn btn-secondary btn-sm" type="submit">Recalculate</button><button class="btn btn-secondary btn-sm" type="reset">Reset to defaults</button></div>
  </div>
  <div class="roi-out" aria-live="polite">
    <p class="eyebrow">Estimate</p>
    <p class="muted small">Time that could be freed per year</p>
    <p class="roi-big"><span data-out="saved">${(R.people * R.hoursPerWeek * R.weeksPerYear * R.share / 100).toLocaleString("en-IN")}</span> hours</p>
    <dl>
      <dt>Hours spent on manual records now</dt><dd data-out="spent">${(R.people * R.hoursPerWeek * R.weeksPerYear).toLocaleString("en-IN")}</dd>
      <dt>Equivalent in 8-hour days</dt><dd data-out="days">${Math.round(R.people * R.hoursPerWeek * R.weeksPerYear * R.share / 100 / 8).toLocaleString("en-IN")}</dd>
      <dt>Value of that time per year</dt><dd data-out="value">${money(R.people * R.hoursPerWeek * R.weeksPerYear * R.share / 100 * R.hourlyCost)}</dd>
      <dt>Per month</dt><dd data-out="perMonth">${money(Math.round(R.people * R.hoursPerWeek * R.weeksPerYear * R.share / 100 * R.hourlyCost / 12))}</dd>
    </dl>
    <p class="small muted">The formula: people × hours per week × weeks × share saved = hours; hours × hourly cost = value. It is an illustration with your numbers, not a promise. We have no customer data to base a saving on yet. Nothing you enter leaves this page.</p>
  </div>
</form>`;
}

const FAQ = [
  ["Why is there no price on the page?", "Because we have not decided it, and we would rather not publish a number we change in a month. Pilot organisations get written pilot terms before anything is installed. When prices are set they will appear here."],
  ["What is a seat band?", "The licence is planned per install, sized by how many named people use it: up to 25, 50 or 100. You are not charged per app, per table, per flow run or per connector."],
  ["What are passes?", "Each person gets a pass that matches how they use it: a Full user builds and uses apps, an Operator uses the apps they are given, and External is for people outside your organisation (this needs the external portal, which is planned)."],
  ["Do we pay for the server too?", "The software runs on a machine you provide: an existing office PC or server, or a small rented Linux server (VPS). You pay for that machine yourself; we do not resell hosting."],
  ["What happens if we stop paying?", "The planned model: after a grace period the install becomes read-only, and exporting your data always keeps working. Your data is in a standard PostgreSQL database on your machine."],
  ["Is GST included?", "Prices, once published, will say whether GST is included. For now there is nothing to pay."],
];

export const pricing = {
  path: "/pricing/",
  og: "pricing",
  title: "Pricing",
  description: "{name} pricing structure: one licence per install by team size (25, 50 or 100 people) with Full user, Operator and External passes. Pilot pricing: talk to us.",
  sitemap: { priority: "0.8" },
  build() {
    const cr = crumbs([["/", "Home"], ["/pricing/", "Pricing"]]);
    const f = faq(FAQ);
    this.jsonld = [cr.ld, f.ld];
    const anyNull = P.bands.some((b) => b.price == null);
    const cards = P.bands.map((b) => `<article class="price-card${b.highlight ? " highlight" : ""}" aria-labelledby="band-${b.id}">
  <h3 id="band-${b.id}">${esc(b.name)}</h3>
  ${b.price == null ? `<p class="price tbd">Talk to us</p><p class="small muted">Price not decided yet</p>` : `<p class="price">${money(b.price)}</p><p class="small muted">${esc(P.period)}</p>`}
  <p>${esc(b.note)}</p>
  <ul class="checks"><li>Every module in your version</li><li>No limits on apps, tables or flow runs</li><li>Environments, backups and updates</li></ul>
  <a class="btn ${b.highlight ? "btn-primary" : "btn-secondary"} no-print" href="${url("/contact/?topic=pricing")}">Ask about this band</a>
</article>`).join("\n");
    const passRows = P.passes.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${p.price == null ? "Not decided" : money(p.price)}</td><td>${esc(p.desc)}</td></tr>`).join("");
    return `<section class="page-hero"><div class="container">${cr.html}
<span class="eyebrow">Pricing</span>
<h1>One licence per install, sized by your team</h1>
<p class="lead">No per-app, per-flow or per-connector fees. The structure is decided; the numbers are not.</p>
${anyNull ? `<div class="note warn"><p><strong>${esc(P.pilotNote)}</strong></p></div>` : ""}
<div class="btn-row no-print"><a class="btn btn-primary" href="${url("/pilot/")}">Request a pilot</a><button class="btn btn-secondary" type="button" data-print hidden>${icon("print")}Print this page</button></div>
<p class="print-only">Printed from ${esc(config.site.domain)}/pricing/. Structure as of ${config.site.lastUpdated}; prices are not decided.</p>
</div></section>

<section class="section-tight" aria-labelledby="bands-h"><div class="container">
<h2 id="bands-h">Seat bands ${badge("planned")}</h2>
<p class="muted">Planned licence model. A signed licence file is checked offline on your machine; nothing phones home.</p>
<div class="price-grid">${cards}</div>
</div></section>

<section class="section-tight" aria-labelledby="passes-h"><div class="container">
<h2 id="passes-h">Passes: what each person can do</h2>
<div class="table-wrap"><table class="pass-table"><caption class="visually-hidden">User passes</caption>
<thead><tr><th scope="col">Pass</th><th scope="col">Price</th><th scope="col">For</th></tr></thead>
<tbody>${passRows}</tbody></table></div>
</div></section>

<section class="section-tight" aria-labelledby="where-h"><div class="container">
<h2 id="where-h">Where it runs: your PC, your server or a small VPS</h2>
<div class="grid grid-2">
<div class="card"><h3>On premises</h3><p>Install on a PC or server in your office or plant (Windows 10/11, Windows Server 2016 or newer, Ubuntu or Debian). People on the office network open it in their browser over HTTPS.</p><ul><li>Data never leaves the building</li><li>Works when the internet is down</li><li>You look after the machine, power and backup copies</li></ul></div>
<div class="card"><h3>On a VPS</h3><p>Rent a small Linux server (4 GB of memory is a good start) from any hosting provider and install it there with a domain name and HTTPS.</p><ul><li>Reachable from anywhere, including branch offices</li><li>No hardware to buy</li><li>You pay the provider directly; data sits with that provider</li></ul></div>
</div>
<p class="small muted mt">Either way the price of the licence is the same. Sizing details: <a href="${config.site.docsBaseUrl}admin/installation.md">installation guide</a>.</p>
</div></section>

<section class="section section-alt" aria-labelledby="roi-h"><div class="container">
<div class="section-head"><span class="eyebrow">Estimator</span><h2 id="roi-h">What is the time worth?</h2><p class="lead">A quick estimate of the time your team spends keeping records by hand, with every assumption visible. Change any number.</p></div>
${roiEstimator()}
</div></section>

<section class="section-tight" aria-labelledby="pfaq-h"><div class="container narrow"><h2 id="pfaq-h">Pricing questions</h2>${f.html}</div></section>
${ctaBand("en", "Want to be a pilot organisation?", "Pilots get written terms first. Tell us about your team and the process you want to move off spreadsheets.")}`;
  },
};
