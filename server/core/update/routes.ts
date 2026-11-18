/**
 * Admin console > Updates (package L): shows the installed release, takes a release ZIP, checks its checksums and
 * signature against the keys this install trusts, shows its release notes, and keeps it staged in <data>/updates/staged.
 *
 * The web page does not apply the update. The service runs as a low-privilege account that cannot write the program
 * folder (by design: a stolen administrator session must not be able to replace the server's code). An administrator on
 * the server runs the shown command (`appbuilder update --staged`), which checks the package again as root /
 * Administrator before it installs it (apply.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from '../contracts.ts'
import type { Ctx, Router, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { StagedUpdate, UpdatesInfo } from '../../../src/platform/ops.ts'
import { log, errText } from '../util.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { serverVersion } from '../auth.ts'
import { appRoot, readReleaseInfo, readTrustedKeys } from './release.ts'
import { packageProblems, preparePackage, readHistory } from './apply.ts'
import { detectInstallRoot, readInstallInfo, updatesDir } from './layout.ts'

const MAX_UPLOAD_MB = 1024

function installAdmin(ctx: Ctx): UserContext {
  const u = ctx.user
  if (!u) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
  if (!u.privileges.isInstallAdmin) throw new HttpError(403, 'denied', 'Only install administrators can manage updates.')
  return u
}

export function updateRoutes(router: Router, services: CoreServices): void {
  const opts = { auth: 'user' as const, noEnvironment: true }
  const info = () => readInstallInfo(detectInstallRoot(appRoot()))
  const dir = () => updatesDir(info(), services.config.workspaceDir)
  const stagedDir = () => path.join(dir(), 'staged')
  const stagedJson = () => path.join(stagedDir(), 'staged.json')
  const readStaged = (): StagedUpdate | null => {
    try {
      return JSON.parse(fs.readFileSync(stagedJson(), 'utf8')) as StagedUpdate
    } catch {
      return null
    }
  }
  const applyCommand = (): string | null => {
    const i = info()
    if (!i) return null
    return i.platform === 'linux' ? 'sudo appbuilder update --staged' : `& "${path.join(i.root, 'appbuilder.cmd')}" update --staged   (in an elevated PowerShell)`
  }

  router.add('GET', '/api/v1/admin/updates', async (ctx): Promise<UpdatesInfo> => {
    installAdmin(ctx)
    const rel = readReleaseInfo()
    return {
      current: {
        version: rel?.version ?? serverVersion(), commit: rel?.commit ?? 'dev', built: rel?.built ?? null, schemaVersion: SCHEMA_VERSION,
        trustedKeys: readTrustedKeys().map((k) => ({ id: k.id, ...(k.comment ? { comment: k.comment } : {}) })),
      },
      installed: !!info(),
      staged: readStaged(),
      history: readHistory(path.join(dir(), 'history.json')).slice(0, 20),
      applyCommand: applyCommand(),
    }
  }, opts)

  router.add('POST', '/api/v1/admin/updates/upload', async (ctx): Promise<StagedUpdate> => {
    const u = installAdmin(ctx)
    if (!ctx.readBody) throw new HttpError(400, 'invalid', 'Send the release ZIP as the request body.')
    const body = await ctx.readBody(MAX_UPLOAD_MB * 1024 * 1024)
    if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) throw new HttpError(422, 'invalid', 'This is not a ZIP file. Upload the appbuilder-<version>.zip release package.')
    const sd = stagedDir()
    fs.rmSync(sd, { recursive: true, force: true })
    fs.mkdirSync(sd, { recursive: true, mode: 0o750 })
    const zip = path.join(sd, 'upload.zip')
    fs.writeFileSync(zip, body, { mode: 0o640 })
    let staged: StagedUpdate
    try {
      const p = preparePackage(zip, path.join(sd, 'package'), appRoot())
      const trusted = readTrustedKeys()
      const problems = packageProblems(p, trusted.length)
      const current = readReleaseInfo()
      if (current && p.info.version === current.version && p.info.commit === current.commit) problems.push('This release is already installed.')
      if (p.info.schemaVersion < SCHEMA_VERSION) problems.push(`The package's schema version (${p.info.schemaVersion}) is older than this server's (${SCHEMA_VERSION}); it could not use the database.`)
      const sig = p.signature
      staged = {
        version: p.info.version, commit: p.info.commit, built: p.info.built, schemaVersion: p.info.schemaVersion, node: p.info.node,
        files: p.check.files, checksums: p.check.ok ? 'ok' : 'failed',
        signature: { state: sig.state, ...('keyId' in sig ? { keyId: sig.keyId } : {}), ...(sig.state === 'invalid' ? { reason: sig.reason } : {}) },
        applicable: problems.length === 0, problems,
        releaseNotes: p.notes.slice(0, 200_000),
        stagedAt: new Date().toISOString(),
        folder: p.dir,
      }
    } catch (e) {
      fs.rmSync(sd, { recursive: true, force: true })
      throw new HttpError(422, 'invalid', `The package could not be read: ${errText(e)}`)
    } finally {
      fs.rmSync(zip, { force: true })
    }
    fs.writeFileSync(stagedJson(), JSON.stringify(staged, null, 2) + '\n', { mode: 0o640 })
    log('info', `update package ${staged.version} (${staged.commit.slice(0, 12)}) staged by ${u.user.id}: checksums ${staged.checksums}, signature ${staged.signature.state}`)
    try {
      await services.install.audit({ userId: u.user.id, action: 'update.stage', details: { version: staged.version, commit: staged.commit, signature: staged.signature.state, applicable: staged.applicable } })
    } catch { /* best effort */ }
    return staged
  }, { ...opts, raw: true, streamBody: true, maxBodyMB: MAX_UPLOAD_MB })

  router.add('DELETE', '/api/v1/admin/updates/staged', async (ctx) => {
    installAdmin(ctx)
    fs.rmSync(stagedDir(), { recursive: true, force: true })
    return { ok: true }
  }, opts)
}
