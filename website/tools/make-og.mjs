#!/usr/bin/env node
// Renders one 1200x630 Open Graph image per page into static/og/<slug>.png, from tools/og-pages.json (written by the
// build). Optional: the images are committed, so the normal build never needs a browser. Run after changing the name
// or page titles:  npm run build && npm run og && npm run build
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
const pages = JSON.parse(readFileSync(path.join(ROOT, "tools/og-pages.json"), "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const shot = (n) => "data:image/webp;base64," + readFileSync(path.join(ROOT, "static/assets/shots", n)).toString("base64");

const tpl = (p) => `<!doctype html><html lang="${p.lang}"><head><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;font-family:system-ui,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari",sans-serif;background:#fbfaf7;color:#16201c;position:relative;overflow:hidden}
.l{position:absolute;left:72px;top:64px;right:520px;bottom:64px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-weight:750;font-size:30px;letter-spacing:-.5px}
.ph{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#4a5751;border:1.5px dashed #b9b4a8;border-radius:5px;padding:2px 6px}
h1{font-size:${p.title.length > 40 ? 50 : 60}px;line-height:1.08;letter-spacing:-1.5px;margin:auto 0 18px;font-weight:750}
.t{font-size:22px;color:#4a5751;line-height:1.4}
.r{position:absolute;left:740px;top:70px;width:780px;border-radius:16px;overflow:hidden;box-shadow:0 30px 60px -10px rgba(22,32,28,.35);border:1px solid #d9d5cb;background:#fff}
.r img{display:block;width:100%}
.band{position:absolute;left:0;right:0;bottom:0;height:10px;background:#0b6b4d}
</style></head><body>
<div class="l"><div class="brand"><svg width="44" height="44" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="#0b6b4d"/><rect x="7" y="7" width="8" height="8" rx="2" fill="#fff"/><rect x="17" y="7" width="8" height="8" rx="2" fill="#fff" opacity=".55"/><rect x="7" y="17" width="8" height="8" rx="2" fill="#fff" opacity=".55"/><circle cx="21" cy="21" r="4.2" fill="#fbeedb"/></svg>${esc(config.site.name)}${config.site.nameIsPlaceholder ? '<span class="ph">working name</span>' : ""}</div>
<h1>${esc(p.title)}</h1><div class="t">${esc(p.lang === "hi" ? config.site.taglineHi : config.site.tagline)}</div></div>
<div class="r"><img src="${shot(p.img)}"></div><div class="band"></div></body></html>`;

const IMG = { "home": "studio-filter-formula-1440.webp", "home-hi": "studio-filter-formula-1440.webp", "apps-studio": "studio-button-onselect-1440.webp", "data-security": "roles-who-can-see-1440.webp", "automation": "flows-run-detail-1440.webp", "collaboration": "core-tasks-1440.webp", "admin-operations": "environments-admin-1440.webp", "manufacturing": "restricted-supervisor-grid-1440.webp", "pricing": "backups-list-1440.webp", "pilot": "setup-admin-1440.webp" };

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
mkdirSync(path.join(ROOT, "static/og"), { recursive: true });
const done = new Set();
const all = [...pages, { slug: "default", title: config.site.tagline, lang: "en" }];
for (const p of all) {
  if (done.has(p.slug)) continue;
  done.add(p.slug);
  await page.setContent(tpl({ ...p, img: IMG[p.slug] || "portal-apps-1440.webp" }), { waitUntil: "load" });
  await page.screenshot({ path: path.join(ROOT, "static/og", `${p.slug}.png`), type: "png" });
}
await browser.close();
console.log(`Wrote ${done.size} Open Graph images to static/og/`);
