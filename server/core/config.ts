/** Server configuration from the environment, and workspace/server.json (the default connection). */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { MySqlSettings, ServerConfig } from './contracts.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const workspaceDir = path.resolve(overrides.workspaceDir ?? (env.APPBUILDER_WORKSPACE || path.join(projectRoot, 'workspace')))
  return {
    workspaceDir,
    filesDir: overrides.filesDir ?? path.join(workspaceDir, 'files'),
    attachmentsDir: overrides.attachmentsDir ?? path.join(workspaceDir, 'attachments'),
    host: overrides.host ?? (env.APPBUILDER_HOST || '127.0.0.1'),
    port: overrides.port ?? (Number(env.PORT) || 5174),
    distDir: overrides.distDir ?? path.join(projectRoot, 'dist'),
  }
}

export interface ServerJson {
  defaultConnection?: MySqlSettings & { passwordSealed: string }
}

export function readServerJson(config: ServerConfig): ServerJson {
  const file = path.join(config.workspaceDir, 'server.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ServerJson
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** atomic write, mode 0600 (the sealed password is useless without the key, but keep it private anyway) */
export function writeServerJson(config: ServerConfig, value: ServerJson): void {
  fs.mkdirSync(config.workspaceDir, { recursive: true })
  const file = path.join(config.workspaceDir, 'server.json')
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** APPBUILDER_DB_* bootstrap (skips the setup screen); null when not configured */
export function envDatabase(env: NodeJS.ProcessEnv = process.env): { settings: MySqlSettings; password: string } | null {
  if (!env.APPBUILDER_DB_HOST || !env.APPBUILDER_DB_NAME || !env.APPBUILDER_DB_USER) return null
  return {
    settings: {
      host: env.APPBUILDER_DB_HOST,
      port: Number(env.APPBUILDER_DB_PORT) || 3306,
      database: env.APPBUILDER_DB_NAME,
      user: env.APPBUILDER_DB_USER,
      ssl: env.APPBUILDER_DB_SSL === 'true',
    },
    password: env.APPBUILDER_DB_PASSWORD ?? '',
  }
}
