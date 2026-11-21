/** The one source of truth for the PostgreSQL tools folder (lib/pg.ts): flag, registry, detection. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectPgBin, resolvePgBin } from '../lib/pg.ts'
import { defaultConfig } from '../lib/model.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abfleet-pg-'))
const bin = (major: string, tools = true) => {
  const d = path.join(root, 'usr', 'lib', 'postgresql', major, 'bin')
  fs.mkdirSync(d, { recursive: true })
  if (tools) fs.writeFileSync(path.join(d, 'psql'), '')
  return d
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('PostgreSQL tools folder', () => {
  it('detects the highest major with psql (numeric order), or pg_config --bindir first', () => {
    expect(detectPgBin({ root, pgConfig: () => null })).toBe('')
    const v16 = bin('16')
    bin('9')
    bin('18', false)
    expect(detectPgBin({ root, pgConfig: () => null })).toBe(v16)
    const v17 = bin('17')
    expect(detectPgBin({ root, pgConfig: () => null })).toBe(v17)
    expect(detectPgBin({ root, pgConfig: () => v16 })).toBe(v16)
    // pg_config pointing at a folder without psql (client headers only) is not trusted
    expect(detectPgBin({ root, pgConfig: () => path.join(root, 'nowhere') })).toBe(v17)
  })

  it('order: --pg-bin, then the registry when psql is there, then detection', () => {
    const v16 = bin('16')
    expect(resolvePgBin('/x/bin', v16, () => 'detected')).toBe(path.resolve('/x/bin'))
    expect(resolvePgBin(undefined, v16, () => 'detected')).toBe(v16)
    expect(resolvePgBin(undefined, path.join(root, 'gone'), () => 'detected')).toBe('detected')
    expect(resolvePgBin(undefined, '', () => '')).toBe('')
  })

  it('a new registry names no PostgreSQL version (abfleet init records what it found)', () => {
    expect(defaultConfig('server', 'x.test').pgBin).toBe('')
    expect(JSON.stringify(defaultConfig('server', 'x.test'))).not.toMatch(/postgresql\/1\d/)
  })
})
