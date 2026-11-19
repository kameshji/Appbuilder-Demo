// Finds puppeteer-core and a Chrome binary for the optional tools (Open Graph images, review screenshots).
// puppeteer-core (Apache-2.0) is not a dependency of the site: install it anywhere and point PUPPETEER_CORE at it,
// e.g. PUPPETEER_CORE=/tmp/pgcheck/node_modules/puppeteer-core. CHROME_PATH sets the browser.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function launch() {
  const candidates = [process.env.PUPPETEER_CORE, "/tmp/pgcheck/node_modules/puppeteer-core"].filter(Boolean);
  let mod;
  try { mod = await import("puppeteer-core"); } catch {
    for (const c of candidates) {
      const entry = ["lib/puppeteer/puppeteer-core.js", "lib/esm/puppeteer/puppeteer-core.js"].map((e) => path.join(c, e)).find(existsSync);
      if (entry) { mod = await import(pathToFileURL(entry).href); break; }
    }
  }
  if (!mod) throw new Error("puppeteer-core not found. Set PUPPETEER_CORE to its folder.");
  const puppeteer = mod.default || mod;
  const exe = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  return puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
}
