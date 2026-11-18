/**
 * Where an installed Appbuilder lives (package L). The installers write <install root>/install.json and pass
 * APPBUILDER_INSTALL_ROOT to the service. Layout (both systems):
 *
 *   <root>/app              the current release (this code)            Windows C:\Program Files\Appbuilder
 *   <root>/app.previous     the release before the last update          Linux   /opt/appbuilder
 *   <root>/node             the private Node.js
 *   <data>/workspace        server.json, .secret-key, env/, logs/       Windows C:\ProgramData\Appbuilder
 *   <data>/backups          backup archives                             Linux   /var/lib/appbuilder
 *   <data>/updates          packages uploaded in Admin console > Updates, the update history
 */
import fs from 'node:fs'
import path from 'node:path'

export interface InstallInfo {
  /** "windows" or "linux" */
  platform: 'windows' | 'linux'
  root: string
  dataDir: string
  workspace: string
  serviceName: string
  /** the account the service runs as (Linux user, or Windows account name) */
  serviceAccount: string
  port: number
  /** path of node(.exe) the service runs */
  node: string
  /** "none" | "lan" | "domain" */
  https: string
  /** KEY=VALUE file with the service's environment (APPBUILDER_*, PORT); the command-line tools load it too */
  envFile: string
  /** the installer version that wrote this file */
  installerVersion: string
  installedOn: string
}

export function installRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.APPBUILDER_INSTALL_ROOT ? path.resolve(env.APPBUILDER_INSTALL_ROOT) : null
}

export function readInstallInfo(root: string | null): InstallInfo | null {
  if (!root) return null
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8').replace(/^\uFEFF/, '')) as InstallInfo
    return v && typeof v === 'object' && typeof v.root === 'string' ? v : null
  } catch {
    return null
  }
}

/** <data>/updates: staged packages and history (writable by the service account) */
export function updatesDir(info: InstallInfo | null, workspaceDir: string): string {
  return info ? path.join(info.dataDir, 'updates') : path.join(workspaceDir, 'updates')
}

/** KEY=VALUE lines (# comments, optional single or double quotes); used for the service environment file */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** the install root of the release this code runs from: APPBUILDER_INSTALL_ROOT, or the parent of an "app" folder with install.json */
export function detectInstallRoot(appDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = installRoot(env)
  if (fromEnv) return fromEnv
  const parent = path.dirname(appDir)
  return fs.existsSync(path.join(parent, 'install.json')) ? parent : null
}
