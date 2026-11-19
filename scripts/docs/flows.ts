/**
 * docs/reference/flows.md: the trigger types and step kinds of flows, generated from the catalogue in
 * src/platform/flows.ts (the same data the designer palette and GET /flows/catalog use).
 */
import { FLOW_LIMITS, STEP_KINDS, TRIGGER_TYPES } from '../../src/platform/flows.ts'
import { GENERATED_NOTICE, anchor, cell, code, table } from './markdown'

export function buildFlowsPage(): { text: string } {
  const out: string[] = [GENERATED_NOTICE, '', '# Flows reference: triggers and steps', '']
  out.push('What each trigger type and step kind of a flow takes, what it gives to later steps (`Steps.<name>.Output`) and how often its effect happens when a server stops in the middle. Concepts and examples: [the maker guide](../guide/maker/flows.md); design: [docs/dev/flows.md](../dev/flows.md).', '')
  out.push('Every step also takes `id`, `name`, `description`, `runAfter` (`[{ step, when: ["succeeded" | "failed" | "skipped" | "timedOut"] }]`), `retry` (`{ type: "none" | "fixed" | "exponential", count, intervalSeconds, maxIntervalSeconds }`) and `timeoutMinutes`.', '')
  out.push('## Contents', '', '- [Triggers](#triggers)')
  for (const t of TRIGGER_TYPES) out.push(`  - [${t.title}](#${anchor(t.title)})`)
  out.push('- [Steps](#steps)')
  for (const s of STEP_KINDS) out.push(`  - [${s.title}](#${anchor(s.title)})`)
  out.push('- [Limits](#limits)', '', '## Triggers', '')
  for (const t of TRIGGER_TYPES) {
    out.push(`### ${t.title}`, '', `${code(`type: "${t.type}"`)}${t.reserved ? ' (reserved)' : ''}. ${t.summary}`, '')
    if (t.fields.length) out.push(table(['Field', 'Type', 'Required', 'What it is'], t.fields.map((f) => [code(f.name), cell(f.type), f.required ? 'yes' : '', cell(f.doc)])), '')
    out.push(`**Expressions see:** ${cell(t.scope)}`, '', `**Guarantee:** ${cell(t.guarantee)}`, '')
  }
  out.push('## Steps', '')
  for (const group of ['Control', 'Data', 'People', 'Integration', 'Run'] as const) {
    for (const s of STEP_KINDS.filter((k) => k.group === group)) {
      out.push(`### ${s.title}`, '', `${code(`kind: "${s.kind}"`)} (${group}${s.container ? ', container' : ''}${s.suspends ? ', waits' : ''}). ${s.summary}`, '')
      out.push(table(['Field', 'Type', 'Required', 'What it is'], s.fields.map((f) => [code(f.name), cell(f.type), f.required ? 'yes' : '', cell(f.doc)])), '')
      out.push(`**Output:** ${cell(s.output)}`, '', `**Guarantee:** ${cell(s.guarantee)}`, '', `**Default retry:** ${cell(s.defaultRetry)}`, '', '```json', JSON.stringify(s.example), '```', '')
    }
  }
  out.push('## Limits', '', table(['Limit', 'Value'], Object.entries(FLOW_LIMITS).map(([k, v]) => [code(k), String(v)])), '')
  return { text: out.join('\n') }
}
