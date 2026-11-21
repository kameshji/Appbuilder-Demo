/**
 * Accounts > Documents (P3 package L): the list, the draft editor and the issued view of tax invoices, bills of supply,
 * credit and debit notes, vouchers and purchase invoices. The server computes everything: saving a draft returns the
 * figures it would have if issued now, or the reason it cannot be issued (a STOP case names what the accountant must
 * decide). After issue nothing that affects tax changes; only the IRN, the e-way bill, the payment status and notes are
 * entered, each once or audited. A correction is a credit or debit note.
 */
import { useState } from 'react'
import { ArrowLeft, Ban, FileText, Plus, Printer, Send, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, Field, Panel, TextDialog, useToast } from '../kit'
import { DOC_STATE, accountsApi, downloadUrl, inr, today, type AccountsState, type Doc, type DocInput, type DocType, type Item, type Party } from './api'
import { Loading, Money, SectionTitle, num, sel, td, th } from './bits'
import { useLoad } from './useLoad'

const NOTE_TYPES: DocType[] = ['credit_note', 'debit_note', 'refund_voucher']
const OUTWARD: DocType[] = ['tax_invoice', 'bill_of_supply', 'receipt_voucher']
const taxWord = (k: string | null): string => (k === 'intra' ? 'Intra-State (CGST + SGST or UTGST)' : k === 'inter' ? 'Inter-State (IGST)' : k === 'zero' ? 'Zero-rated' : 'No tax on this document')

function Totals({ doc }: { doc: Doc }) {
  const t = doc.totals
  const rows: [string, number][] = [['Taxable value', t.taxable], ['CGST', t.cgst], [doc.snapshot?.utgst ? 'UTGST' : 'SGST', t.sgst], ['IGST', t.igst], ['Cess', t.cess], ['Round off', t.roundOff]]
  return (
    <table className="ml-auto text-sm" data-testid="doc-totals">
      <tbody>
        {rows.filter(([l, v]) => l === 'Taxable value' || v !== 0).map(([l, v]) => <tr key={l}><td className="px-2 py-0.5 text-muted-foreground">{l}</td><td className="px-2 py-0.5 text-right tabular-nums">{inr(v)}</td></tr>)}
        <tr className="font-semibold"><td className="border-t border-border px-2 py-1">Total</td><td className="border-t border-border px-2 py-1 text-right tabular-nums" data-testid="doc-total">{inr(t.total)}</td></tr>
      </tbody>
    </table>
  )
}

function Lines({ doc }: { doc: Doc }) {
  const purchase = doc.docType === 'purchase_invoice'
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="doc-lines">
        <thead><tr><th className={th}>Description</th><th className={th}>HSN/SAC</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Price</th><th className={`${th} text-right`}>Taxable value</th><th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST/UTGST</th><th className={`${th} text-right`}>IGST</th>{purchase && <th className={th}>ITC</th>}</tr></thead>
        <tbody>{doc.lines.map((l, i) => (
          <tr key={i} className="border-t border-border/60">
            <td className={td}>{l.description}{l.reverseCharge ? ' (reverse charge)' : ''}</td><td className={td}>{l.hsn}</td><td className={num}>{l.quantity} {l.uqc}</td><td className={num}>{l.unitPrice}</td><td className={num}><Money value={l.taxable} /></td>
            <td className={num}>{l.taxed && l.cgst ? `${inr(l.cgst)} (${l.cgstRate}%)` : ''}</td><td className={num}>{l.taxed && l.sgst ? `${inr(l.sgst)} (${l.sgstRate}%)` : ''}</td><td className={num}>{l.taxed && l.igst ? `${inr(l.igst)} (${l.igstRate}%)` : ''}</td>
            {purchase && <td className={td}>{l.itc}</td>}
          </tr>
        ))}</tbody>
      </table>
    </Panel>
  )
}

/* ------------------------------------------------------------------ the draft editor */

type LineIn = DocInput['lines'][number]
const blankLine = (): LineIn => ({ itemId: '', description: '', quantity: '1', unitPrice: '', discountPercent: null, discountAmount: null, itc: null, itcReason: '', reverseCharge: false, accountId: null })

