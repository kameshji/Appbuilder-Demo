/**
 * Data of the GST package that an administrator maintains (docs/plan/gst-spec-draft.md section 2 and 11.2): the
 * business registration (G2.1 to G2.4), the dated reference tables (States, rates, thresholds, units, reverse charge
 * categories), customers and suppliers (G2.5), items and services (G2.10), number series (G7.6).
 *
 * The product ships the reference tables EMPTY. `loadExamples` adds rows clearly marked "not approved": the State list
 * and the values the draft lists in section 11.2 with a value. It adds NO rates: those come from the accountant.
 * Nothing in the engine reads a rate, a State code or a threshold from anywhere but these tables.
 */
import type { SqlDb } from '../contracts.ts'
import { uid } from '../util.ts'
import { T, conflict, dateOf, getSetting, invalid, isObj, notFound, oneOf, optionalDate, putSetting, requiredText, text } from '../ledger/core.ts'
import { paise, parseDecimal, rupees, PRICE_SCALE, RATE_SCALE, decimalText, type Paise } from './money.ts'
import {
  BUSINESS_REG_STOP, BUSINESS_REG_TYPES, DOC_TYPES, PARTY_REG_TYPES, SUPPLY_CLASSES, gstinProblem, isEffective, rateRowProblem, ratesOverlap, seriesProblem,
  type BusinessRegType, type DocType, type ItemKind, type PartyRegType, type RateRow, type StateInfo, type SupplyClass,
} from './engine.ts'

/* ------------------------------------------------------------------ the business registration */

export interface Business {
  gstin: string
  legalName: string
  tradeName: string
  address: string
  stateCode: string
  regType: BusinessRegType
  effectiveFrom: string | null
  pan: string
  phone: string
  email: string
  /** aggregate turnover per financial year, rupees as text (G2.1; used by G7.7 and G8.3) */
  turnovers: Record<string, string>
  /** G2.4 */
  luts: { fy: string; reference: string; filedOn: string | null }[]
  /** G2.3 */
  composition: { category: 'manufacturer' | 'restaurant' | 'other' | 'services'; from: string } | null
  /** draft 11.2 "Business settings": DESIGN defaults per line, round-off on, manual place of supply off */
  settings: { taxMode: 'line' | 'document'; roundOff: boolean; manualPlaceOfSupply: boolean }
  /** text printed at the foot of documents (bank details, terms) */
  footer: string
}
const COMPOSITION_CATEGORIES = ['manufacturer', 'restaurant', 'other', 'services'] as const

export const getBusiness = (db: SqlDb): Promise<Business | null> => getSetting<Business | null>(db, 'business', null)

export async function putBusiness(db: SqlDb, b: Record<string, unknown>): Promise<Business> {
  const regType = oneOf(b.regType, [...BUSINESS_REG_TYPES, ...BUSINESS_REG_STOP], 'Registration type', 'regType')
  const stateCode = requiredText(b.stateCode, 2, 'State code', 'stateCode')
  const gstin = text(b.gstin, 15).toUpperCase()
  if (regType !== 'unregistered') {
    const p = gstinProblem(gstin, stateCode)
    if (p) throw invalid(p, 'gstin')
  } else if (gstin) throw invalid('An unregistered business has no GSTIN.', 'gstin')
  const turnovers: Record<string, string> = {}
  if (isObj(b.turnovers)) for (const [fy, v] of Object.entries(b.turnovers).slice(0, 40)) {
    if (!/^\d{4}(-\d{2})?$/.test(fy)) throw invalid(`"${fy.slice(0, 12)}" is not a financial year (write 2025-26).`, 'turnovers')
    if (v === '' || v === null) continue
    const p = paise(v, `Turnover of ${fy}`)
    if (p < 0) throw invalid('A turnover cannot be negative.', 'turnovers')
    turnovers[fy] = rupees(p)
  }
  const luts = (Array.isArray(b.luts) ? b.luts : []).slice(0, 40).map((l) => {
    const o = isObj(l) ? l : {}
    if (!/^\d{4}(-\d{2})?$/.test(String(o.fy ?? ''))) throw invalid('An LUT entry needs its financial year (write 2026-27).', 'luts')
    return { fy: String(o.fy), reference: requiredText(o.reference, 60, 'The LUT reference number', 'luts'), filedOn: optionalDate(o.filedOn, 'The LUT date', 'luts') }
  })
  const st = isObj(b.settings) ? b.settings : {}
  const comp = isObj(b.composition) ? b.composition : null
  const composition = regType === 'composition' || regType === 'composition-services'
    ? { category: oneOf(comp?.category ?? (regType === 'composition-services' ? 'services' : undefined), COMPOSITION_CATEGORIES, 'Composition category', 'composition'), from: dateOf(comp?.from, 'The date the composition option took effect', 'composition') }
    : null
  const out: Business = {
    gstin, legalName: requiredText(b.legalName, 200, 'Legal name', 'legalName'), tradeName: text(b.tradeName, 200), address: requiredText(b.address, 500, 'Address', 'address'), stateCode, regType,
    effectiveFrom: optionalDate(b.effectiveFrom, 'Effective date of registration', 'effectiveFrom'), pan: text(b.pan, 10).toUpperCase(), phone: text(b.phone, 40), email: text(b.email, 120),
    turnovers, luts, composition,
    settings: { taxMode: st.taxMode === 'document' ? 'document' : 'line', roundOff: st.roundOff !== false, manualPlaceOfSupply: st.manualPlaceOfSupply === true },
    footer: text(b.footer, 1000),
  }
  await putSetting(db, 'business', out)
  return out
}

