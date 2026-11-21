/**
 * Accounts > Settings, Reference data, Customers and suppliers, Items (P3 package L). Settings shows, at the top and
 * always, that the GST calculation rules are a draft not yet reviewed by a practising accountant. Reference data
 * (States, rates, values, units, reverse charge categories) is dated and carries its source and who approved it; the
 * product ships it empty and an Accounts administrator fills it.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Panel, Segmented, useToast } from '../kit'
import { accountsApi, type AccountsState, type Business, type Level } from './api'
import { CrudTable, Loading, SectionTitle, sel, type FieldSpec } from './bits'
import { useLoad } from './useLoad'

export function DraftNotice({ text }: { text: string }) {
  return (
    <Panel className="mb-4 flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4" data-testid="accounts-notice">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
      <p className="min-w-0 text-sm">{text}</p>
    </Panel>
  )
}

const REG_TYPES = [
  { value: 'regular', label: 'Regular' }, { value: 'composition', label: 'Composition' }, { value: 'composition-services', label: 'Composition (services)' }, { value: 'unregistered', label: 'Unregistered' },
  { value: 'sez_unit', label: 'SEZ unit (no documents issued)' }, { value: 'sez_developer', label: 'SEZ developer (no documents issued)' }, { value: 'casual', label: 'Casual taxable person (no documents issued)' },
  { value: 'non_resident', label: 'Non-resident taxable person (no documents issued)' }, { value: 'isd', label: 'Input service distributor (no documents issued)' },
]
const BLANK: Business = {
  gstin: '', legalName: '', tradeName: '', address: '', stateCode: '', regType: 'regular', effectiveFrom: null, pan: '', phone: '', email: '', turnovers: {}, luts: [], composition: null,
  settings: { taxMode: 'line', roundOff: true, manualPlaceOfSupply: false }, footer: '',
}
/** "2025-26=4500000, 2024-25=3900000" <-> { fy: rupees } */
const pairsToText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ')
const textToPairs = (t: string) => Object.fromEntries(t.split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2 && x[0]))

