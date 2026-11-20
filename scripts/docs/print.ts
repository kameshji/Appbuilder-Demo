/**
 * docs/reference/print-templates.md: the blocks of print templates, the formula names and functions templates see,
 * the page sizes and the limits, generated from src/platform/print.ts (the catalogue GET /print/catalog serves) and the
 * server's print functions.
 */
import { BLOCK_CATALOGUE, PAGE_SIZES, PRINT_LIMITS } from '../../src/platform/print.ts'
import { STEP_KINDS } from '../../src/platform/flows.ts'
import { GENERATED_NOTICE, cell, code, table } from './markdown'

const FUNCTIONS: [string, string][] = [
  ['FormatNumber(value [, decimals])', 'A number with the environment\'s digit grouping: Indian (12,34,567.50) or international (1,234,567.50).'],
  ['FormatCurrency(value [, currency [, decimals]])', 'An amount with the currency symbol, e.g. ₹12,34,567.00 (currency: the environment\'s, else a code such as "USD").'],
  ['FormatPercent(value [, decimals])', 'A fraction (0.785) or a percentage (78.5) as 78.5%.'],
  ['FormatDate(value [, pattern])', 'A date in the environment\'s date format, or a pattern: yyyy, yy, MMMM, MMM, MM, M, dd, d, HH, H, hh, h, mm, ss, a; text in single quotes is literal.'],
  ['Now(), Today()', 'The date and time of the generation (the time zone of the print settings).'],
]
const NAMES: [string, string][] = [
  ['ThisRecord, Record, or a column name', 'The record (record source; a formula source returning a record). Lookups print the target\'s primary column.'],
  ['Related.<name>', 'A related list of the record source (child rows whose lookup points at the record).'],
  ['Rows', 'The rows of a query source, or of a formula source returning a table.'],
  ['ThisItem', 'The row inside a table column, a repeated section, a chart, a group header.'],
  ['Company', 'The letterhead: Name, Address, Phone, Email, Website, GSTIN.'],
  ['User()', 'The identity the document is generated as: FullName, Email, Id.'],
  ['{PageNumber}, {PageCount}', 'Header and footer texts only: the page number and the number of pages.'],
  ['{Group}, {Count}', 'Group header texts of tables: the group\'s value and its number of rows.'],
]

export function buildPrintPage(): { text: string } {
  const out: string[] = [GENERATED_NOTICE, '', '# Print templates reference', '']
  out.push('The blocks of a print template, the names and functions its formulas see, page sizes and limits. Guide: [print templates for makers](../guide/maker/print-templates.md); design: [docs/dev/pdf.md](../dev/pdf.md).', '')
  out.push('Every text property accepts formulas in `{...}` (write `{{` and `}}` for literal braces). Properties named rows, value, label, visible and the values of key-value entries are formulas themselves. Sizes are millimetres, font sizes points.', '')
  out.push('## Blocks', '')
  for (const g of ['Text', 'Data', 'Graphics', 'Layout'] as const) {
    out.push(`### ${g}`, '')
    for (const b of BLOCK_CATALOGUE.filter((x) => x.group === g)) {
      out.push(`#### ${b.title} (${code(b.kind)})`, '', cell(b.summary), '')
      if (b.props.length) out.push(table(['Property', 'What it is'], b.props.map(([n, t]) => [code(n), cell(t)])), '')
      out.push('Every block also has `visible` (a formula; blank: shown), `keepTogether`, `spaceBefore` and `spaceAfter` (mm).', '')
    }
  }
  out.push('## Names in formulas', '', table(['Name', 'What it is'], NAMES.map(([n, t]) => [code(n), cell(t)])), '')
  out.push('## Functions of print templates', '', 'Besides every pure formula function (and delegable table reads such as LookUp and Filter, read as the generating identity):', '', table(['Function', 'What it does'], FUNCTIONS.map(([n, t]) => [code(n), cell(t)])), '')
  out.push('## Page sizes', '', table(['Size', 'Width x height (mm, portrait)'], Object.entries(PAGE_SIZES).map(([k, [w, h]]) => [code(k), `${w} x ${h}`])), '', '`custom`: 50 to 1,200 mm each way. Orientation portrait or landscape; margins 0 to 100 mm.', '')
  out.push('## Limits', '', table(['Limit', 'Value'], Object.entries(PRINT_LIMITS).map(([k, v]) => [code(k), String(v)])), '')
  const step = STEP_KINDS.find((k) => k.kind === 'document.generate')
  if (step) {
    out.push('## The flow step `document.generate`', '', cell(step.summary), '', table(['Field', 'Type', 'Required', 'What it is'], step.fields.map((f) => [code(f.name), cell(f.type), f.required ? 'yes' : '', cell(f.doc)])), '', `**Output:** ${cell(step.output)}`, '', `**Guarantee:** ${cell(step.guarantee)}`, '')
  }
  return { text: out.join('\n') }
}
