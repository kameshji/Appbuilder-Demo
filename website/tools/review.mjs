#!/usr/bin/env node
// Review run: serves dist/, opens every page in headless Chrome at 360, 768, 1280 and 1920 px, and records
//  - page weight (all bytes transferred, and excluding product screenshots and OG images),
//  - layout shift (CLS) after load and after scrolling, horizontal overflow, console errors,
//  - axe-core accessibility results (WCAG 2.0/2.1/2.2 A and AA rules), if AXE_PATH points at axe.min.js,
//  - full-page screenshots into review/ (light theme; the home page also in dark).
// Usage: AXE_PATH=/path/to/axe.min.js node tools/review.mjs   (puppeteer-core: see tools/browser.mjs)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "review");
const PORT = 8091;
const pages = JSON.parse(readFileSync(path.join(ROOT, "tools/og-pages.json"), "utf8")).map((p) => p.path);
const WIDTHS = [360, 768, 1280, 1920];
const SHOT_WIDTHS = process.env.SHOTS === "all" ? WIDTHS : WIDTHS;
const axePath = process.env.AXE_PATH;
const axeSrc = axePath && existsSync(axePath) ? readFileSync(axePath, "utf8") : null;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [path.join(ROOT, "tools/serve.mjs"), path.join(ROOT, "dist"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));

const browser = await launch();
const results = [];
try {
  for (const p of pages) {
    for (const w of WIDTHS) {
      const page = await browser.newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      let bytes = 0, bytesNoShots = 0;
      const client = await page.createCDPSession();
      await client.send("Network.enable");
      const urls = new Map();
      client.on("Network.responseReceived", (e) => urls.set(e.requestId, e.response.url));
      client.on("Network.loadingFinished", (e) => { const u = urls.get(e.requestId) || ""; bytes += e.encodedDataLength; if (!/\/assets\/shots\/|\/og\//.test(u)) bytesNoShots += e.encodedDataLength; });
      if (axeSrc) await page.setBypassCSP(true); // only so the test can inject axe-core
      await page.setViewport({ width: w, height: w < 800 ? 780 : 900, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => {
        window.__cls = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(`http://localhost:${PORT}${p}`, { waitUntil: "networkidle0" });
      // scroll through the page so lazy images load, then measure
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo({ top: y, behavior: "instant" }); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo({ top: 0, behavior: "instant" }); });
      await new Promise((r) => setTimeout(r, 900));
      const m = await page.evaluate(() => ({ cls: window.__cls, overflow: document.documentElement.scrollWidth - window.innerWidth, h: document.body.scrollHeight }));
      const totals = { bytes, bytesNoShots };
      // first-view weight: reload without scrolling
      let firstView = null;
      if (w === 1280) {
        let fv = 0; const fvClient = client;
        const onDone = (e) => { fv += e.encodedDataLength; };
        await page.setCacheEnabled(false);
        fvClient.on("Network.loadingFinished", onDone);
        await page.reload({ waitUntil: "networkidle0" });
        fvClient.off("Network.loadingFinished", onDone);
        firstView = fv;
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo({ top: y, behavior: "instant" }); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo({ top: 0, behavior: "instant" }); });
        await new Promise((r) => setTimeout(r, 900));
      }
      let axe = null;
      if (axeSrc && (w === 360 || w === 1280)) {
        await page.addScriptTag({ content: axeSrc });
        axe = await page.evaluate(async () => {
          const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
          return { violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })), passes: r.passes.length, incomplete: r.incomplete.map((v) => v.id) };
        });
      }
      const slug = (p === "/" ? "home" : p.replace(/^\/|\/$/g, "").replace(/[\/.]/g, "-")) + `-${w}`;
      if (SHOT_WIDTHS.includes(w)) await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: true });
      if (p === "/" || p === "/hi/" || p === "/pricing/") {
        await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
        await new Promise((r) => setTimeout(r, 150));
        if (axeSrc && w === 1280) {
          const dark = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } }); return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })); });
          if (axe) axe.darkContrast = dark;
        }
        await page.screenshot({ path: path.join(OUT, `${slug}-dark.png`), fullPage: true });
      }
      results.push({ page: p, width: w, ...totals, firstView, ...m, errors, axe });
      await page.close();
    }
  }
  // print preview of the pricing page
  const pp = await browser.newPage();
  await pp.goto(`http://localhost:${PORT}/pricing/`, { waitUntil: "networkidle0" });
  await pp.emulateMediaType("print");
  await pp.pdf({ path: path.join(OUT, "pricing-print.pdf"), format: "A4", printBackground: false, margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" } });
  await pp.close();
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
const kb = (b) => (b / 1024).toFixed(0) + " KB";
let worst = { cls: 0 }, maxNoShots = 0, overflow = [], errs = [], axeV = new Map();
for (const r of results) {
  if (r.cls > worst.cls) worst = r;
  maxNoShots = Math.max(maxNoShots, r.bytesNoShots);
  if (r.overflow > 0) overflow.push(`${r.page}@${r.width} (+${r.overflow}px)`);
  if (r.errors.length) errs.push(`${r.page}@${r.width}: ${r.errors.join(" | ")}`);
  for (const v of r.axe?.violations || []) axeV.set(`${v.id} (${v.impact}): ${v.help}`, [...(axeV.get(`${v.id} (${v.impact}): ${v.help}`) || []), `${r.page}@${r.width} ${v.targets.join(", ")}`]);
  for (const v of r.axe?.darkContrast || []) axeV.set(`dark theme ${v.id}`, [...(axeV.get(`dark theme ${v.id}`) || []), `${r.page} ${v.targets.join(", ")}`]);
}
console.log(`Pages: ${pages.length}, widths: ${WIDTHS.join(", ")}`);
console.log(`Max weight excluding screenshots: ${kb(maxNoShots)}`);
for (const r of results.filter((r) => r.width === 1280)) console.log(`  ${r.page.padEnd(28)} all ${kb(r.bytes).padStart(7)}  no-shots ${kb(r.bytesNoShots).padStart(6)}  first view ${kb(r.firstView).padStart(7)}  CLS ${r.cls.toFixed(4)}`);
console.log(`Worst CLS: ${worst.cls.toFixed(4)} ${worst.page || ""}@${worst.width || ""}`);
console.log(`Horizontal overflow: ${overflow.length ? overflow.join(", ") : "none"}`);
console.log(`Console errors: ${errs.length ? "\n  " + errs.join("\n  ") : "none"}`);
console.log(axeSrc ? `axe-core violations: ${axeV.size ? "" : "none"}` : "axe-core: skipped (AXE_PATH not set)");
for (const [k, v] of axeV) console.log(`  ${k}\n    ${v.slice(0, 6).join("\n    ")}`);
