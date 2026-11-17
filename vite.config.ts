/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import appbuilderFs from './server/vite-plugin.mjs'

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), appbuilderFs()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
})
