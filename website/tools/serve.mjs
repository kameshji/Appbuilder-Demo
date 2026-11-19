#!/usr/bin/env node
// Tiny static file server for previewing dist/ (zero dependencies). Usage: node tools/serve.mjs [dir] [port]
// Serves index.html for folders, 404.html for missing files, and the same security headers we recommend in production.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "dist");
const port = Number(process.argv[3] || 8080);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };
const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()", "X-Frame-Options": "DENY" };

http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dir, p);
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (s.isDirectory()) {
      if (!p.endsWith("/")) { res.writeHead(301, { Location: p + "/" }).end(); return; }
      file = path.join(file, "index.html");
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", ...HEADERS }).end(body);
  } catch {
    const body = await readFile(path.join(dir, "404.html")).catch(() => "Not found");
    res.writeHead(404, { "Content-Type": TYPES[".html"], ...HEADERS }).end(body);
  }
}).listen(port, () => console.log(`Serving ${dir} at http://localhost:${port}/`));
