/**
 * Print templates in solutions (P2 package B; docs/dev/pdf.md "Solutions"). A package carries, per template: id, name,
 * description, kind, the published document (or the draft when never published), the Word file (base64) of a docx
 * template, and run-as only when it is "caller" (a service account never travels: imported templates run as the caller
 * and the plan says so). The plan lists templates as new / changed / unchanged / removed; apply writes them as
 * published (a new version), inside the import's transaction. The generation log and generated files never travel.
 */
import type { Services, SqlDb, UserContext } from '../contracts.ts'
import type { PlanItem } from '../../../src/platform/http.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import { docProblems, normaliseDoc, type PrintTemplateDoc } from '../../../src/platform/print.ts'

export interface PkgPrintTemplate { id: string; name: string; description?: string; kind: 'pdf' | 'docx'; doc: PrintTemplateDoc; docxBase64?: string; docxFileName?: string; serviceAccount?: boolean }
export interface PrintTemplateOps { upsert: { pkg: PkgPrintTemplate; existing: boolean }[]; remove: string[] }

type Row = Record<string, unknown>
const T = (t: string): string => `"${currentEnvironment().schema}"."${t}"`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
const db = (s: Services): SqlDb => {
  const d = (s as unknown as { state?: { db?: SqlDb | null } }).state?.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

export async function exportPrintTemplates(s: Services, ids: string[]): Promise<PkgPrintTemplate[]> {
  if (!ids.length) return []
  const rows = await db(s).query<Row>(`SELECT * FROM ${T('ab_print_templates')} WHERE id = ANY($1::text[]) ORDER BY lower(name)`, [ids])
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), ...(r.description ? { description: String(r.description) } : {}), kind: r.kind === 'docx' ? 'docx' as const : 'pdf' as const,
    doc: normaliseDoc(r.published ?? r.doc), ...(r.docx ? { docxBase64: Buffer.from(r.docx as Buffer).toString('base64'), docxFileName: String(r.docx_name ?? 'template.docx') } : {}),
    ...(isObj(r.run_as) ? { serviceAccount: true } : {}),
  }))
}

export function readPkgPrintTemplates(v: unknown): PkgPrintTemplate[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(422, 'invalid', 'The package "printTemplates" must be a list.')
  return v.map((p) => {
    if (!isObj(p) || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(422, 'invalid', 'A print template in the package is malformed.')
    const doc = normaliseDoc(p.doc)
    const problems = docProblems(doc)
    if (problems.length) throw new HttpError(422, 'invalid', `The print template "${p.name}" in the package is not valid: ${problems[0].path}: ${problems[0].message}`)
    const kind = p.kind === 'docx' ? 'docx' : 'pdf'
    if (kind === 'docx' && typeof p.docxBase64 !== 'string') throw new HttpError(422, 'invalid', `The Word template "${p.name}" in the package has no file.`)
    return {
      id: p.id, name: p.name.trim().slice(0, 120), ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}), kind, doc,
      ...(kind === 'docx' ? { docxBase64: String(p.docxBase64), docxFileName: String(p.docxFileName ?? 'template.docx') } : {}), ...(p.serviceAccount === true ? { serviceAccount: true } : {}),
    }
  })
}

