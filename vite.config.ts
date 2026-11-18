/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import fs from 'node:fs'
import appbuilderFs from './server/vite-plugin.mjs'

/** build-time facts for Settings > About: the version (package.json) and the notices summary table (name, version, licence) */
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
function noticesSummary(): [string, string, string][] {
  try {
    const md = fs.readFileSync(path.resolve(__dirname, 'THIRD-PARTY-NOTICES.md'), 'utf8')
    const at = md.indexOf('## Summary')
    if (at < 0) return []
    const rows: [string, string, string][] = []
    for (const line of md.slice(at).split('\n').slice(1)) {
      if (line.startsWith('## ')) break
      const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line)
      if (m && m[1] !== 'Package' && !m[1].startsWith('---')) rows.push([m[1], m[2], m[3]])
    }
    return rows
  } catch {
    return []
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), appbuilderFs()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __THIRD_PARTY__: JSON.stringify(noticesSummary()),
  },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'scripts/**/*.test.ts'] },
})