/* ------------------------------------------------------------------ dated reference tables */

type FieldType = 'text' | 'bool' | 'rate' | 'number' | 'code' | `enum:${string}`
interface KindSpec {
  table: string
  label: string
  /** [api name, column, type, required] */
  fields: [string, string, FieldType, boolean][]
  /** rows with the same values here may not overlap in time */
  identity: string[]
  order: string
}
export const REFERENCE_KINDS: Record<string, KindSpec> = {
  states: {
    table: 'ab_gst_states', label: 'State', identity: ['code'], order: 'code',
    fields: [['code', 'code', 'code', true], ['name', 'name', 'text', true], ['kind', 'kind', 'enum:state|ut_with_legislature|ut_without_legislature|other', true], ['usesUtgst', 'uses_utgst', 'bool', false], ['specialCategory', 'special_category', 'bool', false]],
  },
  rates: {
    table: 'ab_gst_rates', label: 'Rate', identity: ['code', 'kind', 'condition'], order: 'code',
    fields: [['code', 'code', 'code', true], ['description', 'description', 'text', false], ['kind', 'kind', 'enum:goods|service', true], ['condition', 'condition', 'text', false],
      ['igst', 'igst_rate', 'rate', true], ['cgst', 'cgst_rate', 'rate', true], ['sgst', 'sgst_utgst_rate', 'rate', true], ['cessAdValorem', 'cess_rate_ad_valorem', 'rate', false],
      ['cessSpecificAmount', 'cess_specific_amount', 'number', false], ['cessSpecificUnit', 'cess_specific_unit', 'text', false]],
  },
  thresholds: {
    table: 'ab_gst_thresholds', label: 'Value', identity: ['key'], order: 'key',
    fields: [['key', 'key', 'text', true], ['description', 'description', 'text', false], ['valueNumber', 'value_number', 'number', false], ['valueText', 'value_text', 'text', false]],
  },
  units: { table: 'ab_gst_units', label: 'Unit', identity: ['code'], order: 'code', fields: [['code', 'code', 'text', true], ['name', 'name', 'text', false]] },
  rcm: {
    table: 'ab_gst_rcm', label: 'Reverse charge category', identity: ['code'], order: 'code',
    fields: [['code', 'code', 'text', true], ['description', 'description', 'text', false], ['kind', 'kind', 'enum:goods|service', true], ['supplierCondition', 'supplier_condition', 'text', false],
      ['recipientCondition', 'recipient_condition', 'text', false], ['rateCode', 'rate_code', 'text', false]],
  },
}
const specOf = (kind: string): KindSpec => {
  const s = REFERENCE_KINDS[kind]
  if (!s) throw notFound('Reference data kind')
  return s
}
export type RefRow = Record<string, string | boolean | null> & { id: string; effectiveFrom: string; effectiveTo: string | null; source: string; approvedBy: string; approvedOn: string | null }