function Editor({ doc, parties, items, onSaved, onIssued, onDeleted }: { doc: Doc; parties: Party[]; items: Item[]; onSaved(d: Doc): void; onIssued(d: Doc): void; onDeleted(): void }) {
  const { fail, toast } = useToast()
  const [inp, setInp] = useState<DocInput>(doc.input)
  const [busy, setBusy] = useState(false)
  const type = doc.docType
  const purchase = type === 'purchase_invoice'
  const note = NOTE_TYPES.includes(type)
  const voucher = type === 'payment_voucher'
  const originals = useLoad(() => (note ? accountsApi.documents(undefined, 'issued') : Promise.resolve({ items: [], total: 0 })), [note])
  const set = (patch: Partial<DocInput>) => setInp({ ...inp, ...patch })
  const setSupply = (patch: Partial<DocInput['supply']>) => setInp({ ...inp, supply: { ...inp.supply, ...patch } })
  const setLine = (i: number, patch: Partial<LineIn>) => set({ lines: inp.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) })
  const who = parties.filter((p) => p.active && (purchase || voucher ? p.role !== 'customer' : p.role !== 'supplier'))
  const save = async (): Promise<Doc | null> => {
    setBusy(true)
    try {
      const d = (await accountsApi.saveDocument(doc.id, inp as unknown as Record<string, unknown>)).document
      onSaved(d)
      return d
    } catch (e) {
      fail(e)
      return null
    } finally {
      setBusy(false)
    }
  }
  const issue = async () => {
    const d = await save()
    if (!d) return
    if (d.problem) { toast(d.problem, 'error'); return }
    setBusy(true)
    try {
      const issued = (await accountsApi.issue(doc.id)).document
      toast(`${issued.title} ${issued.number} issued`, 'success')
      onIssued(issued)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const origOk = (t: DocType) => (type === 'refund_voucher' ? t === 'receipt_voucher' : t === 'tax_invoice' || t === 'bill_of_supply')
  return (
    <div data-testid="doc-editor">
      <Panel className="mb-4 grid gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Date"><Input className="h-8 max-md:h-11" type="date" value={inp.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date" data-testid="doc-date" /></Field>
          <Field label={purchase || voucher ? 'Supplier' : 'Customer'} hint={type === 'tax_invoice' || type === 'bill_of_supply' ? 'Blank: an unregistered buyer without an address.' : undefined}>
            <select className={sel} value={inp.partyId ?? ''} onChange={(e) => set({ partyId: e.target.value || null })} aria-label="Customer or supplier" data-testid="doc-party"><option value="">(none)</option>{who.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
          {note && (
            <Field label={type === 'refund_voucher' ? 'Receipt voucher refunded' : 'Original invoice'}>
              <select className={sel} value={inp.originalId ?? ''} onChange={(e) => set({ originalId: e.target.value || null })} aria-label="Original document" data-testid="doc-original"><option value="">(choose)</option>{(originals.data?.items ?? []).filter((o) => origOk(o.docType) && (!inp.partyId || o.partyId === inp.partyId)).map((o) => <option key={o.id} value={o.id}>{o.number} {o.date} {o.partyName}</option>)}</select>
            </Field>
          )}
          {type === 'credit_note' && (
            <>
              <Field label="Reason"><select className={sel} value={inp.reason} onChange={(e) => set({ reason: e.target.value })} aria-label="Reason" data-testid="doc-reason"><option value="">(choose)</option><option value="return">Goods returned</option><option value="post-sale discount">Post-sale discount</option><option value="deficiency">Goods or services deficient</option><option value="price revision">Price revision</option><option value="other">Other</option></select></Field>
              <Field label="Recipient confirmed the reversal of input tax credit"><select className={sel} value={inp.itcReversalConfirmed ?? ''} onChange={(e) => set({ itcReversalConfirmed: (e.target.value || null) as DocInput['itcReversalConfirmed'] })} aria-label="ITC reversal confirmed" data-testid="doc-itc-reversal"><option value="">(choose)</option><option value="yes">Yes</option><option value="no">No</option><option value="na">Not applicable</option></select></Field>
            </>
          )}
          {purchase && (
            <>
              <Field label="Supplier's invoice number"><Input className="h-8 max-md:h-11" value={inp.supplierInvoiceNo} onChange={(e) => set({ supplierInvoiceNo: e.target.value })} aria-label="Supplier's invoice number" data-testid="doc-supplier-no" /></Field>
              <Field label="Supplier's invoice date"><Input className="h-8 max-md:h-11" type="date" value={inp.supplierInvoiceDate ?? ''} onChange={(e) => set({ supplierInvoiceDate: e.target.value || null })} aria-label="Supplier's invoice date" /></Field>
            </>
          )}
          {voucher && <Field label="Amount paid"><Input className="h-8 text-right max-md:h-11" inputMode="decimal" value={inp.amount ?? ''} onChange={(e) => set({ amount: e.target.value || null })} aria-label="Amount paid" data-testid="doc-amount" /></Field>}
          {(voucher || type === 'receipt_voucher' || type === 'refund_voucher') && <Field label="Money account"><select className={sel} value={inp.moneyAccount} onChange={(e) => set({ moneyAccount: e.target.value as 'bank' | 'cash' })} aria-label="Money account"><option value="bank">Bank</option><option value="cash">Cash</option></select></Field>}
        </div>

        {!voucher && (
          <div className="grid gap-2">
            {inp.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-[2fr_6rem_8rem_6rem_auto]" data-testid={`doc-line-${i}`}>
                <select className={`${sel} col-span-2 md:col-span-1`} value={l.itemId} aria-label={`Item of line ${i + 1}`} data-testid={`doc-line-item-${i}`}
                  onChange={(e) => { const it = items.find((x) => x.id === e.target.value); setLine(i, { itemId: e.target.value, unitPrice: l.unitPrice && l.unitPrice !== '0' ? l.unitPrice : it?.unitPrice ?? l.unitPrice }) }}>
                  <option value="">(item or service)</option>{items.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.hsn})</option>)}
                </select>
                <Input className="h-8 text-right max-md:h-11" inputMode="decimal" placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Quantity of line ${i + 1}`} data-testid={`doc-line-qty-${i}`} />
                <Input className="h-8 text-right max-md:h-11" inputMode="decimal" placeholder={type === 'receipt_voucher' || type === 'refund_voucher' ? 'Amount' : 'Unit price'} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} aria-label={`Unit price of line ${i + 1}`} data-testid={`doc-line-price-${i}`} />
                <Input className="h-8 text-right max-md:h-11" inputMode="decimal" placeholder="Disc. %" value={l.discountPercent ?? ''} onChange={(e) => setLine(i, { discountPercent: e.target.value || null })} aria-label={`Discount percent of line ${i + 1}`} />
                <Button size="icon-sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => set({ lines: inp.lines.filter((_, k) => k !== i) })}><Trash2 /></Button>
                {purchase && (
                  <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs md:col-span-5">
                    <select className={sel} value={l.itc ?? ''} onChange={(e) => setLine(i, { itc: e.target.value || null })} aria-label={`ITC of line ${i + 1}`} data-testid={`doc-line-itc-${i}`}><option value="">ITC: the item's default</option><option value="eligible">ITC eligible</option><option value="ineligible">ITC ineligible</option></select>
                    <Input className="h-8 w-56 max-md:h-11" placeholder="Reason when ineligible" value={l.itcReason} onChange={(e) => setLine(i, { itcReason: e.target.value })} aria-label={`ITC reason of line ${i + 1}`} />
                    <label className="flex items-center gap-1"><input type="checkbox" checked={l.reverseCharge} onChange={(e) => setLine(i, { reverseCharge: e.target.checked })} /> Reverse charge</label>
                  </div>
                )}
              </div>
            ))}
            <div><Button size="sm" variant="outline" onClick={() => set({ lines: [...inp.lines, blankLine()] })} data-testid="doc-add-line"><Plus /> Line</Button></div>
          </div>
        )}

        {OUTWARD.includes(type) && (
          <details className="rounded-lg border border-border p-3 text-sm" data-testid="doc-supply">
            <summary className="cursor-pointer font-medium">Place of supply details</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="Goods move"><select className={sel} value={inp.supply.goodsMove} onChange={(e) => setSupply({ goodsMove: e.target.value as 'yes' | 'no' | 'unknown' })} aria-label="Goods move"><option value="yes">Yes</option><option value="no">No (collected at our premises)</option><option value="unknown">I cannot say</option></select></Field>
              <Field label="Ship-to State code" hint="When the delivery address differs from the customer's."><Input className="h-8 max-md:h-11" value={inp.supply.shipToState} onChange={(e) => setSupply({ shipToState: e.target.value })} aria-label="Ship-to State code" /></Field>
              <Field label="Ship-to country (two letters)" hint="Outside India: an export."><Input className="h-8 max-md:h-11" value={inp.supply.shipToCountry} onChange={(e) => setSupply({ shipToCountry: e.target.value })} aria-label="Ship-to country" data-testid="doc-ship-country" /></Field>
              <Field label="Address of delivery"><Input className="h-8 max-md:h-11" value={inp.supply.shipToAddress} onChange={(e) => setSupply({ shipToAddress: e.target.value })} aria-label="Address of delivery" /></Field>
              <Field label="SEZ or export"><select className={sel} value={inp.supply.zeroRated ?? ''} onChange={(e) => setSupply({ zeroRated: (e.target.value || null) as 'lut' | 'with_payment' | null })} aria-label="SEZ or export"><option value="">(default)</option><option value="lut">Under LUT, without payment of integrated tax</option><option value="with_payment">On payment of integrated tax</option></select></Field>
              <Field label="Installation site State code"><Input className="h-8 max-md:h-11" value={inp.supply.siteState} onChange={(e) => setSupply({ siteState: e.target.value, installedAtSite: !!e.target.value })} aria-label="Installation site State code" /></Field>
            </div>
            <div className="mt-3 grid gap-1.5">
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.billToShipTo} onChange={(e) => setSupply({ billToShipTo: e.target.checked })} /> Delivered to another person on the customer's direction (bill-to / ship-to)</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.exportConditionsConfirmed} onChange={(e) => setSupply({ exportConditionsConfirmed: e.target.checked })} /> I confirm the conditions of export of services are met</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.continuousSupply} onChange={(e) => setSupply({ continuousSupply: e.target.checked })} /> Continuous supply</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.saleOnApproval} onChange={(e) => setSupply({ saleOnApproval: e.target.checked })} /> Goods sent on approval</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.onBoardConveyance} onChange={(e) => setSupply({ onBoardConveyance: e.target.checked })} /> Supplied on board a conveyance</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={inp.supply.importOrBonded} onChange={(e) => setSupply({ importOrBonded: e.target.checked })} /> Imported goods or a bonded warehouse</label>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[10rem_1fr]">
              <Field label="Manual place of supply (State code)"><Input className="h-8 max-md:h-11" value={inp.supply.manualState} onChange={(e) => setSupply({ manualState: e.target.value })} aria-label="Manual place of supply" /></Field>
              <Field label="Reason for the manual place of supply" hint="Only when an Accounts administrator allowed it; recorded in the audit log."><Input className="h-8 max-md:h-11" value={inp.supply.manualReason} onChange={(e) => setSupply({ manualReason: e.target.value })} aria-label="Reason for the manual place of supply" /></Field>
            </div>
          </details>
        )}
        {(type === 'tax_invoice' || type === 'bill_of_supply') && (
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={inp.taxInclusive} onChange={(e) => set({ taxInclusive: e.target.checked })} data-testid="doc-inclusive" /> Prices include tax</label>
            <label className="flex items-center gap-2">Document discount <Input className="h-8 w-28 text-right max-md:h-11" inputMode="decimal" value={inp.documentDiscount ?? ''} onChange={(e) => set({ documentDiscount: e.target.value || null })} aria-label="Document discount" /></label>
            <label className="flex items-center gap-2">Freight and other charges <Input className="h-8 w-28 text-right max-md:h-11" inputMode="decimal" value={inp.charges[0]?.amount ?? ''} onChange={(e) => set({ charges: e.target.value ? [{ description: 'Freight and other charges', amount: e.target.value, line: null }] : [] })} aria-label="Freight and other charges" /></label>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inp.rateDateConfirmed} onChange={(e) => set({ rateDateConfirmed: e.target.checked })} /> I checked the rate date (asked only near a rate change)</label>
        <Field label="Internal notes"><Input className="h-8 max-md:h-11" value={inp.notes} onChange={(e) => set({ notes: e.target.value })} aria-label="Internal notes" /></Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save().then((d) => { if (d) toast('Draft saved', 'success') })} data-testid="doc-save">Save draft</Button>
          <Button size="sm" disabled={busy} onClick={() => void issue()} data-testid="doc-issue"><Send /> Issue</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => accountsApi.deleteDocument(doc.id).then(onDeleted).catch(fail)} data-testid="doc-delete"><Trash2 /> Delete draft</Button>
        </div>
      </Panel>
      {doc.problem ? (
        <Panel className="border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert" data-testid="doc-problem"><strong>This draft cannot be issued yet.</strong> {doc.problem}</Panel>
      ) : (
        <div className="grid gap-3" data-testid="doc-preview">
          <p className="text-sm text-muted-foreground">If issued now: {taxWord(doc.taxKind)}{doc.snapshot?.placeOfSupplyName ? `, place of supply ${doc.snapshot.placeOfSupplyName}` : ''}. The number is given at issue.</p>
          {doc.lines.length > 0 && <Lines doc={doc} />}
          <Totals doc={doc} />
          {doc.snapshot?.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the issued view */

function Issued({ doc, canPost, printable, onChanged, onNote }: { doc: Doc; canPost: boolean; printable: boolean; onChanged(d: Doc): void; onNote(type: DocType): void }) {
  const { fail, toast } = useToast()
  const [cancel, setCancel] = useState(false)
  const [rec, setRec] = useState({ irn: '', irnAckNo: '', irnAckDate: '', ewayNo: doc.ewayNo ?? '', ewayDate: doc.ewayDate ?? '', vehicleNo: doc.vehicleNo ?? '', paymentStatus: doc.paymentStatus, notes: doc.notes })
  const record = (b: Record<string, unknown>) => accountsApi.record(doc.id, b).then((r) => { toast('Recorded', 'success'); onChanged(r.document) }).catch(fail)
  const s = doc.snapshot
  return (
    <div className="grid gap-4" data-testid="doc-issued">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={doc.state === 'issued' ? 'default' : 'secondary'} data-testid="doc-state">{DOC_STATE[doc.state]}</Badge>
        <span className="text-sm text-muted-foreground">{doc.date} · {doc.partyName || 'Unregistered buyer'} · {taxWord(doc.taxKind)}{s?.placeOfSupplyName ? ` · place of supply ${s.placeOfSupplyName}` : ''}{s?.original ? ` · against ${s.original.number}` : ''}</span>
        <span className="flex-1" />
        {printable && <Button size="sm" variant="outline" asChild><a href={downloadUrl(`/accounts/documents/${doc.id}/pdf`)} target="_blank" rel="noreferrer" data-testid="doc-pdf"><Printer /> Open PDF</a></Button>}
        {canPost && doc.state === 'issued' && (doc.docType === 'tax_invoice' || doc.docType === 'bill_of_supply') && <Button size="sm" variant="outline" onClick={() => onNote('credit_note')} data-testid="doc-credit-note">Credit note</Button>}
        {canPost && doc.state === 'issued' && (doc.docType === 'tax_invoice' || doc.docType === 'bill_of_supply') && <Button size="sm" variant="outline" onClick={() => onNote('debit_note')}>Debit note</Button>}
        {canPost && doc.state === 'issued' && <Button size="sm" variant="ghost" onClick={() => setCancel(true)} data-testid="doc-cancel"><Ban /> Cancel</Button>}
      </div>
      {doc.state === 'cancelled' && <Panel className="p-3 text-sm">Cancelled: {doc.cancelReason}. The number stays used; its journal was reversed.</Panel>}
      <p className="text-xs text-muted-foreground">An issued document cannot be edited. Correct it with a credit note or a debit note.</p>
      {s?.irnRequired && !doc.irn && <Panel className="border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="doc-irn-required">IRN required: get the IRN, the acknowledgement and the signed QR code from the invoice registration portal or your e-invoice tool and enter them below. Appbuilder does not create them.</Panel>}
      {s?.ewayRequired && !doc.ewayNo && <Panel className="border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="doc-eway-required">E-way bill: the consignment value is {inr(s.consignmentValue)}, above the value in the reference data. Enter the e-way bill number and date from the e-way bill portal. Appbuilder does not create it.</Panel>}
      {doc.lines.length > 0 && <Lines doc={doc} />}
      <Totals doc={doc} />
      {canPost && doc.state === 'issued' && (
        <Panel className="grid gap-3 p-4" data-testid="doc-record">
          <div className="text-sm font-semibold">Recorded after issue</div>
          {doc.irn ? <p className="break-all text-sm">IRN {doc.irn}, acknowledgement {doc.irnAckNo} of {doc.irnAckDate}</p> : (
            <div className="grid gap-2 md:grid-cols-[2fr_1fr_10rem_auto]">
              <Input className="h-8 max-md:h-11" placeholder="IRN (64 characters)" value={rec.irn} onChange={(e) => setRec({ ...rec, irn: e.target.value })} aria-label="IRN" data-testid="doc-irn" />
              <Input className="h-8 max-md:h-11" placeholder="Acknowledgement number" value={rec.irnAckNo} onChange={(e) => setRec({ ...rec, irnAckNo: e.target.value })} aria-label="Acknowledgement number" />
              <Input className="h-8 max-md:h-11" type="date" value={rec.irnAckDate} onChange={(e) => setRec({ ...rec, irnAckDate: e.target.value })} aria-label="Acknowledgement date" />
              <Button size="sm" variant="outline" disabled={!rec.irn} onClick={() => void record({ irn: rec.irn, irnAckNo: rec.irnAckNo, irnAckDate: rec.irnAckDate })}>Record IRN</Button>
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-[1fr_10rem_1fr_auto]">
            <Input className="h-8 max-md:h-11" placeholder="E-way bill number (12 digits)" value={rec.ewayNo} onChange={(e) => setRec({ ...rec, ewayNo: e.target.value })} aria-label="E-way bill number" data-testid="doc-eway" />
            <Input className="h-8 max-md:h-11" type="date" value={rec.ewayDate} onChange={(e) => setRec({ ...rec, ewayDate: e.target.value })} aria-label="E-way bill date" />
            <Input className="h-8 max-md:h-11" placeholder="Vehicle number" value={rec.vehicleNo} onChange={(e) => setRec({ ...rec, vehicleNo: e.target.value })} aria-label="Vehicle number" />
            <Button size="sm" variant="outline" onClick={() => void record({ ewayNo: rec.ewayNo, ewayDate: rec.ewayDate, vehicleNo: rec.vehicleNo })}>Record e-way bill</Button>
          </div>
          <div className="grid gap-2 md:grid-cols-[12rem_1fr_auto]">
            <select className={sel} value={rec.paymentStatus} onChange={(e) => setRec({ ...rec, paymentStatus: e.target.value })} aria-label="Payment status"><option value="">Payment: not recorded</option><option value="unpaid">Unpaid</option><option value="part-paid">Part paid</option><option value="paid">Paid</option></select>
            <Input className="h-8 max-md:h-11" placeholder="Internal notes" value={rec.notes} onChange={(e) => setRec({ ...rec, notes: e.target.value })} aria-label="Internal notes" />
            <Button size="sm" variant="outline" onClick={() => void record({ paymentStatus: rec.paymentStatus, notes: rec.notes })}>Record</Button>
          </div>
        </Panel>
      )}
      <TextDialog open={cancel} onOpenChange={setCancel} title={`Cancel ${doc.number}`} description="Only possible without an IRN, a payment or a later note, and in an open period. The number stays used and the journal is reversed today." label="Reason" confirmLabel="Cancel the document"
        onSubmit={async (reason) => { onChanged((await accountsApi.cancel(doc.id, reason)).document) }} />
    </div>
  )
}

/* ------------------------------------------------------------------ the list and the page */

export function Documents({ state }: { state: AccountsState }) {
  const canPost = state.level !== 'view'
  const { fail } = useToast()
  const [type, setType] = useState('')
  const [open, setOpen] = useState<Doc | null>(null)
  const list = useLoad(() => accountsApi.documents(type || undefined), [type])
  const parties = useLoad(accountsApi.parties)
  const items = useLoad(accountsApi.items)
  const types = state.docTypes ?? []
  const [newType, setNewType] = useState<DocType>('tax_invoice')
  const create = (t: DocType, extra: Record<string, unknown> = {}) => accountsApi.createDocument({ docType: t, date: today(), lines: t === 'payment_voucher' ? [] : [blankLine()], ...extra }).then((r) => { setOpen(r.document); list.reload() }).catch(fail)
  const show = (id: string) => accountsApi.document(id).then((r) => setOpen(r.document)).catch(fail)
  if (open) {
    return (
      <div data-testid="accounts-document">
        <SectionTitle><button type="button" className="mr-2 inline-flex items-center gap-1 text-sm font-normal text-muted-foreground hover:text-foreground" onClick={() => { setOpen(null); list.reload() }} data-testid="doc-back"><ArrowLeft className="size-4" /> Documents</button>{open.title} {open.number ?? '(draft)'}</SectionTitle>
        {open.state === 'draft'
          ? (canPost && parties.data && items.data
              ? <Editor key={open.id} doc={open} parties={parties.data.items} items={items.data.items} onSaved={setOpen} onIssued={setOpen} onDeleted={() => { setOpen(null); list.reload() }} />
              : <Loading error={canPost ? parties.error || items.error : 'A draft can be opened by people who may post.'} />)
          : <Issued key={`${open.id}-${open.state}`} doc={open} canPost={canPost} printable={types.find((t) => t.type === open.docType)?.printable === true} onChanged={setOpen} onNote={(t) => void create(t, { originalId: open.id, partyId: open.partyId })} />}
      </div>
    )
  }
  return (
    <div data-testid="accounts-documents">
      <SectionTitle actions={canPost && (
        <>
          <select className={sel} value={newType} onChange={(e) => setNewType(e.target.value as DocType)} aria-label="Kind of new document" data-testid="doc-new-type">{types.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}</select>
          <Button size="sm" onClick={() => void create(newType)} data-testid="doc-new"><Plus /> New</Button>
        </>
      )}>Documents</SectionTitle>
      <div className="mb-3"><select className={sel} value={type} onChange={(e) => setType(e.target.value)} aria-label="Show" data-testid="doc-filter"><option value="">All documents</option>{types.map((t) => <option key={t.type} value={t.type}>{t.title}</option>)}</select></div>
      {!list.data ? <Loading error={list.error} /> : list.data.items.length === 0 ? <Empty icon={FileText} title="No documents yet" description="Create a draft, check the figures the server computes, then issue it. The number is given at issue." /> : (
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Number</th><th className={th}>Kind</th><th className={th}>Date</th><th className={th}>Customer or supplier</th><th className={th}>State</th><th className={`${th} text-right`}>Total</th></tr></thead>
            <tbody>{list.data.items.map((d) => (
              <tr key={d.id} className="cursor-pointer border-t border-border/60 hover:bg-muted/40" onClick={() => void show(d.id)} data-testid="doc-row" data-number={d.number ?? ''}>
                <td className={td}>{d.number ?? '(draft)'}</td><td className={td}>{d.title}</td><td className={td}>{d.date}</td><td className={td}>{d.partyName}</td><td className={td}>{DOC_STATE[d.state]}</td><td className={num}>{d.state === 'draft' ? '' : <Money value={d.totals.total} />}</td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}
