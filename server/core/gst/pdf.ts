/**
 * The printed form of a tax invoice, a bill of supply and a credit or debit note, with the particulars of
 * docs/plan/gst-spec-draft.md G7.1 (rule 46), G7.3 (rule 49) and G7.4 (rule 53(1A)): built as resolved blocks and laid
 * out and written by the existing print engine (server/core/print/layout.ts, pdf.ts; bundled fonts, no browser).
 *
 * Everything printed comes from the issued document's rows and its frozen snapshot, so a reprint years later shows what
 * was issued. Widths in the blocks are millimetres (the layout engine's unit). Copies (G7.2a): goods ORIGINAL / DUPLICATE / TRIPLICATE, services ORIGINAL / DUPLICATE; one unmarked copy
 * when an IRN was entered. These pages go to customers: they carry no statement about the software or its review state.
 */
import { MM, type RichParagraph } from '../../../src/platform/print.ts'
import { layoutDocument, PAGE_COUNT, PAGE_NUMBER, type Page, type RBlock, type RTableRow } from '../print/layout.ts'
import { pdfBuffer } from '../print/pdf.ts'
import { groupIN, rupeesIN } from './money.ts'
import type { DocView } from './documents.ts'

export const PRINTABLE = ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note'] as const
/** rule 5(1)(f) (G6.5) */
export const COMPOSITION_HEADER = 'Composition taxable person, not eligible to collect tax on supplies'
/** rule 46 proviso (G7.2) */
export const ENDORSEMENT_LUT = 'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX'
export const ENDORSEMENT_PAID = 'SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX'

/** the reason of a credit note as printed for the customer (the stored codes are the editor's choices) */
const CREDIT_REASON: Record<string, string> = { return: 'goods returned', 'post-sale discount': 'post-sale discount', deficiency: 'goods or services deficient', 'price revision': 'price revision', other: 'other' }

const para = (t: string, o: { bold?: boolean } = {}): RichParagraph => ({ runs: [{ text: t, ...(o.bold ? { bold: true } : {}) }] })
const textBlock = (lines: (string | [string, true])[], extra: Partial<Extract<RBlock, { k: 'text' }>> = {}): RBlock =>
  ({ k: 'text', align: 'left', paras: lines.filter((l) => (Array.isArray(l) ? l[0] : l)).map((l) => (Array.isArray(l) ? para(l[0], { bold: true }) : para(l))), ...extra })
const dmy = (d: string | null): string => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '')
const stateLine = (name: string, code: string): string => (name || code ? `State: ${name}${code ? ` (code ${code})` : ''}` : '')

/** the copies a document prints (G7.2a) */
export function copyMarks(doc: DocView): string[] {
  if (doc.irn) return ['']
  if (doc.docType === 'credit_note' || doc.docType === 'debit_note') return ['']
  return doc.lines.some((l) => l.kind === 'goods') ? ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER'] : ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR SUPPLIER']
}

