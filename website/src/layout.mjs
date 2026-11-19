// Shared layout pieces and small helpers. Pages are plain template strings: no framework.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const config = JSON.parse(readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
const shots = JSON.parse(readFileSync(path.join(ROOT, "static/assets/shots/manifest.json"), "utf8"));
const strings = {
  en: JSON.parse(readFileSync(path.join(ROOT, "src/i18n/en.json"), "utf8")),
  hi: JSON.parse(readFileSync(path.join(ROOT, "src/i18n/hi.json"), "utf8")),
};

export const S = config.site;
export const NAME = S.name;

/** Escape text for HTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Replace {name} and other tokens in copy, so the product name lives in one place. */
export const t = (s) => String(s).replaceAll("{name}", NAME).replaceAll("{version}", S.version);

/** Internal URL with the configured base path. */
export const url = (p) => {
  if (/^(https?:|mailto:|#)/.test(p)) return p;
  return (S.basePath || "") + p;
};
export const abs = (p) => S.domain.replace(/\/$/, "") + url(p);
export const docs = (p) => S.docsBaseUrl + p;
export const i18n = (lang, key) => strings[lang]?.[key] ?? strings.en[key] ?? key;

/** A real product screenshot in a neutral frame. Sizes and srcset come from the image manifest. */
export function shot(name, { alt, caption, label, eager = false, tilt = false, sizes, cls = "" } = {}) {
  const m = shots[name];
  if (!m) throw new Error(`Unknown screenshot ${name}`);
  if (!alt) throw new Error(`Screenshot ${name} needs alt text`);
  const widths = Object.keys(m.files).map(Number).sort((a, b) => a - b);
  const largest = widths[widths.length - 1];
  const srcset = widths.map((w) => `${url("/assets/shots/" + m.files[w])} ${w}w`).join(", ");
  const h = Math.round((m.h * largest) / m.w);
  const sz = sizes || "(max-width: 900px) 100vw, 640px";
  return `<figure class="shot ${cls}">
  <div class="shot-frame${tilt ? " shot-tilt" : ""}">
    <div class="shot-bar" aria-hidden="true"><i></i><i></i><i></i><span>${esc(label || "Product screenshot")}</span></div>
    <img src="${url("/assets/shots/" + m.files[largest])}" srcset="${srcset}" sizes="${sz}" width="${largest}" height="${h}" alt="${esc(t(alt))}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">
  </div>${caption ? `\n  <figcaption>${t(caption)}</figcaption>` : ""}
</figure>`;
}

const BADGE = {
  available: ["badge-available", "Available now", "उपलब्ध"],
  progress: ["badge-progress", "In progress", "बन रहा है"],
  planned: ["badge-planned", "Planned", "योजना में"],
};
export const badge = (kind, lang = "en") => {
  const [c, en, hi] = BADGE[kind];
  return `<span class="badge ${c}">${lang === "hi" ? hi : en}</span>`;
};

/* Icons: simple strokes drawn for this site (no icon library). */
const ICONS = {
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  flow: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 014 4v5.5"/>',
  chat: '<path d="M4 5h16v10H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  bell: '<path d="M6 16V11a6 6 0 1112 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 004 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  factory: '<path d="M3 21V10l6 3V10l6 3V6l6 3v12H3z"/><path d="M7 17h2M12 17h2M17 17h2"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0112 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 016 5.5"/>',
  backup: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  doc: '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  rupee: '<path d="M7 5h10M7 9h10M7 5c5 0 7 2 7 4s-2 4-7 4l7 6"/>',
  play: '<path d="M8 5l11 7-11 7V5z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5a3 3 0 00-.9-2.3c3-.3 6-1.5 6-6.5a5 5 0 00-1.4-3.5 4.6 4.6 0 00-.1-3.5s-1.1-.3-3.6 1.4a12.3 12.3 0 00-6.4 0C6.1 2.4 5 2.7 5 2.7a4.6 4.6 0 00-.1 3.5A5 5 0 003.5 9.7c0 5 3 6.2 6 6.5a3 3 0 00-.9 2.3V22"/>',
};
export const icon = (n, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[n]}</svg>`;
export const iconBox = (n) => `<div class="icon">${icon(n)}</div>`;

/** The placeholder logo mark. Replace static/assets/img/logo.svg and this function when a real identity exists. */
export const logoMark = () =>
  `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><!-- PLACEHOLDER MARK: replace with the real logo -->
<rect x="1" y="1" width="30" height="30" rx="8" fill="var(--brand)"/>
<rect x="7" y="7" width="8" height="8" rx="2" fill="var(--brand-ink)"/>
<rect x="17" y="7" width="8" height="8" rx="2" fill="var(--brand-ink)" opacity=".55"/>
<rect x="7" y="17" width="8" height="8" rx="2" fill="var(--brand-ink)" opacity=".55"/>
<circle cx="21" cy="21" r="4.2" fill="var(--accent-soft)"/></svg>`;

// Inline head script: theme before first paint (no flash) and the js class. Its hash goes into the CSP.
const HEAD_SCRIPT = `(function(){var d=document.documentElement;d.className=d.className.replace("no-js","js");try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light")d.setAttribute("data-theme",t)}catch(e){}})();`;
const HEAD_HASH = "sha256-" + createHash("sha256").update(HEAD_SCRIPT).digest("base64");

function csp() {
  const formAction = ["'self'", "mailto:"];
  if (config.forms.endpoint) formAction.push(new URL(config.forms.endpoint).origin);
  const scriptSrc = ["'self'", `'${HEAD_HASH}'`];
  const connect = ["'self'"];
  if (config.analytics.scriptSrc) {
    scriptSrc.push(new URL(config.analytics.scriptSrc).origin);
    connect.push(new URL(config.analytics.scriptSrc).origin);
  }
  return [
    "default-src 'self'", `script-src ${scriptSrc.join(" ")}`, "style-src 'self'", "img-src 'self' data:",
    `connect-src ${connect.join(" ")}`, `form-action ${formAction.join(" ")}`, "base-uri 'self'", "object-src 'none'",
  ].join("; ");
}

const NAV = (lang) => [
  { label: "Product", base: "/product/", items: [
    ["/product/", "Overview", "Everything in one place"],
    ["/product/apps-studio/", "Apps and Studio", "Drag and drop, Excel-style formulas"],
    ["/product/data-security/", "Data and security", "Tables, roles, row and column rules"],
    ["/product/automation/", "Automation", "Flows and approvals (in progress)"],
    ["/product/collaboration/", "Collaboration", "Tasks, comments, mentions, live updates"],
    ["/product/admin-operations/", "Admin and operations", "Environments, backups, installers"],
  ] },
  { label: "Solutions", base: "/solutions/", items: [
    ["/solutions/manufacturing/", "Manufacturing", "Production, quality, maintenance"],
    ["/solutions/other-teams/", "Other teams", "Offices that outgrew Excel"],
  ] },
  { label: "Pricing", href: "/pricing/" },
  { label: "Compare", base: "/compare/", items: [
    ["/compare/", "All comparisons", "How we differ, honestly"],
    ["/compare/power-platform/", "vs Microsoft Power Platform", ""],
    ["/compare/zoho-creator/", "vs Zoho Creator", ""],
    ["/compare/erpnext/", "vs ERPNext", ""],
    ["/compare/excel-whatsapp/", "vs Excel and WhatsApp", ""],
  ] },
  { label: "Pilot", href: "/pilot/" },
  { label: "Docs", href: "/docs/" },
];

function header(page) {
  const cur = page.path;
  const lang = page.lang;
  const navItems = NAV(lang).map((n, i) => {
    if (n.href) {
      const on = cur === n.href ? ' aria-current="page"' : "";
      return `<li><a href="${url(n.href)}"${on}>${n.label}</a></li>`;
    }
    const id = `sub-${i}`;
    const sub = n.items.map(([h, l, d]) => `<li><a href="${url(h)}"${cur === h ? ' aria-current="page"' : ""}>${l}${d ? `<span>${d}</span>` : ""}</a></li>`).join("");
    return `<li><button class="nav-disclosure" type="button" aria-expanded="false" aria-controls="${id}">${n.label}${icon("chevron")}</button>
<a class="nav-fallback" href="${url(n.base)}">${n.label}</a>
<ul class="subnav" id="${id}" hidden>${sub}</ul></li>`;
  }).join("\n");
  const other = lang === "hi" ? `<a class="lang-link" href="${url("/")}" hreflang="en" lang="en">English</a>` : `<a class="lang-link" href="${url("/hi/")}" hreflang="hi" lang="hi">हिन्दी</a>`;
  return `<a class="skip-link" href="#main">${i18n(lang, "skip")}</a>
<aside class="site-banner" aria-label="${lang === "hi" ? "प्रोडक्ट की स्थिति" : "Product status"}">${t(i18n(lang, "banner"))} <a href="${url("/about/#status")}">${i18n(lang, "bannerLink")}</a></aside>
<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="${url(lang === "hi" ? "/hi/" : "/")}">${logoMark()}<span>${esc(NAME)}</span>${S.nameIsPlaceholder ? '<span class="ph-tag" title="Working name, not final">working name</span>' : ""}</a>
    <nav class="nav" id="site-nav" aria-label="${i18n(lang, "mainNav")}">
      <ul class="nav-list">
${navItems}
      </ul>
      <a class="btn btn-primary btn-sm" href="${url(config.cta.primaryHref)}">${lang === "hi" ? i18n("hi", "ctaPrimary") : config.cta.primaryLabel}</a>
    </nav>
    <div class="header-actions">
      ${other}
      <button class="icon-btn theme-toggle" type="button" aria-pressed="false" title="${i18n(lang, "theme")}"><span class="visually-hidden">${i18n(lang, "theme")}</span>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/></svg>
        <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <button class="icon-btn menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="visually-hidden">${i18n(lang, "menu")}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div>
</header>`;
}

function footer(page) {
  const lang = page.lang;
  const col = (title, links) => `<div><h2>${title}</h2><ul>${links.map(([h, l]) => `<li><a href="${url(h)}">${l}</a></li>`).join("")}</ul></div>`;
  return `<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div>
        <a class="brand" href="${url("/")}">${logoMark()}<span>${esc(NAME)}</span></a>
        <p class="muted small">${t(i18n(lang, "footerAbout"))}</p>
      </div>
      <nav aria-label="Product">${col("Product", [["/product/apps-studio/", "Apps and Studio"], ["/product/data-security/", "Data and security"], ["/product/automation/", "Automation"], ["/product/collaboration/", "Collaboration"], ["/product/admin-operations/", "Admin and operations"]])}</nav>
      <nav aria-label="Solutions and comparisons">${col("Solutions", [["/solutions/manufacturing/", "Manufacturing"], ["/solutions/other-teams/", "Other teams"], ["/pricing/", "Pricing"], ["/compare/", "Compare"]])}</nav>
      <nav aria-label="Company">${col("Company", [["/about/", "About"], ["/pilot/", "Pilot programme"], ["/contact/", "Contact"], ["/security/", "Security"]])}</nav>
      <nav aria-label="Resources">${col("Resources", [["/docs/", "Documentation"], ["/legal/privacy/", "Privacy (draft)"], ["/legal/terms/", "Terms (draft)"], ["/hi/", "हिन्दी"]])}</nav>
    </div>
    <div class="footer-bottom">
      <span>© 2026 ${esc(NAME)}${S.nameIsPlaceholder ? " (working name)" : ""}. Version ${S.version}, an early product.</span>
      <span>${i18n(lang, "footerNoTracking")}</span>
    </div>
  </div>
</footer>`;
}

/** Full HTML document for a page. */
export function render(page, body) {
  const lang = page.lang || "en";
  const title = page.path === "/" ? `${NAME}: ${page.title}` : `${page.title} | ${NAME}`;
  const desc = t(page.description);
  const canonical = abs(page.path);
  const ogFile = `/og/${page.og || "default"}.png`;
  const ogExists = existsSync(path.join(ROOT, "static", ogFile));
  const og = abs(ogExists ? ogFile : "/og/default.png");
  const alternates = (page.alternates || []).map((a) => `<link rel="alternate" hreflang="${a.lang}" href="${abs(a.path)}">`).join("\n");
  const jsonld = (page.jsonld || []).map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n");
  const analytics = config.analytics.scriptSrc
    ? `<script defer src="${esc(config.analytics.scriptSrc)}"${config.analytics.domainAttr ? ` data-domain="${esc(config.analytics.domainAttr)}"` : ""}></script>`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp()}">
<title>${esc(t(title))}</title>
<meta name="description" content="${esc(desc)}">
${page.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">`}
${alternates}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0b6b4d">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(NAME)}">
<meta property="og:title" content="${esc(t(page.title))}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${lang === "hi" ? "hi_IN" : "en_IN"}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${url("/favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${url("/assets/css/site.css")}">
<script>${HEAD_SCRIPT}</script>
<script defer src="${url("/assets/js/site.js")}"></script>
${analytics}
${jsonld}
</head>
<body>
${header(page)}
<main id="main" tabindex="-1">
${body}
</main>
${footer(page)}
</body>
</html>
`;
}

/** Breadcrumbs plus the matching BreadcrumbList JSON-LD. */
export function crumbs(items) {
  const html = `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([h, l], i) => i === items.length - 1 ? `<li><span aria-current="page">${l}</span></li>` : `<li><a href="${url(h)}">${l}</a></li>`).join("")}</ol></nav>`;
  const ld = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([h, l], i) => ({ "@type": "ListItem", position: i + 1, name: l, item: abs(h) })) };
  return { html, ld };
}

/** The closing call to action used on most pages. */
export function ctaBand(lang = "en", heading, text) {
  const hi = lang === "hi";
  return `<section class="section-tight" aria-labelledby="cta-h"><div class="container"><div class="cta-band">
  <div><h2 id="cta-h">${heading || (hi ? i18n("hi", "ctaHeading") : "Have a process that lives in a spreadsheet and a WhatsApp group?")}</h2>
  <p>${text || (hi ? i18n("hi", "ctaText") : "Tell us about it. If it fits, we will build the first app with you during a pilot, on your own machine.")}</p></div>
  <div class="btn-row"><a class="btn btn-primary" href="${url(config.cta.primaryHref)}">${hi ? i18n("hi", "ctaPrimary") : config.cta.primaryLabel}</a><a class="btn btn-secondary" href="${url(config.cta.demoHref)}">${hi ? i18n("hi", "ctaDemo") : config.cta.demoLabel}</a></div>
</div></div></section>`;
}

/** FAQ list plus FAQPage JSON-LD (only questions that are on the page). */
export function faq(items, id = "faq") {
  const html = `<div class="faq">${items.map(([q, a]) => `<details><summary>${t(q)}</summary><div class="answer"><p>${t(a)}</p></div></details>`).join("\n")}</div>`;
  const ld = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: t(q), acceptedAnswer: { "@type": "Answer", text: t(a).replace(/<[^>]+>/g, "") } })) };
  return { html, ld };
}

/** Software facts for JSON-LD. Only fields that are true today; no price, rating or review. */
export const softwareLd = () => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Windows 10, Windows 11, Windows Server 2016 or newer, Ubuntu 22.04, Ubuntu 24.04, Debian 12",
  softwareVersion: S.version,
  description: t("A self-hosted platform for building business apps by drag and drop with Excel-style formulas, with a built-in database, role-based, row and column security, environments and backups."),
  url: abs("/"),
  inLanguage: "en",
});