export function Settings({ state, reload }: { state: AccountsState; reload(): void }) {
  const admin = state.level === 'admin'
  const { fail, toast } = useToast()
  const [b, setB] = useState<Business>(state.business ?? BLANK)
  const [turn, setTurn] = useState(pairsToText(b.turnovers))
  const [luts, setLuts] = useState(b.luts.map((l) => `${l.fy}=${l.reference}`).join(', '))
  const [compFrom, setCompFrom] = useState(b.composition?.from ?? '')
  const [compCat, setCompCat] = useState(b.composition?.category ?? 'manufacturer')
  const access = useLoad(() => (admin ? accountsApi.access() : Promise.resolve({ roles: [] })), [admin])
  const run = (fn: () => Promise<unknown>, done: string) => fn().then(() => { toast(done, 'success'); reload(); access.reload() }).catch(fail)
  const composition = b.regType === 'composition' || b.regType === 'composition-services'
  const save = () => run(() => accountsApi.saveBusiness({
    ...b, turnovers: textToPairs(turn), luts: Object.entries(textToPairs(luts)).map(([fy, reference]) => ({ fy, reference: String(reference), filedOn: null })),
    composition: composition ? { category: compCat, from: compFrom } : null,
  }), 'Business registration saved')
  const s = state.setup
  const text = (k: 'gstin' | 'legalName' | 'tradeName' | 'stateCode' | 'pan' | 'phone' | 'email', label: string, hint?: string) => (
    <Field label={label} hint={hint}><Input className="h-8 max-md:h-11" value={b[k]} disabled={!admin} onChange={(e) => setB({ ...b, [k]: e.target.value })} aria-label={label} data-testid={`business-${k}`} /></Field>
  )
  return (
    <div data-testid="accounts-settings">
      <DraftNotice text={state.notice} />
      <SectionTitle>Set up</SectionTitle>
      <Panel className="mb-6 grid gap-2 p-4 text-sm" data-testid="accounts-setup">
        <p>Business registration: <strong>{s?.business ? 'entered' : 'missing'}</strong>. Chart of accounts and number series: <strong>{s?.chart && s?.series ? 'ready' : 'not set up'}</strong>. Financial years: <strong>{s?.years ?? 0}</strong>. Reference data: <strong>{s?.states ?? 0}</strong> States, <strong>{s?.rates ?? 0}</strong> rates, <strong>{s?.thresholds ?? 0}</strong> values.</p>
        <p className="text-xs text-muted-foreground">Appbuilder ships no GST rates, State codes or thresholds. Enter them in Reference data from a source your accountant approved. "Load example data" adds the State list and the values named in the draft specification, each marked "not approved"; it adds no rates.</p>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void run(accountsApi.setup, 'Books set up')} data-testid="accounts-setup-books">Set up the books</Button>
            <Button size="sm" variant="outline" onClick={() => void run(accountsApi.examples, 'Example data loaded (not approved)')} data-testid="accounts-load-examples">Load example data (not approved)</Button>
          </div>
        )}
      </Panel>

      <SectionTitle>Business registration</SectionTitle>
      <Panel className="mb-6 grid gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          {text('legalName', 'Legal name')}
          {text('tradeName', 'Trade name')}
          <Field label="Registration type">
            <select className={sel} value={b.regType} disabled={!admin} onChange={(e) => setB({ ...b, regType: e.target.value })} aria-label="Registration type" data-testid="business-regType">{REG_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </Field>
          {text('gstin', 'GSTIN', 'Only the length, the characters and the State code are checked.')}
          {text('stateCode', 'State code', 'Two digits, as in Reference data > States.')}
          {text('pan', 'PAN')}
          {text('phone', 'Phone')}
          {text('email', 'Email')}
          <Field label="Effective date of registration"><Input className="h-8 max-md:h-11" type="date" value={b.effectiveFrom ?? ''} disabled={!admin} onChange={(e) => setB({ ...b, effectiveFrom: e.target.value || null })} aria-label="Effective date of registration" /></Field>
        </div>
        <Field label="Principal place of business (address)"><Input className="h-8 max-md:h-11" value={b.address} disabled={!admin} onChange={(e) => setB({ ...b, address: e.target.value })} aria-label="Address" data-testid="business-address" /></Field>
        {composition && (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Composition category"><select className={sel} value={compCat} disabled={!admin} onChange={(e) => setCompCat(e.target.value)} aria-label="Composition category"><option value="manufacturer">Manufacturer</option><option value="restaurant">Restaurant service</option><option value="other">Other supplier</option><option value="services">Services (section 10(2A))</option></select></Field>
            <Field label="Composition option in effect from"><Input className="h-8 max-md:h-11" type="date" value={compFrom} disabled={!admin} onChange={(e) => setCompFrom(e.target.value)} aria-label="Composition option in effect from" /></Field>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Aggregate turnover per financial year (rupees)" hint="Written 2025-26=4500000, 2024-25=3900000. Used for the HSN digits and the e-invoice class."><Input className="h-8 max-md:h-11" value={turn} disabled={!admin} onChange={(e) => setTurn(e.target.value)} aria-label="Aggregate turnover per financial year" /></Field>
          <Field label="LUT reference per financial year" hint="Written 2026-27=AD230426000123X. Needed for exports and SEZ supplies without payment of integrated tax."><Input className="h-8 max-md:h-11" value={luts} disabled={!admin} onChange={(e) => setLuts(e.target.value)} aria-label="LUT reference per financial year" /></Field>
        </div>
        <Field label="Text at the foot of printed documents" hint="Bank details, terms."><Input className="h-8 max-md:h-11" value={b.footer} disabled={!admin} onChange={(e) => setB({ ...b, footer: e.target.value })} aria-label="Footer text" /></Field>
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="w-56">Tax is computed</span><Segmented label="Tax is computed" disabled={!admin} value={b.settings.taxMode} onChange={(v) => setB({ ...b, settings: { ...b.settings, taxMode: v } })} options={[{ value: 'line', label: 'Per line' }, { value: 'document', label: 'Per rate per document' }]} /></div>
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!admin} checked={b.settings.roundOff} onChange={(e) => setB({ ...b, settings: { ...b.settings, roundOff: e.target.checked } })} /> Round the payable total to the rupee, with a round-off line</label>
          <label className="flex items-center gap-2"><input type="checkbox" disabled={!admin} checked={b.settings.manualPlaceOfSupply} onChange={(e) => setB({ ...b, settings: { ...b.settings, manualPlaceOfSupply: e.target.checked } })} /> Allow a manual place of supply with a reason (each use is in the audit log)</label>
        </div>
        {admin && <div><Button size="sm" onClick={() => void save()} data-testid="business-save">Save registration</Button></div>}
      </Panel>

      {admin && (
        <>
          <SectionTitle actions={<Button size="sm" variant="outline" onClick={() => void run(accountsApi.accountantRole, 'Accountant role ready')} data-testid="accounts-accountant-role">Create the Accountant role</Button>}>Who may use Accounts</SectionTitle>
          <Panel className="mb-6 p-4" data-testid="accounts-access">
            <p className="mb-3 text-xs text-muted-foreground">Administrators have full access. Give other roles a level: Read (sees everything in Accounts), Post (also drafts, issues and journals), Accounts administrator (also settings, reference data and period locks).</p>
            {!access.data ? <Loading error={access.error} /> : (
              <div className="grid gap-2">
                {access.data.roles.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="w-56 truncate">{r.name}</span>
                    <select className={sel} value={r.level} disabled={r.fixed} aria-label={`Accounts level of ${r.name}`} onChange={(e) => {
                      const next = Object.fromEntries(access.data!.roles.filter((x) => !x.fixed).map((x) => [x.id, x.id === r.id ? (e.target.value as Level) : x.level]))
                      void run(() => accountsApi.saveAccess(next), 'Access saved')
                    }}>
                      <option value="none">No access</option><option value="view">Read</option><option value="post">Post</option><option value="admin">Accounts administrator</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ reference data */

const DATED: FieldSpec[] = [
  { key: 'effectiveFrom', label: 'Effective from', type: 'date' }, { key: 'effectiveTo', label: 'Effective to', type: 'date' },
  { key: 'source', label: 'Source', hint: 'Notification number, date, schedule and serial number.' }, { key: 'approvedBy', label: 'Approved by' }, { key: 'approvedOn', label: 'Approved on', type: 'date', formOnly: true },
]
const GOODS_SERVICE = [{ value: 'goods', label: 'Goods' }, { value: 'service', label: 'Service' }]
const REFERENCE: Record<string, { label: string; title: string; fields: FieldSpec[]; intro: string }> = {
  rates: {
    label: 'Rates', title: 'Rates by HSN or SAC code', intro: 'The longest matching code wins on the document date. CGST and SGST/UTGST must add up to IGST.',
    fields: [{ key: 'code', label: 'HSN/SAC code or prefix' }, { key: 'description', label: 'Description' }, { key: 'kind', label: 'Kind', type: 'select', options: GOODS_SERVICE, initial: 'goods' }, { key: 'condition', label: 'Condition', formOnly: true },
      { key: 'igst', label: 'IGST %' }, { key: 'cgst', label: 'CGST %' }, { key: 'sgst', label: 'SGST/UTGST %' }, { key: 'cessAdValorem', label: 'Cess %', formOnly: true }, ...DATED],
  },
  states: {
    label: 'States', title: 'States and Union territories', intro: 'The State code is the first two digits of a GSTIN.',
    fields: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
      { key: 'kind', label: 'Kind', type: 'select', initial: 'state', options: [{ value: 'state', label: 'State' }, { value: 'ut_with_legislature', label: 'Union territory with legislature' }, { value: 'ut_without_legislature', label: 'Union territory without legislature' }, { value: 'other', label: 'Other' }] },
      { key: 'usesUtgst', label: 'Uses UTGST', type: 'bool' }, { key: 'specialCategory', label: 'Special category', type: 'bool', formOnly: true }, ...DATED],
  },
  thresholds: {
    label: 'Values', title: 'Thresholds, limits and switches', intro: 'Dated values the calculations read: the first month of the financial year, HSN digits, the e-way bill value and others.',
    fields: [{ key: 'key', label: 'Key' }, { key: 'description', label: 'Description' }, { key: 'valueNumber', label: 'Number' }, { key: 'valueText', label: 'Text' }, ...DATED],
  },
  units: { label: 'Units', title: 'Units (UQC)', intro: 'Unique Quantity Codes for quantities on documents.', fields: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, ...DATED] },
  rcm: {
    label: 'Reverse charge', title: 'Reverse charge categories', intro: 'Categories of inward supplies on which the business pays the tax.',
    fields: [{ key: 'code', label: 'Code' }, { key: 'description', label: 'Description' }, { key: 'kind', label: 'Kind', type: 'select', options: GOODS_SERVICE, initial: 'service' }, { key: 'supplierCondition', label: 'Supplier condition', formOnly: true },
      { key: 'recipientCondition', label: 'Recipient condition', formOnly: true }, { key: 'rateCode', label: 'Rate reference (HSN/SAC)' }, ...DATED],
  },
}

export function ReferenceData({ state }: { state: AccountsState }) {
  const [kind, setKind] = useState('rates')
  const r = useLoad(() => accountsApi.reference(kind), [kind])
  const spec = REFERENCE[kind]
  return (
    <div data-testid="accounts-reference">
      <DraftNotice text={state.notice} />
      <div className="mb-4"><Segmented label="Reference data" value={kind} onChange={setKind} options={Object.entries(REFERENCE).map(([value, s]) => ({ value, label: s.label }))} /></div>
      {!r.data ? <Loading error={r.error} /> : (
        <CrudTable title={spec.title} testid={`ref-${kind}`} canEdit={state.level === 'admin'} fields={spec.fields} rows={r.data.items} empty="Nothing entered yet."
          intro={<p className="mb-3 text-xs text-muted-foreground">{spec.intro} Every row needs the date it takes effect and its source.</p>}
          onSave={(id, v) => accountsApi.saveReference(kind, id, v).then(r.reload)} onDelete={(row) => accountsApi.removeReference(kind, row.id).then(r.reload)} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ parties, items, series, chart */

const PARTY_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role', type: 'select', initial: 'customer', options: [{ value: 'customer', label: 'Customer' }, { value: 'supplier', label: 'Supplier' }, { value: 'both', label: 'Customer and supplier' }] },
  { key: 'regType', label: 'Registration', type: 'select', initial: 'unregistered', options: [{ value: 'regular', label: 'Registered (regular)' }, { value: 'composition', label: 'Composition' }, { value: 'sez_unit', label: 'SEZ unit' }, { value: 'sez_developer', label: 'SEZ developer' }, { value: 'uin', label: 'UIN holder' }, { value: 'unregistered', label: 'Unregistered' }, { value: 'overseas', label: 'Outside India' }] },
  { key: 'gstin', label: 'GSTIN or UIN' }, { key: 'stateCode', label: 'State code' }, { key: 'country', label: 'Country (two letters)', initial: 'IN', formOnly: true }, { key: 'address', label: 'Billing address' }, { key: 'pan', label: 'PAN', formOnly: true },
]
export function Parties({ state }: { state: AccountsState }) {
  const r = useLoad(accountsApi.parties)
  if (!r.data) return <Loading error={r.error} />
  return <CrudTable title="Customers and suppliers" testid="accounts-parties" canEdit={state.level !== 'view'} fields={PARTY_FIELDS} rows={r.data.items} empty="No customers or suppliers yet." onSave={(id, v) => accountsApi.saveParty(id, v).then(r.reload)} />
}

export function Items({ state }: { state: AccountsState }) {
  const r = useLoad(accountsApi.items)
  const chart = useLoad(accountsApi.chart)
  if (!r.data || !chart.data) return <Loading error={r.error || chart.error} />
  const fields: FieldSpec[] = [
    { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind', type: 'select', options: GOODS_SERVICE, initial: 'goods' }, { key: 'hsn', label: 'HSN or SAC code' }, { key: 'uqc', label: 'Unit (UQC)' },
    { key: 'rateCode', label: 'Rate reference', hint: 'The HSN/SAC code the rate is looked up by; blank: the item code.', formOnly: true }, { key: 'rateCondition', label: 'Rate condition', formOnly: true },
    { key: 'supplyClass', label: 'Supply class', type: 'select', initial: 'taxable', options: [{ value: 'taxable', label: 'Taxable' }, { value: 'nil-rated', label: 'Nil-rated' }, { value: 'exempt', label: 'Exempt' }, { value: 'zero-rated-capable', label: 'Taxable, may be zero-rated' }, { value: 'non-gst', label: 'Non-GST' }] },
    { key: 'posCategory', label: 'Place-of-supply category', initial: 'general', hint: 'Services: "general", or a special category (then the document stops and asks the accountant).', formOnly: true },
    { key: 'rcmCategory', label: 'Reverse charge category', formOnly: true },
    { key: 'itcDefault', label: 'ITC on purchases', type: 'select', initial: 'undecided', formOnly: true, options: [{ value: 'undecided', label: 'Decide per purchase' }, { value: 'eligible', label: 'Eligible' }, { value: 'ineligible', label: 'Ineligible' }] },
    { key: 'unitPrice', label: 'Unit price' },
    { key: 'expenseAccount', label: 'Purchase account', type: 'select', formOnly: true, options: [{ value: '', label: '(default)' }, ...chart.data.items.filter((a) => a.kind === 'expense' || a.kind === 'asset').map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))] },
  ]
  return <CrudTable title="Items and services" testid="accounts-items" canEdit={state.level !== 'view'} fields={fields} rows={r.data.items} empty="No items yet." onSave={(id, v) => accountsApi.saveItem(id, v).then(r.reload)} />
}

export function ChartAndSeries({ state }: { state: AccountsState }) {
  const chart = useLoad(accountsApi.chart)
  const series = useLoad(accountsApi.series)
  const admin = state.level === 'admin'
  if (!chart.data || !series.data) return <Loading error={chart.error || series.error} />
  const kinds = ['asset', 'liability', 'equity', 'income', 'expense'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))
  const types = (state.docTypes ?? []).map((t) => ({ value: t.type, label: t.title }))
  return (
    <div className="grid gap-8">
      <CrudTable title="Chart of accounts" testid="accounts-chart" canEdit={admin} rows={chart.data.items} empty='No accounts yet. Use "Set up the books" in Settings.'
        fields={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind', type: 'select', options: kinds, initial: 'expense' }, { key: 'active', label: 'In use', type: 'bool', initial: true }]}
        onSave={(id, v) => (id ? accountsApi.saveAccount(id, { code: String(v.code), name: String(v.name), active: v.active === true }) : accountsApi.addAccount({ code: String(v.code), name: String(v.name), kind: String(v.kind) })).then(chart.reload)} />
      <CrudTable title="Number series" testid="accounts-series" canEdit={admin} rows={series.data.items} empty='No number series yet. Use "Set up the books" in Settings.'
        intro={<p className="mb-3 text-xs text-muted-foreground">A number is taken when a document is issued, never for a draft. {'{FY}'} stands for the financial year (26-27); the counter restarts each financial year. A number has at most 16 characters: letters, digits, hyphen and slash.</p>}
        fields={[{ key: 'docType', label: 'Document', type: 'select', options: types }, { key: 'name', label: 'Name' }, { key: 'prefix', label: 'Prefix' }, { key: 'suffix', label: 'Suffix' }, { key: 'padding', label: 'Digits', initial: '5' }, { key: 'isDefault', label: 'Default', type: 'bool' }, { key: 'active', label: 'In use', type: 'bool', initial: true }]}
        onSave={(id, v) => accountsApi.saveSeries(id, { ...v, padding: Number(v.padding) }).then(series.reload)} />
    </div>
  )
}
