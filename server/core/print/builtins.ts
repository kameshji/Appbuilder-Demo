/**
 * Built-in print templates (docs/guide/maker/print-templates.md "Built-in templates"). Installing one creates an
 * ordinary, editable template. The manufacturing ones expect the tables and columns listed in `expects` (the pilot's
 * model, PILOT_MODEL in builtins.test data); a maker adapts names in the designer when theirs differ. The generic record
 * sheet and table list are made from the chosen table's own columns.
 */
import type { TableDef } from '../../../src/platform/contracts.ts'
import { emptyDoc, type CellFormat, type PrintTemplateDoc } from '../../../src/platform/print.ts'

export interface BuiltinInfo { key: string; name: string; description: string; needsTable: boolean; expects: string }

export const BUILTINS: BuiltinInfo[] = [
  { key: 'inspection-report', name: 'Inspection report', description: 'An inspection with its details, a defect table with totals, photos, a QR code and signature lines.', needsTable: false, expects: 'Inspections (Number, Product, Machine, Batch, Inspector, InspectedOn, Result, Notes, Photos) and InspectionDefects (Inspection -> Inspections, Defect, Severity, Qty, Action)' },
  { key: 'daily-oee', name: 'Daily production and OEE summary', description: 'KPI tiles, an OEE gauge, OEE by machine as a chart and the production log grouped by machine with subtotals.', needsTable: false, expects: 'ProductionLogs (LogDate, Machine, Shift, PlannedMinutes, RunMinutes, IdealRatePerMinute, TotalCount, GoodCount)' },
  { key: 'purchase-request', name: 'Purchase request', description: 'A purchase request with its lines, a total and the approval history.', needsTable: false, expects: 'PurchaseRequests (Number, Title, Requester, Department, NeededBy, Status, Justification) and PurchaseRequestLines (Request -> PurchaseRequests, Item, Qty, Unit, Rate)' },
  { key: 'delivery-challan', name: 'Delivery challan', description: 'A delivery note: consignee, vehicle, items and quantities, receiver signature. No tax is computed.', needsTable: false, expects: 'DeliveryChallans (Number, ChallanDate, Customer, ShipTo, VehicleNo, Transporter, Reference) and ChallanLines (Challan -> DeliveryChallans, Item, HSN, Qty, Unit, Remarks)' },
  { key: 'record-sheet', name: 'Record sheet', description: 'Every column of one record of the table you choose, as a label/value sheet.', needsTable: true, expects: 'any table' },
  { key: 'table-list', name: 'Table list', description: 'Rows of the table you choose as a landscape list with the header on every page.', needsTable: true, expects: 'any table' },
]

const formatOf = (type: string): CellFormat | undefined =>
  type === 'number' ? 'number' : type === 'decimal' ? 'number' : type === 'currency' ? 'currency' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime' : type === 'boolean' ? 'boolean' : undefined