function fromDb(spec: KindSpec, r: Record<string, unknown>): RefRow {
  const out: Record<string, string | boolean | null> = {}
  for (const [api, col, type] of spec.fields) {
    const v = r[col]
    out[api] = type === 'bool' ? v === true : v === null || v === undefined ? null
      : type === 'rate' ? decimalText(parseDecimal(String(v), RATE_SCALE), RATE_SCALE) : type === 'number' ? decimalText(parseDecimal(String(v), 4), 4) : String(v)
  }
  return {
    ...out, id: String(r.id), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null, source: String(r.source ?? ''),
    approvedBy: String(r.approved_by ?? ''), approvedOn: r.approved_on ? String(r.approved_on) : null,
  }
}

export async function listReference(db: SqlDb, kind: string): Promise<RefRow[]> {
  const spec = specOf(kind)
  return (await db.query<Record<string, unknown>>(`SELECT * FROM ${T(spec.table)} ORDER BY ${spec.order} COLLATE "C", effective_from, id`)).map((r) => fromDb(spec, r))
}

function readFields(spec: KindSpec, b: Record<string, unknown>, cur?: RefRow): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {}
  for (const [api, , type, required] of spec.fields) {
    const raw = b[api] !== undefined ? b[api] : cur ? cur[api] : undefined
    const blank = raw === undefined || raw === null || raw === ''
    if (type === 'bool') { out[api] = raw === true; continue }
    if (blank) {
      if (required) throw invalid(`${api} is required.`, api)
      out[api] = type === 'text' ? '' : null
      continue
    }
    if (type === 'text') out[api] = text(raw, 300)
    else if (type === 'code') {
      const c = text(raw, 8)
      if (!/^\d{2,8}$/.test(c)) throw invalid(`${api} is 2 to 8 digits.`, api)
      out[api] = c
    } else if (type === 'rate' || type === 'number') {
      const scale = type === 'rate' ? RATE_SCALE : 4
      let n: bigint
      try { n = parseDecimal(raw, scale, api) } catch (e) { throw invalid((e as Error).message, api) }
      if (n < 0n) throw invalid(`${api} cannot be negative.`, api)
      out[api] = decimalText(n, scale)
    } else out[api] = oneOf(raw, type.slice(5).split('|'), api, api)
  }
  return out
}

/** create (no id) or change a dated row. Validation: G4.2 for rates; no two rows of one identity overlap in time. */
export async function saveReference(db: SqlDb, kind: string, id: string | null, b: Record<string, unknown>, by: string): Promise<RefRow> {
  const spec = specOf(kind)
  return db.tx(async (tx) => {
    // one writer per reference table at a time, so the overlap check holds
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`accounts.reference.${kind}`])
    const all = (await tx.query<Record<string, unknown>>(`SELECT * FROM ${T(spec.table)}`)).map((r) => fromDb(spec, r))
    const cur = id ? all.find((r) => r.id === id) : undefined
    if (id && !cur) throw notFound(spec.label)
    const f = readFields(spec, b, cur)
    const effectiveFrom = dateOf(b.effectiveFrom ?? cur?.effectiveFrom, 'Effective from', 'effectiveFrom')
    const effectiveTo = optionalDate(b.effectiveTo !== undefined ? b.effectiveTo : cur?.effectiveTo, 'Effective to', 'effectiveTo')
    if (effectiveTo && effectiveTo < effectiveFrom) throw invalid('Effective to is on or after effective from.', 'effectiveTo')
    const source = text(b.source ?? cur?.source, 500)
    const approvedBy = text(b.approvedBy ?? cur?.approvedBy, 200)
    const approvedOn = optionalDate(b.approvedOn !== undefined ? b.approvedOn : cur?.approvedOn, 'Approved on', 'approvedOn')
    if (kind === 'rates') {
      const p = rateRowProblem({ ...(f as unknown as RateRow), effectiveFrom, effectiveTo, source })
      if (p) throw invalid(p)
    } else if (!source) throw invalid('Every reference row needs its source.', 'source')
    if (kind === 'thresholds' && f.valueNumber === null && !f.valueText) throw invalid('A value needs a number or a text.', 'valueNumber')
    const row = { ...f, effectiveFrom, effectiveTo }
    for (const o of all) {
      if (o.id === id || !spec.identity.every((k) => String(o[k] ?? '') === String(f[k] ?? ''))) continue
      const overlap = kind === 'rates' ? ratesOverlap(row as unknown as RateRow, o as unknown as RateRow) : o.effectiveFrom <= (effectiveTo || '9999-12-31') && effectiveFrom <= (o.effectiveTo || '9999-12-31')
      if (overlap) throw conflict(`Another ${spec.label.toLowerCase()} row for ${spec.identity.map((k) => String(f[k] ?? '')).filter(Boolean).join(' / ')} covers part of these dates (from ${o.effectiveFrom}${o.effectiveTo ? ` to ${o.effectiveTo}` : ''}). End that row first.`, 'effectiveFrom')
    }
    const cols = spec.fields.map(([, c]) => c)
    const vals = spec.fields.map(([api]) => f[api])
    const rid = id ?? uid('ref')
    if (id) {
      await tx.exec(`UPDATE ${T(spec.table)} SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')}, effective_from = $${cols.length + 2}, effective_to = $${cols.length + 3}, source = $${cols.length + 4}, approved_by = $${cols.length + 5}, approved_on = $${cols.length + 6}, modified_by = $${cols.length + 7}, modified_on = now() WHERE id = $1`,
        [rid, ...vals, effectiveFrom, effectiveTo, source, approvedBy, approvedOn, by])
    } else {
      await tx.exec(`INSERT INTO ${T(spec.table)} (id, ${cols.map((c) => `"${c}"`).join(', ')}, effective_from, effective_to, source, approved_by, approved_on, modified_by, modified_on) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4}, $${cols.length + 5}, $${cols.length + 6}, $${cols.length + 7}, now())`,
        [rid, ...vals, effectiveFrom, effectiveTo, source, approvedBy, approvedOn, by])
    }
    return fromDb(spec, (await tx.query<Record<string, unknown>>(`SELECT * FROM ${T(spec.table)} WHERE id = $1`, [rid]))[0])
  })
}

