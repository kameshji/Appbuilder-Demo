/**
 * Auto apps: create the generated app through the normal app-creation path (platform.apps.create, then save the
 * definition), in server and demo mode alike. The browser side of the generator; the generator itself is pure.
 */
import { platform, PlatformError, type AppMeta, type TableDef } from '@/platform'
import type { Session } from '@/platform/contracts'
import { generateApp, type AutoAppOptions, type AutoAppPlan } from './generate.ts'

/**
 * Tables the signed-in maker may read (a UX mirror; the server enforces). Demo mode and administrators: all. System
 * tables have built-in security: listed as readable, their rows are trimmed by the server.
 */
export function readableFor(session: Session | null, mode: string): (t: TableDef) => boolean {
  if (mode !== 'server' || !session) return () => true
  const p = session.privileges
  if (p.isAdmin) return () => true
  return (t) => !!t.system || (p.tables[t.id]?.read ?? 'none') !== 'none'
}

export function planFor(opts: Omit<AutoAppOptions, 'readable'>): AutoAppPlan {
  const st = platform.getState()
  return generateApp(st.tables, { ...opts, readable: readableFor(st.session, st.mode) }).plan
}

/** Generate and create the app; returns the new app (open it in the Studio with go({ page: 'studio', id })). */
export async function createAutoApp(opts: Omit<AutoAppOptions, 'readable'>): Promise<{ meta: AppMeta; plan: AutoAppPlan }> {
  const st = platform.getState()
  const { def, plan } = generateApp(st.tables, { ...opts, readable: readableFor(st.session, st.mode) })
  if (plan.tables.length === 0) throw new PlatformError('invalid', plan.issues[0]?.message ?? 'Choose at least one table.')
  const meta = await platform.apps.create({ name: plan.name, width: def.width, height: def.height, template: 'blank' })
  // the platform may have made the name unique ("Orders app (2)")
  await platform.apps.save(meta.id, { ...def, name: meta.name })
  return { meta, plan }
}