const printable = (t: TableDef) => t.columns.filter((c) => !c.system && !['file', 'image', 'json'].includes(c.type as string))
const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`)

export function builtinDoc(key: string, table?: TableDef): PrintTemplateDoc {
  switch (key) {
    case 'inspection-report': {
      const d = emptyDoc('Inspections')
      d.source = { kind: 'record', table: 'Inspections', related: [{ name: 'Defects', table: 'InspectionDefects', column: 'Inspection', sort: [{ column: 'createdOn' }] }] }
      d.fileName = 'Inspection {Number}'
      d.metadata = { title: 'Inspection report {Number}', subject: '{Product}' }
      d.header = { blocks: [], letterhead: 'first', right: 'Inspection {Number}' }
      d.footer = { blocks: [], pageNumbers: true, left: 'Printed {FormatDate(Now(), "dd-MM-yyyy HH:mm")} by {User().FullName}' }
      d.body = [
        { id: 'cols', kind: 'columns', columns: [
          { blocks: [{ id: 'h', kind: 'heading', level: 1, text: 'Inspection report' }, { id: 'sub', kind: 'text', text: '**{Number}** · {Product}', size: 11 }] },
          { width: 30, blocks: [{ id: 'qr', kind: 'barcode', symbology: 'qr', value: '"INSP:" & Number', width: 24, align: 'right' }] },
        ] },
        { id: 'pass', kind: 'text', text: 'Result: **[color=#16a34a]PASS[/color]**', size: 12, visible: 'Result = "Pass"' },
        { id: 'fail', kind: 'text', text: 'Result: **[color=#dc2626]{Upper(Result)}[/color]**', size: 12, visible: 'Result <> "Pass"' },
        { id: 'kv', kind: 'keyValue', columns: 2, items: [
          { label: 'Product', value: 'Product' }, { label: 'Batch', value: 'Batch' }, { label: 'Machine', value: 'Machine' }, { label: 'Inspector', value: 'Inspector' },
          { label: 'Inspected on', value: 'InspectedOn', format: 'date' }, { label: 'Defects', value: 'CountRows(Related.Defects)', format: 'integer' },
        ] },
        { id: 'h2', kind: 'heading', level: 2, text: 'Defects' },
        { id: 'tbl', kind: 'table', rows: 'Related.Defects', totals: true, emptyText: 'No defects were found.', columns: [
          { header: 'Defect', value: 'ThisItem.Defect', flex: 3, total: 'label', totalLabel: 'Total' },
          { header: 'Severity', value: 'ThisItem.Severity', width: 28 },
          { header: 'Qty', value: 'ThisItem.Qty', width: 20, format: 'integer', align: 'right', total: 'sum' },
          { header: 'Action', value: 'ThisItem.Action', flex: 3 },
        ] },
        { id: 'notes', kind: 'text', text: '**Notes.** {Notes}', visible: '!IsBlank(Notes)' },
        { id: 'h3', kind: 'heading', level: 2, text: 'Photos', visible: '!IsBlank(Photos)' },
        { id: 'ph', kind: 'image', source: 'attachment', value: 'Photos', perRow: 3, visible: '!IsBlank(Photos)' },
        { id: 'sig', kind: 'signature', labels: ['Inspected by', 'Quality approval'], showDate: true, keepTogether: true, spaceBefore: 8 },
      ]
      return d
    }
    case 'daily-oee': {
      const d = emptyDoc()
      d.page.orientation = 'landscape'
      d.source = { kind: 'query', table: 'ProductionLogs', filter: 'LogDate = Today()', sort: [{ column: 'Machine' }, { column: 'Shift' }] }
      d.fileName = 'OEE {FormatDate(Today(), "yyyy-MM-dd")}'
      d.metadata = { title: 'Daily production and OEE {FormatDate(Today())}' }
      d.header = { blocks: [], letterhead: 'first', right: 'Production {FormatDate(Today())}' }
      d.footer = { blocks: [], pageNumbers: true, left: 'OEE = availability × performance × quality' }
      const A = 'If(ThisItem.PlannedMinutes > 0, ThisItem.RunMinutes / ThisItem.PlannedMinutes, 0)'
      const P = 'If(ThisItem.RunMinutes * ThisItem.IdealRatePerMinute > 0, ThisItem.TotalCount / (ThisItem.RunMinutes * ThisItem.IdealRatePerMinute), 0)'
      const Q = 'If(ThisItem.TotalCount > 0, ThisItem.GoodCount / ThisItem.TotalCount, 0)'
      const allA = 'If(Sum(Rows, PlannedMinutes) > 0, Sum(Rows, RunMinutes) / Sum(Rows, PlannedMinutes), 0)'
      const allP = 'If(Sum(Rows, RunMinutes * IdealRatePerMinute) > 0, Sum(Rows, TotalCount) / Sum(Rows, RunMinutes * IdealRatePerMinute), 0)'
      const allQ = 'If(Sum(Rows, TotalCount) > 0, Sum(Rows, GoodCount) / Sum(Rows, TotalCount), 0)'
      d.body = [
        { id: 'h', kind: 'heading', level: 1, text: 'Daily production and OEE — {FormatDate(Today(), "d MMMM yyyy")}' },
        { id: 'cols', kind: 'columns', columns: [
          { blocks: [{ id: 'kpi', kind: 'keyValue', boxed: true, columns: 2, items: [
            { label: 'OEE', value: `${allA} * ${allP} * ${allQ}`, format: 'percent' },
            { label: 'Good units', value: 'Sum(Rows, GoodCount)', format: 'integer' },
            { label: 'Availability', value: allA, format: 'percent' },
            { label: 'Performance', value: allP, format: 'percent' },
            { label: 'Quality', value: allQ, format: 'percent' },
            { label: 'Machines', value: 'CountRows(Distinct(Rows, Machine))', format: 'integer' },
          ] }] },
          { width: 80, blocks: [{ id: 'g', kind: 'chart', chartType: 'gauge', title: 'Plant OEE', values: [{ name: 'OEE', value: `100 * ${allA} * ${allP} * ${allQ}` }], min: 0, max: 100, unit: '%', height: 48, bands: [0.6, 0.85] }] },
        ] },
        { id: 'chart', kind: 'chart', chartType: 'bar', title: 'OEE by machine and shift (%)', rows: 'Rows', label: 'ThisItem.Machine & " " & ThisItem.Shift', values: [{ name: 'OEE', value: `Round(100 * ${A} * ${P} * ${Q}, 1)` }], height: 55, unit: '%' },
        { id: 'h2', kind: 'heading', level: 2, text: 'Production log' },
        { id: 'tbl', kind: 'table', rows: 'Rows', groupBy: 'ThisItem.Machine', groupHeader: '{Group} ({Count} shifts)', subtotals: true, totals: true, columns: [
          { header: 'Shift', value: 'ThisItem.Shift', width: 18, total: 'label', totalLabel: 'Total' },
          { header: 'Planned (min)', value: 'ThisItem.PlannedMinutes', format: 'integer', total: 'sum' },
          { header: 'Run (min)', value: 'ThisItem.RunMinutes', format: 'integer', total: 'sum' },
          { header: 'Output', value: 'ThisItem.TotalCount', format: 'integer', total: 'sum' },
          { header: 'Good', value: 'ThisItem.GoodCount', format: 'integer', total: 'sum' },
          { header: 'Availability', value: A, format: 'percent' },
          { header: 'Performance', value: P, format: 'percent' },
          { header: 'Quality', value: Q, format: 'percent' },
          { header: 'OEE', value: `${A} * ${P} * ${Q}`, format: 'percent', total: 'avg' },
        ] },
      ]
      return d
    }
    case 'purchase-request': {
      const d = emptyDoc('PurchaseRequests')
      d.source = { kind: 'record', table: 'PurchaseRequests', related: [{ name: 'Lines', table: 'PurchaseRequestLines', column: 'Request', sort: [{ column: 'createdOn' }] }] }
      d.fileName = 'Purchase request {Number}'
      d.footer = { blocks: [], pageNumbers: true, left: '{Number}' }
      d.body = [
        { id: 'h', kind: 'heading', level: 1, text: 'Purchase request {Number}' },
        { id: 't', kind: 'text', text: '**{Title}**', size: 12 },
        { id: 'kv', kind: 'keyValue', columns: 2, items: [
          { label: 'Requested by', value: 'Requester' }, { label: 'Department', value: 'Department' }, { label: 'Needed by', value: 'NeededBy', format: 'date' }, { label: 'Status', value: 'Status' },
          { label: 'Total', value: 'Sum(Related.Lines, Qty * Rate)', format: 'currency' },
        ] },
        { id: 'just', kind: 'text', text: '**Justification.** {Justification}', visible: '!IsBlank(Justification)' },
        { id: 'tbl', kind: 'table', rows: 'Related.Lines', totals: true, columns: [
          { header: 'Item', value: 'ThisItem.Item', flex: 3, total: 'label', totalLabel: 'Total' },
          { header: 'Qty', value: 'ThisItem.Qty', width: 18, format: 'number', align: 'right' },
          { header: 'Unit', value: 'ThisItem.Unit', width: 16 },
          { header: 'Rate', value: 'ThisItem.Rate', width: 30, format: 'currency' },
          { header: 'Amount', value: 'ThisItem.Qty * ThisItem.Rate', width: 34, format: 'currency', total: 'sum' },
        ] },
        { id: 'ap', kind: 'approvals', title: 'Approval history', emptyText: 'This request has not been sent for approval yet.' },
        { id: 'sig', kind: 'signature', labels: ['Requested by', 'Approved by'], keepTogether: true, spaceBefore: 6 },
      ]
      return d
    }
    case 'delivery-challan': {
      const d = emptyDoc('DeliveryChallans')
      d.source = { kind: 'record', table: 'DeliveryChallans', related: [{ name: 'Lines', table: 'ChallanLines', column: 'Challan', sort: [{ column: 'createdOn' }] }] }
      d.fileName = 'Delivery challan {Number}'
      d.header = { blocks: [], letterhead: 'all' }
      d.footer = { blocks: [], pageNumbers: true, left: 'Delivery challan {Number}' }
      d.body = [
        { id: 'h', kind: 'heading', level: 1, text: 'DELIVERY CHALLAN', align: 'center' },
        { id: 'cols', kind: 'columns', columns: [
          { blocks: [{ id: 'to', kind: 'text', text: '**Consignee**\n{Customer}\n{ShipTo}' }] },
          { blocks: [{ id: 'kv', kind: 'keyValue', columns: 1, items: [
            { label: 'Challan no.', value: 'Number' }, { label: 'Date', value: 'ChallanDate', format: 'date' }, { label: 'Vehicle no.', value: 'VehicleNo' }, { label: 'Transporter', value: 'Transporter' }, { label: 'Reference', value: 'Reference' },
          ] }] },
        ] },
        { id: 'tbl', kind: 'table', rows: 'Related.Lines', style: 'grid', totals: true, columns: [
          { header: 'Description of goods', value: 'ThisItem.Item', flex: 3, total: 'label', totalLabel: 'Total quantity' },
          { header: 'HSN', value: 'ThisItem.HSN', width: 22 },
          { header: 'Qty', value: 'ThisItem.Qty', width: 20, format: 'number', total: 'sum' },
          { header: 'Unit', value: 'ThisItem.Unit', width: 16 },
          { header: 'Remarks', value: 'ThisItem.Remarks', flex: 2 },
        ] },
        { id: 'note', kind: 'text', text: '*Goods sent for the purpose stated. This challan is not a tax invoice.*', size: 8 },
        { id: 'bc', kind: 'barcode', symbology: 'code128', value: 'Number', width: 55, height: 10, align: 'left' },
        { id: 'sig', kind: 'signature', labels: ['Prepared by', 'Received in good condition by'], showDate: true, keepTogether: true, spaceBefore: 6 },
      ]
      return d
    }
    case 'record-sheet': {
      if (!table) throw new Error('Choose the table of the record sheet.')
      const d = emptyDoc(table.name)
      d.fileName = `${table.displayName || table.name} {${ident(table.primaryColumn || 'id')}}`
      d.body = [
        { id: 'h', kind: 'heading', level: 1, text: `${table.displayName || table.name}: {${ident(table.primaryColumn || 'id')}}` },
        { id: 'kv', kind: 'keyValue', columns: 1, labelWidth: 50, items: printable(table).map((c) => ({ label: c.displayName || c.name, value: ident(c.name), ...(formatOf(c.type as string) ? { format: formatOf(c.type as string) } : {}) })) },
      ]
      return d
    }
    case 'table-list': {
      if (!table) throw new Error('Choose the table of the list.')
      const d = emptyDoc()
      d.page.orientation = 'landscape'
      d.source = { kind: 'query', table: table.name, top: 5000 }
      d.fileName = `${table.displayName || table.name} list`
      const cols = printable(table).slice(0, 10)
      d.body = [
        { id: 'h', kind: 'heading', level: 1, text: `${table.displayName || table.name}` },
        { id: 'n', kind: 'text', text: '{CountRows(Rows)} rows, printed {FormatDate(Now(), "dd-MM-yyyy HH:mm")}', size: 8, color: '#64748b' },
        { id: 'tbl', kind: 'table', rows: 'Rows', fontSize: 8, columns: cols.map((c) => ({ header: c.displayName || c.name, value: `ThisItem.${ident(c.name)}`, ...(formatOf(c.type as string) ? { format: formatOf(c.type as string) } : {}) })) },
      ]
      return d
    }
  }
  throw new Error(`There is no built-in template "${key}".`)
}