/** the blocks of one copy (exported for the tests: the particulars are checked on these, not on PDF bytes) */
export function documentBlocks(doc: DocView, otherCountryCode: string): RBlock[] {
  const snap = doc.snapshot!
  const b = snap.business
  const p = snap.party
  const bos = doc.docType === 'bill_of_supply'
  const intra = doc.taxKind === 'intra'
  const inter = doc.taxKind === 'inter'
  const cess = doc.totals.cess > 0
  const posCode = doc.placeOfSupply === 'OTHER' ? otherCountryCode : doc.placeOfSupply ?? ''
  const blocks: RBlock[] = []
  if (doc.state === 'cancelled') blocks.push({ k: 'heading', text: 'CANCELLED', level: 2, align: 'center', color: '#b91c1c' })
  // G6.5: the composition header at the top of a bill of supply
  if (bos && snap.composition) blocks.push(textBlock([[COMPOSITION_HEADER, true]], { align: 'center', spaceAfter: 6 }))
  // (a) supplier; (b) number; (c) date; (n) place of supply; (p) reverse charge; (r) IRN; e-way bill
  const kv: { label: string; value: string }[] = [
    { label: bos ? 'Bill of supply no.' : doc.docType === 'tax_invoice' ? 'Invoice no.' : `${doc.title} no.`, value: doc.number ?? '' },
    { label: 'Date', value: dmy(doc.date) },
  ]
  if (snap.original) kv.push({ label: snap.original.docType === 'bill_of_supply' ? 'Against bill of supply' : 'Against invoice', value: `${snap.original.number} dated ${dmy(snap.original.date)}` })
  if (!bos || doc.placeOfSupply) kv.push({ label: 'Place of supply', value: `${snap.placeOfSupplyName}${posCode ? ` (${posCode})` : ''}` })
  if (!bos) kv.push({ label: 'Tax payable on reverse charge', value: 'No' })
  if (doc.irn) kv.push({ label: 'IRN', value: doc.irn }, { label: 'Ack. no. and date', value: `${doc.irnAckNo ?? ''}  ${dmy(doc.irnAckDate)}` })
  if (doc.ewayNo) kv.push({ label: 'E-way bill no. and date', value: `${doc.ewayNo}  ${dmy(doc.ewayDate)}${doc.ewayValidUntil ? `, valid until ${dmy(doc.ewayValidUntil)}` : ''}` })
  if (doc.vehicleNo) kv.push({ label: 'Vehicle no.', value: doc.vehicleNo })
  blocks.push({
    k: 'columns', gap: 6, spaceAfter: 8, cols: [
      { blocks: [textBlock([[b.legalName, true], b.tradeName && b.tradeName !== b.legalName ? b.tradeName : '', b.address, b.gstin ? `GSTIN: ${b.gstin}` : '', stateLine(b.stateName, b.stateCode), [b.phone, b.email].filter(Boolean).join('  ')])] },
      { blocks: [{ k: 'kv', items: kv, columns: 1, labelWidth: 40, boxed: false }] },
    ],
  })
  // (d), (e), (f) recipient; (o) delivery address
  const billTo = p
    ? [['Bill to', true] as [string, true], p.name, p.address, p.gstin ? `GSTIN/UIN: ${p.gstin}` : 'Unregistered', p.country && p.country !== 'IN' ? `Country: ${p.country}` : stateLine(p.stateName, p.stateCode)]
    : [['Bill to', true] as [string, true], 'Unregistered recipient']
  const ship = snap.shipTo
  blocks.push({
    k: 'columns', gap: 6, spaceAfter: 8, cols: [
      { blocks: [textBlock(billTo)] },
      { blocks: ship ? [textBlock([['Ship to (address of delivery)', true], ship.address, ship.country && ship.country !== 'IN' ? `Country of destination: ${ship.country}` : stateLine(ship.stateName, ship.stateCode)])] : [{ k: 'spacer', h: 1 }] },
    ],
  })
  // G7.2: the export / SEZ endorsement
  if (snap.zeroRated) blocks.push(textBlock([[snap.zeroRated === 'lut' ? ENDORSEMENT_LUT : ENDORSEMENT_PAID, true], snap.zeroRated === 'lut' && snap.lutReference ? `LUT reference: ${snap.lutReference}` : ''], { spaceAfter: 6, size: 8 }))

  // (g) HSN/SAC; (h) description; (i) quantity and unit; (j) total value; (k) taxable value; (l) rates; (m) amounts
  type Col = { header: string; width?: number; flex?: number; align: 'left' | 'center' | 'right' }
  const cols: Col[] = [{ header: '#', width: 5, align: 'right' }, { header: 'Description', flex: 3, align: 'left' }, { header: 'HSN/SAC', width: 15, align: 'left' }, { header: 'Qty', width: 10, align: 'right' }, { header: 'Unit', width: 9, align: 'left' }, { header: 'Price', width: 15, align: 'right' }, { header: 'Disc.', width: 13, align: 'right' }]
  // G6.7: a bill of supply shows no tax columns and no rate
  if (bos) cols.push({ header: 'Value', width: 24, align: 'right' })
  else {
    cols.push({ header: 'Taxable value', width: 18, align: 'right' })
    if (intra) cols.push({ header: 'CGST %', width: 9, align: 'right' }, { header: 'CGST', width: 14, align: 'right' }, { header: snap.utgst ? 'UTGST %' : 'SGST %', width: 10, align: 'right' }, { header: snap.utgst ? 'UTGST' : 'SGST', width: 14, align: 'right' })
    else cols.push({ header: 'IGST %', width: 10, align: 'right' }, { header: 'IGST', width: 17, align: 'right' })
    if (cess) cols.push({ header: 'Cess', width: 12, align: 'right' })
    cols.push({ header: 'Total', width: 18, align: 'right' })
  }
  const rows: RTableRow[] = doc.lines.map((l, i) => {
    const cells = [String(i + 1), l.description, l.hsn, l.quantity, l.uqc, groupIN(l.unitPrice), l.discount ? rupeesIN(l.discount) : '']
    cells.push(rupeesIN(l.taxable))
    if (!bos) {
      if (intra) cells.push(l.taxed ? l.cgstRate : '', rupeesIN(l.cgst), l.taxed ? l.sgstRate : '', rupeesIN(l.sgst))
      else cells.push(l.taxed && inter ? l.igstRate : '0', rupeesIN(l.igst))
      if (cess) cells.push(rupeesIN(l.cess))
      cells.push(rupeesIN(l.taxable + l.cgst + l.sgst + l.igst + l.cess))
    }
    return { kind: 'row', cells }
  })
  blocks.push({ k: 'table', columns: cols, rows, repeatHeader: true, style: 'grid', fontSize: 7.5, avoidRowBreak: true, emptyText: '', spaceAfter: 6 })

  const t = doc.totals
  const totals: { label: string; value: string }[] = [{ label: bos ? 'Value' : 'Taxable value', value: rupeesIN(t.taxable) }]
  if (!bos) {
    if (intra) totals.push({ label: 'CGST', value: rupeesIN(t.cgst) }, { label: snap.utgst ? 'UTGST' : 'SGST', value: rupeesIN(t.sgst) })
    else totals.push({ label: 'IGST', value: rupeesIN(t.igst) })
    if (cess) totals.push({ label: 'Cess', value: rupeesIN(t.cess) })
  }
  if (t.roundOff) totals.push({ label: 'Round off', value: rupeesIN(t.roundOff) })
  totals.push({ label: doc.docType === 'credit_note' ? 'Total credited (INR)' : doc.docType === 'debit_note' ? 'Total debited (INR)' : 'Total (INR)', value: rupeesIN(t.total) })
  const left: RBlock[] = []
  if (snap.charges.length) left.push(textBlock([`The values include: ${snap.charges.map((c) => `${c.description} ${rupeesIN(c.amount)}`).join('; ')}.`], { size: 8 }))
  if (snap.taxInclusive && !bos) left.push(textBlock(['Prices were quoted inclusive of tax.'], { size: 8 }))
  if (doc.docType === 'credit_note' && doc.reason) left.push(textBlock([`Reason: ${CREDIT_REASON[doc.reason] ?? doc.reason}`], { size: 8 }))
  if (b.footer) left.push(textBlock(b.footer.split(/\r?\n/), { size: 8 }))
  // (r) the QR code received from the invoice registration portal, when its text was entered
  if (doc.irnQr && doc.irnQr.length <= 900) left.push({ k: 'barcode', symbology: 'qr', text: doc.irnQr, width: 34, height: 34, showText: false, align: 'left' })
  blocks.push({ k: 'columns', gap: 6, keepTogether: true, cols: [{ blocks: left.length ? left : [{ k: 'spacer', h: 1 }] }, { width: 72, blocks: [{ k: 'kv', items: totals, columns: 1, labelWidth: 38, boxed: false }] }] })
  // (q) signature
  blocks.push({ k: 'signature', labels: [`For ${b.legalName}: authorised signatory`], showDate: false, spaceBefore: 18, keepTogether: true })
  return blocks
}