export async function removeReference(db: SqlDb, kind: string, id: string): Promise<RefRow> {
  const spec = specOf(kind)
  const r = await db.query<Record<string, unknown>>(`DELETE FROM ${T(spec.table)} WHERE id = $1 RETURNING *`, [id])
  if (!r.length) throw notFound(spec.label)
  return fromDb(spec, r[0])
}

/* ---- what the engine reads */

export async function statesOn(db: SqlDb, date: string): Promise<(StateInfo & { kind: string })[]> {
  return (await listReference(db, 'states')).filter((s) => isEffective(s, date)).map((s) => ({ code: String(s.code), name: String(s.name), usesUtgst: s.usesUtgst === true, kind: String(s.kind) }))
}
export async function allRates(db: SqlDb): Promise<RateRow[]> {
  return (await listReference(db, 'rates')).map((r) => ({
    id: r.id, code: String(r.code), kind: r.kind as ItemKind, condition: String(r.condition ?? ''), igst: String(r.igst), cgst: String(r.cgst), sgst: String(r.sgst),
    cessAdValorem: r.cessAdValorem as string | null, cessSpecificAmount: r.cessSpecificAmount as string | null, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, source: r.source,
  }))
}
/** the dated values in force on a date, by key */
export interface Thresholds {
  number(key: string): string | null
  text(key: string): string | null
  /** a rupee value as paise */
  money(key: string): Paise | null
  /** a whole number; 422 naming the key when it is missing (for values the software cannot work without) */
  requiredInt(key: string): number
}
export async function thresholdsOn(db: SqlDb, date: string): Promise<Thresholds> {
  const rows = (await listReference(db, 'thresholds')).filter((r) => isEffective(r, date))
  const find = (key: string) => rows.find((r) => r.key === key)
  const number = (key: string) => (find(key)?.valueNumber as string | null | undefined) ?? null
  return {
    number,
    text: (key) => { const t = find(key)?.valueText; return t ? String(t) : null },
    money: (key) => { const n = number(key); return n === null ? null : Number(parseDecimal(n, 4, key) / 100n) },
    requiredInt: (key) => {
      const n = number(key)
      if (n === null || !/^\d+$/.test(n)) throw invalid(`The value "${key}" is not set for ${date}. An Accounts administrator adds it in Accounts > Reference data > Values (or loads the example data).`)
      return Number(n)
    },
  }
}

