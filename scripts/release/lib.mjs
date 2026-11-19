/** Shared by build.mjs and sign.mjs (package L). */
import fs from 'node:fs'
import path from 'node:path'
import { formatSums, listFiles, sha256File } from '../../server/core/update/release.ts'
import { writeZip } from '../../server/core/update/zip.ts'

/** files recorded as executable in the ZIP (shell scripts) */
export const isExec = (f) => /\.sh$/.test(f)

/** the release folder as <folder>.zip with every entry under <folder name>/, plus <zip>.sha256; returns the zip path */
export function zipRelease(folder) {
  const base = path.basename(folder)
  const entries = listFiles(folder).map((f) => ({ name: `${base}/${f}`, data: fs.readFileSync(path.join(folder, f)), mode: isExec(f) ? 0o755 : 0o644 }))
  const out = `${folder}.zip`
  fs.writeFileSync(out, writeZip(entries))
  fs.writeFileSync(`${out}.sha256`, formatSums([{ file: path.basename(out), sha256: sha256File(out) }]))
  return out
}