export async function documentPdf(doc: DocView, otherCountryCode: string): Promise<Buffer> {
  const pageW = 210 * MM
  const pageH = 297 * MM
  const margins = { top: 12 * MM, right: 12 * MM, bottom: 12 * MM, left: 12 * MM }
  const style = { fontSize: 9, color: '#111827', accent: '#374151', headingColor: '#111827', tableStyle: 'grid' as const, lineHeight: 1.3 }
  const title = doc.title.toUpperCase()
  const pagesOf = (mark: string, withQr: boolean): Page[] => {
    const body = documentBlocks(withQr ? doc : { ...doc, irnQr: null }, otherCountryCode)
    return layoutDocument({
      pageW, pageH, margins, style, body, images: new Map(), maxPages: 200,
      header: () => [{ k: 'columns', gap: 4, cols: [{ blocks: [{ k: 'heading', text: title, level: 2, align: 'left' }] }, { blocks: [{ k: 'text', align: 'right', size: 8, paras: [para(mark)] }] }] }, { k: 'line', thickness: 0.7, color: '#374151', dashed: false }],
      footer: () => [{ k: 'text', align: 'right', size: 7, paras: [para(`${doc.number ?? ''}   Page ${PAGE_NUMBER} of ${PAGE_COUNT}`)] }],
    })
  }
  const pages: Page[] = []
  for (const mark of copyMarks(doc)) {
    try {
      pages.push(...pagesOf(mark, true))
    } catch (e) {
      // a QR text the encoder cannot hold must not stop the document: print it without the code
      if (!doc.irnQr) throw e
      pages.push(...pagesOf(mark, false))
    }
  }
  return pdfBuffer({ pageW, pageH, pages, images: new Map(), meta: { title: `${doc.title} ${doc.number ?? ''}`, author: doc.snapshot!.business.legalName, subject: doc.partyName, createdOn: new Date(doc.issuedOn ?? `${doc.date}T00:00:00Z`) } })
}