/* ---- example data: marked not approved, never rates */

const EXAMPLE_SOURCE = 'EXAMPLE, NOT APPROVED: from docs/plan/gst-spec-draft.md 0.1-draft; an accountant must confirm it'
const UT_NO_LEG = new Set(['04', '26', '31', '35', '38'])
const UT_LEG = new Set(['01', '07', '34'])
/** State and Union territory names with the commonly used GST State codes (draft G2.7: UNVERIFIED, the accountant supplies the list) */
const EXAMPLE_STATES: [string, string][] = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
]
/** draft 11.2 rows that have a value, plus the DESIGN defaults the software needs to run (key, description, number, text) */
const EXAMPLE_VALUES: [string, string, string | null, string | null][] = [
  ['financial_year_start_month', 'First month of the financial year (G9.9; 4 = April)', '4', null],
  ['credit_note_deadline', 'Last day for a GST credit note after the financial year of the supply, as month-day (G5.17)', null, '11-30'],
  ['rate_change_confirm_days', 'Days after a rate change in which the user confirms the rate date (G4.4)', '30', null],
  ['hsn_digits_small', 'HSN digits up to the turnover limit (G7.7)', '4', null],
  ['hsn_digits_large', 'HSN digits above the turnover limit (G7.7)', '6', null],
  ['hsn_turnover_limit', 'Turnover limit for HSN digits, rupees (G7.7)', '50000000', null],
  ['hsn_optional_unregistered', 'Up to the limit, HSN may be omitted for unregistered recipients: 1 yes, 0 no (G7.7)', '1', null],
  ['einvoice_turnover_threshold', 'E-invoice class: turnover of any earlier financial year above this, rupees (G8.2)', '50000000', null],
  ['eway_consignment_value', 'E-way bill prompt above this consignment value, rupees (G8.5)', '50000', null],
  ['unregistered_details_value', 'Unregistered recipient: name, address and State needed from this taxable value, rupees (G3.11)', '50000', null],
  ['other_country_code', 'Place of supply code printed for outside India (G3.10)', null, '96'],
  ['composition_rate_cgst:manufacturer', 'Composition tax, central share, percent (G6.6)', '0.5', null],
  ['composition_rate_sgst:manufacturer', 'Composition tax, State share, percent (G6.6: assumed equal)', '0.5', null],
  ['composition_rate_cgst:restaurant', 'Composition tax, central share, percent (G6.6)', '2.5', null],
  ['composition_rate_sgst:restaurant', 'Composition tax, State share, percent (G6.6: assumed equal)', '2.5', null],
  ['composition_rate_cgst:other', 'Composition tax, central share, percent (G6.6)', '0.5', null],
  ['composition_rate_sgst:other', 'Composition tax, State share, percent (G6.6: assumed equal)', '0.5', null],
  ['composition_rate_cgst:services', 'Composition tax, central share, percent (G6.6)', '3', null],
  ['composition_rate_sgst:services', 'Composition tax, State share, percent (G6.6: assumed equal)', '3', null],
]

/** adds the example rows that are missing (by code / key); never changes a row. No rates. */
export async function loadExamples(db: SqlDb, by: string): Promise<{ states: number; values: number }> {
  return db.tx(async (tx) => {
    let states = 0
    let values = 0
    const haveS = new Set((await listReference(tx, 'states')).map((r) => r.code))
    for (const [code, name] of EXAMPLE_STATES) {
      if (haveS.has(code)) continue
      const kind = UT_NO_LEG.has(code) ? 'ut_without_legislature' : UT_LEG.has(code) ? 'ut_with_legislature' : 'state'
      await saveReference(tx, 'states', null, { code, name, kind, usesUtgst: UT_NO_LEG.has(code), effectiveFrom: '2017-07-01', source: EXAMPLE_SOURCE }, by)
      states++
    }
    const haveV = new Set((await listReference(tx, 'thresholds')).map((r) => r.key))
    for (const [key, description, valueNumber, valueText] of EXAMPLE_VALUES) {
      if (haveV.has(key)) continue
      await saveReference(tx, 'thresholds', null, { key, description, valueNumber, valueText, effectiveFrom: '2017-07-01', source: EXAMPLE_SOURCE }, by)
      values++
    }
    return { states, values }
  })
}

