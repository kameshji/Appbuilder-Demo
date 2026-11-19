/**
 * The flow templates of the designer's "New flow" gallery (src/flows/templates/*.json, package B) are real definitions:
 * each one, filled in with tables that fit it, passes the server's validator without errors; the gallery's guesses fill
 * every parameter; and the purchase approval template is the exit-check flow.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TableDef } from '../../../src/platform/contracts.ts'
import { DEFAULT_SETTINGS } from '../../../src/platform/flows.ts'
import { guessParams, instantiate, missingParams, type FlowTemplate } from '../../../src/flows/designer/templateKit.ts'
import { flowEngine } from './expr.ts'
import { validateFlow } from './validate.ts'

const dir = path.resolve(import.meta.dirname, '../../../src/flows/templates')
const templates: FlowTemplate[] = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
const col = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, displayName: name, type, ...extra })
const tables = [
  { id: 't1', name: 'PurchaseRequests', displayName: 'Purchase requests', primaryColumn: 'Title', columns: [col('Title', 'text'), col('Amount', 'number'), col('Requester', 'email'), col('Manager', 'email'), col('Status', 'choice', { choices: ['New', 'Approved', 'Rejected', 'Escalated'] }), col('Due', 'date')] },
  { id: 't2', name: 'Archive', displayName: 'Archive', primaryColumn: 'Name', columns: [col('Name', 'text'), col('Note', 'multiline')] },
] as unknown as TableDef[]
const engine = flowEngine({ now: () => new Date('2030-01-01T00:00:00Z') })

describe('flow templates (designer gallery)', () => {
  it('there are the ten templates of the spec, with unique ids', () => {
    expect(templates.map((t) => t.id)).toEqual([
      'approval-above-amount', 'call-api-on-change', 'copy-row-on-status', 'daily-summary-email', 'escalate-overdue-tasks', 'notify-owner-on-create',
      'purchase-approval', 'reminder-before-date', 'scheduled-cleanup', 'webhook-create-row',
    ])
  })

  for (const t of templates) {
    it(`${t.id}: filled in, it passes the server validator`, async () => {
      const preset: Record<string, string> = { target: 'Archive', connection: 'conn_http', table: 'PurchaseRequests' }
      const values = guessParams(t, tables, Object.fromEntries(Object.entries(preset).filter(([k]) => t.params.some((p) => p.name === k))))
      expect(missingParams(t, values), JSON.stringify(values)).toEqual([])
      const def = instantiate(t, values)
      expect(JSON.stringify(def)).not.toMatch(/\{\{[A-Za-z0-9_]+\}\}/)
      const conns = new Map(Object.keys(def.connections ?? {}).map((ref) => [ref, 'http']))
      const problems = await validateFlow({ ...def, settings: { ...DEFAULT_SETTINGS, ...(def.settings as object) } } as never, { tables, flows: [], selfId: null, selfName: String(def.name), connections: conns, engine })
      expect(problems.filter((p) => p.severity === 'error'), JSON.stringify(problems, null, 1)).toEqual([])
    })
  }

  it('the purchase approval template is the exit-check flow (manager, escalation, second approval, outcome, requester told)', () => {
    const t = templates.find((x) => x.id === 'purchase-approval')!
    const def = instantiate(t, guessParams(t, tables)) as { steps: { id: string; kind: string; runAfter?: unknown }[]; settings: { concurrency: string } }
    expect(def.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(['mgr:approval', 'esc:scope', 'decide:condition', 'final:compose', 'status:data.update', 'tell:notify'])
    expect(def.steps[1].runAfter).toEqual([{ step: 'mgr', when: ['timedOut'] }])
    expect(def.settings.concurrency).toBe('perRecord')
    expect(t.needs).toContain('approvals')
  })

  it('dynamic content of an approval step and the approvalDecided trigger lists Status, Approvers, Comments and passes the validator', async () => {
    const approvalFlow = {
      name: 'Dyn', runAs: 'owner', settings: DEFAULT_SETTINGS, trigger: { type: 'table', table: 'PurchaseRequests', on: ['create'] },
      steps: [
        { id: 'ap', name: 'Approve', kind: 'approval', type: 'single', approvers: ['"a@example.com"'], title: '"t"' },
        { id: 'use', name: 'Use', kind: 'compose', value: '1' },
      ],
    }
    const decided = { name: 'Dec', runAs: 'owner', settings: DEFAULT_SETTINGS, trigger: { type: 'approvalDecided' }, steps: [{ id: 'use', name: 'Use', kind: 'compose', value: '1' }] }
    for (const [doc, want] of [
      [approvalFlow, ['Steps.Approve.Output.Status', 'Steps.Approve.Output.Approvers', 'Steps.Approve.Output.Comments', 'Steps.Approve.Output.Outcome', 'Steps.Approve.Output.Responses']],
      [decided, ['Trigger.Request.Status', 'Trigger.Request.Outcome', 'Trigger.Request.Title', 'Trigger.Request.RequestedByEmail', 'Trigger.Request.Fields', 'Trigger.Responses']],
    ] as const) {
      // the designer module uses the app's '@/' imports (vitest resolves them; the server typecheck does not)
      const dynamicPath = '../../../src/flows/designer/dynamic.ts'
      const { dynamicContent } = (await import(/* @vite-ignore */ dynamicPath)) as { dynamicContent: (doc: unknown, step: string, ctx: unknown) => { insert: string }[] }
      const toks = dynamicContent(doc, 'use', { tables })
      for (const w of want) expect(toks.map((t) => t.insert), w).toContain(w)
      // every token offered is a formula the server accepts in that step
      for (const t of toks) {
        const d = JSON.parse(JSON.stringify(doc))
        d.steps[d.steps.length - 1].value = t.insert
        const problems = await validateFlow(d, { tables, flows: [], selfId: null, selfName: d.name, connections: new Map(), engine })
        expect(problems.filter((p) => p.severity === 'error' && p.step === 'use'), `${t.insert}: ${JSON.stringify(problems)}`).toEqual([])
      }
    }
  })
})