export async function planPrintTemplates(s: Services, user: UserContext, pkg: PkgPrintTemplate[] | undefined, previous: string[]): Promise<{ items: PlanItem[]; problems: string[]; warnings: string[]; ops: PrintTemplateOps; matched: boolean }> {
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const ops: PrintTemplateOps = { upsert: [], remove: [] }
  let matched = false
  if (!pkg || (!pkg.length && !previous.length)) return { items, problems, warnings, ops, matched }
  if (pkg.length && !user.privileges.isMaker) problems.push('Only makers can import print templates.')
  const existing = await db(s).query<Row>(`SELECT id, name, description, kind, published, doc, docx FROM ${T('ab_print_templates')}`)
  const tables = await s.meta.tables.list()
  for (const p of pkg) {
    const cur = existing.find((x) => String(x.id) === p.id)
    if (cur) matched = true
    if (!cur && existing.some((x) => String(x.name).toLowerCase() === p.name.toLowerCase())) problems.push(`A print template named "${p.name}" already exists here with another identity; rename one of them.`)
    const src = p.doc.source
    if ((src.kind === 'record' || src.kind === 'query') && !tables.some((t) => t.name.toLowerCase() === src.table.toLowerCase() || t.id === src.table)) {
      warnings.push(`The print template "${p.name}" reads the table ${src.table}, which is not here (it works once the table exists).`)
    }
    if (p.serviceAccount) warnings.push(`The print template "${p.name}" ran as a service account where it came from; here it runs as the person who prints until an administrator sets one.`)
    const curDoc = cur ? normaliseDoc(cur.published ?? cur.doc) : null
    const curDocx = cur?.docx ? Buffer.from(cur.docx as Buffer).toString('base64') : undefined
    const changed = !cur || canon({ n: cur.name, d: cur.description ?? undefined, k: cur.kind, doc: curDoc, x: curDocx }) !== canon({ n: p.name, d: p.description, k: p.kind, doc: p.doc, x: p.docxBase64 })
    items.push({ kind: 'printTemplate' as PlanItem['kind'], id: p.id, name: p.name, change: !cur ? 'new' : changed ? 'changed' : 'unchanged', ...(changed && cur ? { note: 'published as a new version (the history keeps the old one)' } : {}) })
    if (changed) ops.upsert.push({ pkg: p, existing: !!cur })
  }
  for (const id of previous) {
    if (pkg.some((p) => p.id === id)) continue
    const cur = existing.find((x) => String(x.id) === id)
    if (!cur) continue
    items.push({ kind: 'printTemplate' as PlanItem['kind'], id, name: String(cur.name), change: 'removed', note: 'documents already generated stay where they were stored' })
    ops.remove.push(id)
  }
  return { items, problems, warnings, ops, matched }
}

/** inside the import's transaction */
export async function applyPrintTemplates(s: Services, userId: string, ops: PrintTemplateOps, solutionId: string): Promise<void> {
  if (!ops.upsert.length && !ops.remove.length) return
  const d = db(s)
  for (const u of ops.upsert) {
    const p = u.pkg
    const docx = p.docxBase64 ? Buffer.from(p.docxBase64, 'base64') : null
    const table = p.doc.source.kind === 'record' || p.doc.source.kind === 'query' ? p.doc.source.table : null
    const v = Number((await d.query<Row>(`SELECT version FROM ${T('ab_print_templates')} WHERE id = $1`, [p.id]))[0]?.version ?? 0) + 1
    await d.exec(
      `INSERT INTO ${T('ab_print_templates')} (id, name, description, kind, table_name, doc, published, version, run_as, docx, docx_name, owner_id, solution_id, created_by, created_on, modified_by, modified_on)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $6::jsonb, $7, '"caller"'::jsonb, $8, $9, $10, $11, $10, now(), $10, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, kind = EXCLUDED.kind, table_name = EXCLUDED.table_name, doc = EXCLUDED.doc,
         published = EXCLUDED.published, version = EXCLUDED.version, docx = EXCLUDED.docx, docx_name = EXCLUDED.docx_name, solution_id = EXCLUDED.solution_id, modified_by = EXCLUDED.modified_by, modified_on = EXCLUDED.modified_on`,
      [p.id, p.name, p.description ?? null, p.kind, table, JSON.stringify(p.doc), v, docx, p.docxFileName ?? null, userId, solutionId],
    )
    await d.exec(`INSERT INTO ${T('ab_print_template_versions')} (template_id, version, doc, docx, saved_by, saved_on, note) VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6) ON CONFLICT DO NOTHING`, [p.id, v, JSON.stringify(p.doc), docx, userId, `solution ${solutionId}`])
  }
  if (ops.remove.length) {
    await d.exec(`DELETE FROM ${T('ab_print_template_versions')} WHERE template_id = ANY($1::text[])`, [ops.remove])
    await d.exec(`DELETE FROM ${T('ab_print_templates')} WHERE id = ANY($1::text[])`, [ops.remove])
  }
}
