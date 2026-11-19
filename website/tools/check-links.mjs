#!/usr/bin/env node
// Checks that every internal link, image, script and stylesheet in dist/ resolves to a file, and that every
// in-page #fragment exists. External links are listed, not fetched. Exit code 1 on any broken link.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const config = JSON.parse(readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
const base = config.site.basePath || "";
const domain = config.site.domain.replace(/\/$/, "");

const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const html = walk(DIST).filter((f) => f.endsWith(".html"));
const ids = new Map();
for (const f of html) ids.set(f, new Set([...readFileSync(f, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));

const resolve = (from, href) => {
  let [p, frag] = href.split("#");
  p = p.split("?")[0];
  let target;
  if (!p) target = from;
  else if (p.startsWith("/")) {
    if (base && !p.startsWith(base)) return { err: "missing base path" };
    target = path.join(DIST, p.slice(base.length));
  } else target = path.join(path.dirname(from), p);
  if (existsSync(target) && statSync(target).isDirectory()) target = path.join(target, "index.html");
  return { target, frag };
};

let broken = 0, checked = 0;
const external = new Set();
for (const f of html) {
  const src = readFileSync(f, "utf8");
  const refs = [...src.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const s of src.matchAll(/\ssrcset="([^"]+)"/g)) for (const part of s[1].split(",")) refs.push(part.trim().split(/\s+/)[0]);
  for (const r0 of refs) {
    const r = r0.replace(/&amp;/g, "&");
    if (/^(mailto:|tel:|data:)/.test(r)) continue;
    if (/^https?:/.test(r)) {
      if (r.startsWith(domain)) { /* canonical/og: point at our own domain */ const rel = r.slice(domain.length) || "/"; const res = resolve(f, rel); checked++; if (!existsSync(res.target)) { broken++; console.log(`BROKEN ${path.relative(DIST, f)} -> ${r}`); } }
      else external.add(r);
      continue;
    }
    checked++;
    const res = resolve(f, r);
    if (res.err || !existsSync(res.target)) { broken++; console.log(`BROKEN ${path.relative(DIST, f)} -> ${r}${res.err ? " (" + res.err + ")" : ""}`); continue; }
    if (res.frag && res.target.endsWith(".html") && !ids.get(res.target)?.has(res.frag)) { broken++; console.log(`BROKEN FRAGMENT ${path.relative(DIST, f)} -> ${r}`); }
  }
}
console.log(`${html.length} pages, ${checked} internal references checked, ${broken} broken, ${external.size} distinct external links (not fetched).`);
if (process.argv.includes("--external")) for (const e of [...external].sort()) console.log("  " + e);
process.exit(broken ? 1 : 0);