/* ------------------------------------------------------------------ parties (G2.5) */

export interface Party {
  id: string; role: 'customer' | 'supplier' | 'both'; name: string; gstin: string; regType: PartyRegType; stateCode: string; country: string; address: string; pan: string
  shipTo: { label: string; address: string; stateCode: string; country: string }[]; active: boolean
}
const toParty = (r: Record<string, unknown>): Party => ({
  id: String(r.id), role: r.role as Party['role'], name: String(r.name), gstin: String(r.gstin), regType: r.reg_type as PartyRegType, stateCode: String(r.state_code), country: String(r.country),
  address: String(r.address), pan: String(r.pan), shipTo: (r.ship_to as Party['shipTo']) ?? [], active: r.active === true,
})
export async function listParties(db: SqlDb): Promise<Party[]> {
  return (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_parties')} ORDER BY lower(name) COLLATE "C", id`)).map(toParty)
}
export async function getParty(db: SqlDb, id: string): Promise<Party | null> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_parties')} WHERE id = $1`, [id])
  return r.length ? toParty(r[0]) : null
}
export async function saveParty(db: SqlDb, id: string | null, b: Record<string, unknown>): Promise<Party> {
  const cur = id ? await getParty(db, id) : null
  if (id && !cur) throw notFound('Customer or supplier')
  const pick = <K extends keyof Party>(k: K): unknown => (b[k] !== undefined ? b[k] : cur?.[k])
  const regType = oneOf(pick('regType') ?? 'unregistered', PARTY_REG_TYPES, 'Registration type', 'regType')
  const country = (text(pick('country'), 2) || 'IN').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) throw invalid('Country is a two-letter code (IN for India).', 'country')
  if (regType === 'overseas' && country === 'IN') throw invalid('An overseas party has a country other than India.', 'country')
  if (regType !== 'overseas' && country !== 'IN') throw invalid('A party outside India has the registration type "overseas".', 'regType')
  const stateCode = text(pick('stateCode'), 2)
  const gstin = text(pick('gstin'), 15).toUpperCase()
  if (regType === 'unregistered' || regType === 'overseas') {
    if (gstin) throw invalid('An unregistered or overseas party has no GSTIN.', 'gstin')
  } else {
    if (!stateCode) throw invalid('A registered party needs its State code.', 'stateCode')
    const p = gstinProblem(gstin, stateCode)
    if (p) throw invalid(p, 'gstin')
  }
  if (stateCode && !/^\d{2}$/.test(stateCode)) throw invalid('A State code is two digits.', 'stateCode')
  if (stateCode && !(await db.query(`SELECT 1 FROM ${T('ab_gst_states')} WHERE code = $1 LIMIT 1`, [stateCode])).length) throw invalid(`There is no State with code ${stateCode} in the reference data.`, 'stateCode')
  const shipRaw = b.shipTo !== undefined ? b.shipTo : cur?.shipTo ?? []
  const shipTo = (Array.isArray(shipRaw) ? shipRaw : []).slice(0, 20).map((x) => {
    const o = isObj(x) ? x : {}
    return { label: text(o.label, 80), address: text(o.address, 500), stateCode: text(o.stateCode, 2), country: (text(o.country, 2) || 'IN').toUpperCase() }
  })
  const v = [oneOf(pick('role') ?? 'customer', ['customer', 'supplier', 'both'], 'Role', 'role'), requiredText(pick('name'), 200, 'Name', 'name'), gstin, regType, stateCode, country, text(pick('address'), 500), text(pick('pan'), 10).toUpperCase(), JSON.stringify(shipTo), b.active !== undefined ? b.active !== false : cur?.active ?? true]
  const pid = id ?? uid('pty')
  if (id) await db.exec(`UPDATE ${T('ab_gst_parties')} SET role = $2, name = $3, gstin = $4, reg_type = $5, state_code = $6, country = $7, address = $8, pan = $9, ship_to = $10::jsonb, active = $11, modified_on = now() WHERE id = $1`, [pid, ...v])
  else await db.exec(`INSERT INTO ${T('ab_gst_parties')} (id, role, name, gstin, reg_type, state_code, country, address, pan, ship_to, active, created_on, modified_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now(), now())`, [pid, ...v])
  return (await getParty(db, pid))!
}

