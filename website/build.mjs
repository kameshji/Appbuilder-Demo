#!/usr/bin/env node
// Static build: renders every page to dist/, copies static files, writes sitemap.xml and robots.txt.
// Zero dependencies. Usage: node build.mjs   (or npm run build)
import { mkdirSync, rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, config, abs, t } from "./src/layout.mjs";
import { homeEn, homeHi } from "./src/pages/home.mjs";
import * as product from "./src/pages/product.mjs";
import * as solutions from "./src/pages/solutions.mjs";
import { pricing } from "./src/pages/pricing.mjs";
import * as compare from "./src/pages/compare.mjs";
import * as company from "./src/pages/company.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");

export const PAGES = [
  homeEn, homeHi,
  product.productIndex, product.appsStudio, product.dataSecurity, product.automation, product.collaboration, product.adminOps,
  solutions.solutionsIndex, solutions.manufacturing, solutions.otherTeams,
  pricing,
  compare.compareIndex, compare.comparePP, compare.compareZoho, compare.compareERP, compare.compareXL,
  company.pilot, company.contact, company.docsPage, company.security, company.about, company.privacy, company.terms,
  company.notFound,
];

function outFile(p) {
  if (p.endsWith(".html")) return path.join(DIST, p);
  return path.join(DIST, p, "index.html");
}

function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  cpSync(path.join(ROOT, "static"), DIST, { recursive: true });
  const seen = new Set();
  const og = [];
  for (const page of PAGES) {
    if (seen.has(page.path)) throw new Error(`Duplicate path ${page.path}`);
    seen.add(page.path);
    page.lang ||= "en";
    const body = page.build();
    const html = render(page, body);
    const file = outFile(page.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, html);
    og.push({ slug: page.og || "default", title: t(page.title), lang: page.lang, path: page.path });
  }
  // sitemap and robots
  const today = config.site.lastUpdated;
  const urls = PAGES.filter((p) => p.sitemap !== false && !p.noindex).map((p) => {
    const alts = (p.alternates || []).map((a) => `\n    <xhtml:link rel="alternate" hreflang="${a.lang}" href="${abs(a.path)}"/>`).join("");
    return `  <url>\n    <loc>${abs(p.path)}</loc>\n    <lastmod>${today}</lastmod>${p.sitemap?.priority ? `\n    <priority>${p.sitemap.priority}</priority>` : ""}${alts}\n  </url>`;
  });
  writeFileSync(path.join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`);
  writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${abs("/sitemap.xml")}\n`);
  // list for the Open Graph image generator (tools/make-og.mjs); not deployed
  writeFileSync(path.join(ROOT, "tools", "og-pages.json"), JSON.stringify(og, null, 1));
  rmSync(path.join(DIST, "assets/shots/manifest.json"), { force: true });
  console.log(`Built ${PAGES.length} pages into dist/ (${urls.length} in the sitemap).`);
}

main();
