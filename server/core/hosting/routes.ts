/**
 * Hosting routes and wiring (H-A, H-C), registered by createRouter (router.ts) so every router has them:
 *
 *   GET /api/v1/install/read-only   signed-in people: { readOnly: null | { reason, message, since, text, stillWorks } }
 *                                    (the portal's banner, src/portal/ReadOnlyBanner.tsx); install administrators also
 *                                    see where it was set (source) and what leaves the state
 *   GET /api/v1/install/public-address  administrators: { publicUrl, locked } (APPBUILDER_PUBLIC_URL)
 *
 * and the job runner's read-only hook (jobs.ts setReadOnly): the gate's state, read without waiting.
 */
import type { Router } from '../contracts.ts'
import { STILL_WORKS, READ_ONLY_TEXT, jobRunsWhenReadOnly, type ReadOnlyGate } from './read-only.ts'
import { lockedPublicUrl } from './settings.ts'

interface MaybeKernel {
  kernel?: { jobs?: { setReadOnly?(gate: { paused(): Promise<boolean>; runs(type: string): boolean } | null): void } }
}

const LEAVE: Record<string, string> = {
  env: 'The operator set APPBUILDER_READ_ONLY in this install\'s environment; it ends when the operator removes it and restarts the install (abfleet resume).',
  cli: 'Set with the server command "read-only on"; "read-only off" on the server ends it (abfleet resume).',
  licence: 'Ends by itself when the licence service answers again.',
}

export function hostingRoutes(router: Router, services: object, gate: ReadOnlyGate): void {
  router.add('GET', '/install/read-only', async (ctx) => {
    const s = await gate.state()
    if (!s) return { readOnly: null }
    const admin = !!ctx.user?.privileges.isInstallAdmin
    return {
      readOnly: {
        reason: s.reason, message: s.message, since: s.since, text: READ_ONLY_TEXT[s.reason], stillWorks: STILL_WORKS,
        ...(admin ? { source: s.source, leave: LEAVE[s.source] } : {}),
      },
    }
  }, { auth: 'user', noEnvironment: true, allowPendingPasswordChange: true, allowPendingMfaEnrolment: true })

  // H-B: whether the public address is locked by the operator (APPBUILDER_PUBLIC_URL), also before an email relay is
  // set up (Admin console > Email shows the field read-only with the reason). The address is no secret: every link
  // the install sends starts with it.
  router.add('GET', '/install/public-address', async () => {
    const locked = lockedPublicUrl(services)
    return { publicUrl: locked, locked: !!locked }
  }, { auth: 'admin', noEnvironment: true })

  const jobs = (services as MaybeKernel).kernel?.jobs
  jobs?.setReadOnly?.({ paused: async () => (await gate.state()) !== null, runs: jobRunsWhenReadOnly })
}