/* ------------------------------------------------------------------ items and services (G2.10, G2.11) */

export const ITC_FLAGS = ['eligible', 'ineligible', 'undecided'] as const
export type ItcFlag = (typeof ITC_FLAGS)[number]
export interface Item {
  id: string; name: string; kind: ItemKind; hsn: string; uqc: string; rateCode: string; rateCondition: string; supplyClass: SupplyClass; posCategory: string; rcmCategory: string
  itcDefault: ItcFlag; unitPrice: string | null; expenseAccount: string | null; active: boolean
}
const toItem = (r: Record<string, unknown>): Item => ({
  id: String(r.id), name: String(r.name), kind: r.kind as ItemKind, hsn: String(r.hsn), uqc: String(r.uqc), rateCode: String(r.rate_code), rateCondition: String(r.rate_condition),
  supplyClass: r.supply_class as SupplyClass, posCategory: String(r.pos_category), rcmCategory: String(r.rcm_category), itcDefault: r.itc_default as ItcFlag,
  unitPrice: r.unit_price === null || r.unit_price === undefined ? null : decimalText(parseDecimal(String(r.unit_price), PRICE_SCALE), PRICE_SCALE, 2),
  expenseAccount: r.expense_account ? String(r.expense_account) : null, active: r.active === true,
})
export async function listItems(db: SqlDb): Promise<Item[]> {
  return (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_items')} ORDER BY lower(name) COLLATE "C", id`)).map(toItem)
}
export async function saveItem(db: SqlDb, id: string | null, b: Record<string, unknown>): Promise<Item> {
  const cur = id ? (await listItems(db)).find((i) => i.id === id) : undefined
  if (id && !cur) throw notFound('Item')
  const pick = <K extends keyof Item>(k: K): unknown => (b[k] !== undefined ? b[k] : cur?.[k])
  const hsn = text(pick('hsn'), 8)
  if (hsn && !/^\d{2,8}$/.test(hsn)) throw invalid('An HSN or SAC code is 2 to 8 digits.', 'hsn')
  const rateCode = text(pick('rateCode'), 8) || hsn
  if (rateCode && !/^\d{2,8}$/.test(rateCode)) throw invalid('The rate reference is an HSN or SAC code of 2 to 8 digits.', 'rateCode')
  let unitPrice: string | null = null
  const up = pick('unitPrice')
  if (up !== undefined && up !== null && up !== '') {
    try { unitPrice = decimalText(parseDecimal(up, PRICE_SCALE, 'Unit price'), PRICE_SCALE) } catch (e) { throw invalid((e as Error).message, 'unitPrice') }
  }
  const expenseAccount = text(pick('expenseAccount'), 80) || null
  if (expenseAccount && !(await db.query(`SELECT 1 FROM ${T('ab_led_accounts')} WHERE id = $1`, [expenseAccount])).length) throw invalid('The expense account does not exist.', 'expenseAccount')
  const v = [requiredText(pick('name'), 200, 'Name', 'name'), oneOf(pick('kind'), ['goods', 'service'], 'Kind', 'kind'), hsn, text(pick('uqc'), 10).toUpperCase(), rateCode, text(pick('rateCondition'), 100),
    oneOf(pick('supplyClass') ?? 'taxable', SUPPLY_CLASSES, 'Supply class', 'supplyClass'), text(pick('posCategory'), 60) || 'general', text(pick('rcmCategory'), 60),
    oneOf(pick('itcDefault') ?? 'undecided', ITC_FLAGS, 'ITC default', 'itcDefault'), unitPrice, expenseAccount, b.active !== undefined ? b.active !== false : cur?.active ?? true]
  const iid = id ?? uid('itm')
  if (id) await db.exec(`UPDATE ${T('ab_gst_items')} SET name = $2, kind = $3, hsn = $4, uqc = $5, rate_code = $6, rate_condition = $7, supply_class = $8, pos_category = $9, rcm_category = $10, itc_default = $11, unit_price = $12, expense_account = $13, active = $14, modified_on = now() WHERE id = $1`, [iid, ...v])
  else await db.exec(`INSERT INTO ${T('ab_gst_items')} (id, name, kind, hsn, uqc, rate_code, rate_condition, supply_class, pos_category, rcm_category, itc_default, unit_price, expense_account, active, created_on, modified_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())`, [iid, ...v])
  return (await listItems(db)).find((i) => i.id === iid)!
}

/* ------------------------------------------------------------------ number series (G7.6) */

export interface Series { id: string; docType: DocType; name: string; prefix: string; suffix: string; padding: number; isDefault: boolean; active: boolean }
/** the series created by "set up the books": one per document type, restarting each financial year (`{FY}` = 26-27) */
export const DEFAULT_SERIES: Record<DocType, string> = {
  tax_invoice: 'INV/{FY}/', bill_of_supply: 'BOS/{FY}/', credit_note: 'CN/{FY}/', debit_note: 'DN/{FY}/', receipt_voucher: 'RV/{FY}/', refund_voucher: 'RF/{FY}/',
  payment_voucher: 'PV/{FY}/', purchase_invoice: 'PUR/{FY}/',
}
const toSeries = (r: Record<string, unknown>): Series => ({
  id: String(r.id), docType: r.doc_type as DocType, name: String(r.name), prefix: String(r.prefix), suffix: String(r.suffix), padding: Number(r.padding), isDefault: r.is_default === true, active: r.active === true,
})
export async function listSeries(db: SqlDb): Promise<Series[]> {
  return (await db.query<Record<string, unknown>>(`SELECT * FROM ${T('ab_gst_series')} ORDER BY doc_type, lower(name) COLLATE "C", id`)).map(toSeries)
}
export async function seedSeries(db: SqlDb): Promise<number> {
  const have = new Set((await listSeries(db)).filter((s) => s.isDefault && s.active).map((s) => s.docType))
  let n = 0
  for (const t of DOC_TYPES) {
    if (have.has(t)) continue
    await db.exec(`INSERT INTO ${T('ab_gst_series')} (id, doc_type, name, prefix, suffix, padding, is_default, active, created_on) VALUES ($1, $2, 'Default', $3, '', 5, true, true, now())`, [uid('ser'), t, DEFAULT_SERIES[t]])
    n++
  }
  return n
}
export async function saveSeries(db: SqlDb, id: string | null, b: Record<string, unknown>): Promise<Series> {
  return db.tx(async (tx) => {
    const cur = id ? (await listSeries(tx)).find((s) => s.id === id) : undefined
    if (id && !cur) throw notFound('Number series')
    const docType = cur ? cur.docType : oneOf(b.docType, DOC_TYPES, 'Document type', 'docType')
    const used = id ? (await tx.query(`SELECT 1 FROM ${T('ab_gst_series_counters')} WHERE series_id = $1 LIMIT 1`, [id])).length > 0 : false
    const f = { prefix: text(b.prefix ?? cur?.prefix, 16), suffix: text(b.suffix ?? cur?.suffix, 16), padding: Math.trunc(Number(b.padding ?? cur?.padding ?? 5)) }
    // a series that has issued numbers keeps its format: changing it could repeat or skip numbers
    if (used && (f.prefix !== cur!.prefix || f.suffix !== cur!.suffix || f.padding !== cur!.padding)) throw conflict('This series has issued numbers already: its format cannot change. Add a new series instead.')
    const p = seriesProblem(f)
    if (p) throw invalid(p, 'prefix')
    const isDefault = b.isDefault !== undefined ? b.isDefault === true : cur?.isDefault ?? false
    const active = b.active !== undefined ? b.active !== false : cur?.active ?? true
    const sid = id ?? uid('ser')
    if (isDefault && active) await tx.exec(`UPDATE ${T('ab_gst_series')} SET is_default = false WHERE doc_type = $1 AND id <> $2`, [docType, sid])
    const name = requiredText(b.name ?? cur?.name, 80, 'Name', 'name')
    if (id) await tx.exec(`UPDATE ${T('ab_gst_series')} SET name = $2, prefix = $3, suffix = $4, padding = $5, is_default = $6, active = $7 WHERE id = $1`, [sid, name, f.prefix, f.suffix, f.padding, isDefault && active, active])
    else await tx.exec(`INSERT INTO ${T('ab_gst_series')} (id, doc_type, name, prefix, suffix, padding, is_default, active, created_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`, [sid, docType, name, f.prefix, f.suffix, f.padding, isDefault && active, active])
    return (await listSeries(tx)).find((s) => s.id === sid)!
  })
}
