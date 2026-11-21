/**
 * Ledgers and India GST (P3 package L; docs/plan/ledgers-gst-spec.md, docs/dev/ledgers-gst.md): the tables of schema
 * version 15. Per environment schema, CREATE ... IF NOT EXISTS: idempotent, run on every start (environmentDdl in
 * meta-store.ts calls this file).
 *
 * Money is bigint PAISE everywhere (never a float, never numeric rupees); quantities numeric(18,3), unit prices
 * numeric(18,4), rates numeric(7,3). Dates of documents, journals and reference data are `date` (no time zone).
 * Reference data (ab_gst_states / _rates / _thresholds / _units / _rcm) carries effective_from, effective_to, source,
 * approved_by and approved_on on every row: the product ships them EMPTY (the GST draft is not reviewed).
 *
 * Never copied with an environment, never in a solution. Posted journals, their lines and issued documents are never
 * updated or deleted by the service (corrections are reversals and credit or debit notes).
 */
import type { SqlDb } from '../contracts.ts'

export const LEDGER_TABLES: string[] = [
  'ab_led_settings', 'ab_led_accounts', 'ab_led_years', 'ab_led_periods', 'ab_led_journals', 'ab_led_lines',
  'ab_gst_states', 'ab_gst_rates', 'ab_gst_thresholds', 'ab_gst_units', 'ab_gst_rcm',
  'ab_gst_parties', 'ab_gst_items', 'ab_gst_series', 'ab_gst_series_counters', 'ab_gst_documents', 'ab_gst_document_lines',
]

const DATED = `effective_from date NOT NULL,
      effective_to date NULL,
      source text NOT NULL DEFAULT '',
      approved_by text NOT NULL DEFAULT '',
      approved_on date NULL,
      modified_by text NULL,
      modified_on timestamptz NOT NULL`

export function ledgerEnvironmentDdl(schema: string): string[] {
  const q = (id: string): string => `"${id}"`
  const E = (t: string): string => `${q(schema)}.${q(t)}`
  return [
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_settings')} (k text PRIMARY KEY, v jsonb NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_accounts')} (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
      system_key text NULL,
      active boolean NOT NULL DEFAULT true,
      created_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_accounts_code ON ${E('ab_led_accounts')} (lower(code))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_accounts_key ON ${E('ab_led_accounts')} (system_key) WHERE system_key IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_years')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      created_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_years_start ON ${E('ab_led_years')} (start_date)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_periods')} (
      id text PRIMARY KEY,
      year_id text NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'soft_locked', 'locked')),
      changed_by text NULL,
      changed_on timestamptz NULL,
      reason text NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_periods_start ON ${E('ab_led_periods')} (start_date)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_journals')} (
      id text PRIMARY KEY,
      number bigint NOT NULL,
      date date NOT NULL,
      narration text NOT NULL DEFAULT '',
      source_kind text NOT NULL DEFAULT 'manual',
      source_id text NULL,
      reverses text NULL,
      total bigint NOT NULL CHECK (total > 0),
      posted_by text NULL,
      posted_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_journals_number ON ${E('ab_led_journals')} (number)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_journals_reverses ON ${E('ab_led_journals')} (reverses) WHERE reverses IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_led_journals_date ON ${E('ab_led_journals')} (date)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_led_journals_source ON ${E('ab_led_journals')} (source_kind, source_id)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_led_lines')} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      journal_id text NOT NULL,
      line_no integer NOT NULL,
      date date NOT NULL,
      account_id text NOT NULL,
      party_id text NULL,
      debit bigint NOT NULL DEFAULT 0,
      credit bigint NOT NULL DEFAULT 0,
      memo text NOT NULL DEFAULT '',
      CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND debit + credit > 0)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_led_lines_journal ON ${E('ab_led_lines')} (journal_id, line_no)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_led_lines_account ON ${E('ab_led_lines')} (account_id, date)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_led_lines_party ON ${E('ab_led_lines')} (party_id) WHERE party_id IS NOT NULL`,

    // ---- GST reference data: every row dated, with its source and who approved it (draft 11.2)
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_states')} (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'state' CHECK (kind IN ('state', 'ut_with_legislature', 'ut_without_legislature', 'other')),
      uses_utgst boolean NOT NULL DEFAULT false,
      special_category boolean NOT NULL DEFAULT false,
      ${DATED}
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_gst_states_code ON ${E('ab_gst_states')} (code)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_rates')} (
      id text PRIMARY KEY,
      code text NOT NULL,
      description text NOT NULL DEFAULT '',
      kind text NOT NULL CHECK (kind IN ('goods', 'service')),
      condition text NOT NULL DEFAULT '',
      igst_rate numeric(7,3) NOT NULL,
      cgst_rate numeric(7,3) NOT NULL,
      sgst_utgst_rate numeric(7,3) NOT NULL,
      cess_rate_ad_valorem numeric(7,3) NULL,
      cess_specific_amount numeric(18,4) NULL,
      cess_specific_unit text NULL,
      ${DATED}
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_gst_rates_code ON ${E('ab_gst_rates')} (code)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_thresholds')} (
      id text PRIMARY KEY,
      key text NOT NULL,
      description text NOT NULL DEFAULT '',
      value_number numeric(20,4) NULL,
      value_text text NULL,
      ${DATED}
    )`,
    `CREATE INDEX IF NOT EXISTS ab_ix_gst_thresholds_key ON ${E('ab_gst_thresholds')} (key)`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_units')} (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL DEFAULT '',
      ${DATED}
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_rcm')} (
      id text PRIMARY KEY,
      code text NOT NULL,
      description text NOT NULL DEFAULT '',
      kind text NOT NULL CHECK (kind IN ('goods', 'service')),
      supplier_condition text NOT NULL DEFAULT '',
      recipient_condition text NOT NULL DEFAULT '',
      rate_code text NOT NULL DEFAULT '',
      ${DATED}
    )`,

    // ---- master data
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_parties')} (
      id text PRIMARY KEY,
      role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'supplier', 'both')),
      name text NOT NULL,
      gstin text NOT NULL DEFAULT '',
      reg_type text NOT NULL DEFAULT 'unregistered',
      state_code text NOT NULL DEFAULT '',
      country text NOT NULL DEFAULT 'IN',
      address text NOT NULL DEFAULT '',
      pan text NOT NULL DEFAULT '',
      ship_to jsonb NOT NULL DEFAULT '[]'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_items')} (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('goods', 'service')),
      hsn text NOT NULL DEFAULT '',
      uqc text NOT NULL DEFAULT '',
      rate_code text NOT NULL DEFAULT '',
      rate_condition text NOT NULL DEFAULT '',
      supply_class text NOT NULL DEFAULT 'taxable',
      pos_category text NOT NULL DEFAULT 'general',
      rcm_category text NOT NULL DEFAULT '',
      itc_default text NOT NULL DEFAULT 'undecided',
      unit_price numeric(18,4) NULL,
      expense_account text NULL,
      active boolean NOT NULL DEFAULT true,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL
    )`,

    // ---- numbering (G7.6): one counter per series and financial year, taken inside the issuing transaction
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_series')} (
      id text PRIMARY KEY,
      doc_type text NOT NULL,
      name text NOT NULL,
      prefix text NOT NULL DEFAULT '',
      suffix text NOT NULL DEFAULT '',
      padding integer NOT NULL DEFAULT 5,
      is_default boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      created_on timestamptz NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_gst_series_default ON ${E('ab_gst_series')} (doc_type) WHERE is_default AND active`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_series_counters')} (
      series_id text NOT NULL,
      fy text NOT NULL,
      last_value bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (series_id, fy)
    )`,

    // ---- documents
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_documents')} (
      id text PRIMARY KEY,
      doc_type text NOT NULL,
      state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'issued', 'cancelled')),
      number text NULL,
      series_id text NULL,
      fy text NULL,
      date date NOT NULL,
      party_id text NULL,
      input jsonb NOT NULL DEFAULT '{}'::jsonb,
      snapshot jsonb NULL,
      place_of_supply text NULL,
      tax_kind text NULL,
      supply_type text NULL,
      reverse_charge boolean NOT NULL DEFAULT false,
      original_id text NULL,
      reason text NOT NULL DEFAULT '',
      taxable bigint NOT NULL DEFAULT 0,
      cgst bigint NOT NULL DEFAULT 0,
      sgst bigint NOT NULL DEFAULT 0,
      igst bigint NOT NULL DEFAULT 0,
      cess bigint NOT NULL DEFAULT 0,
      round_off bigint NOT NULL DEFAULT 0,
      total bigint NOT NULL DEFAULT 0,
      journal_id text NULL,
      cancel_journal_id text NULL,
      cancelled_on timestamptz NULL,
      cancelled_by text NULL,
      cancel_reason text NULL,
      irn text NULL,
      irn_ack_no text NULL,
      irn_ack_date date NULL,
      irn_qr text NULL,
      eway_no text NULL,
      eway_date date NULL,
      eway_valid_until date NULL,
      vehicle_no text NULL,
      transporter_id text NULL,
      notes text NOT NULL DEFAULT '',
      payment_status text NOT NULL DEFAULT '',
      created_by text NULL,
      created_on timestamptz NOT NULL,
      modified_on timestamptz NOT NULL,
      issued_by text NULL,
      issued_on timestamptz NULL
    )`,
    // G7.6: unique per registration (one per install) and financial year, case-insensitive (a purchase gets an
    // internal number here; the supplier's own invoice number is kept in `input`)
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_gst_documents_number ON ${E('ab_gst_documents')} (fy, lower(number)) WHERE number IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ab_ix_gst_documents_date ON ${E('ab_gst_documents')} (date)`,
    `CREATE INDEX IF NOT EXISTS ab_ix_gst_documents_original ON ${E('ab_gst_documents')} (original_id) WHERE original_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${E('ab_gst_document_lines')} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      document_id text NOT NULL,
      line_no integer NOT NULL,
      item_id text NULL,
      description text NOT NULL DEFAULT '',
      kind text NOT NULL,
      hsn text NOT NULL DEFAULT '',
      uqc text NOT NULL DEFAULT '',
      quantity numeric(18,3) NOT NULL,
      unit_price numeric(18,4) NOT NULL,
      supply_class text NOT NULL,
      gross bigint NOT NULL DEFAULT 0,
      discount bigint NOT NULL DEFAULT 0,
      charges bigint NOT NULL DEFAULT 0,
      taxable bigint NOT NULL DEFAULT 0,
      igst_rate numeric(7,3) NOT NULL DEFAULT 0,
      cgst_rate numeric(7,3) NOT NULL DEFAULT 0,
      sgst_rate numeric(7,3) NOT NULL DEFAULT 0,
      cess_rate numeric(7,3) NOT NULL DEFAULT 0,
      cgst bigint NOT NULL DEFAULT 0,
      sgst bigint NOT NULL DEFAULT 0,
      igst bigint NOT NULL DEFAULT 0,
      cess bigint NOT NULL DEFAULT 0,
      taxed boolean NOT NULL DEFAULT false,
      reverse_charge boolean NOT NULL DEFAULT false,
      itc text NOT NULL DEFAULT '',
      itc_reason text NOT NULL DEFAULT '',
      account_id text NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ab_ux_gst_document_lines ON ${E('ab_gst_document_lines')} (document_id, line_no)`,
  ]
}

/**
 * Upgrade step to 15 (independent): the tables come from environmentDdl (run before the steps); the step checks they
 * exist so a server of version 14 refuses this schema (downgrade guard). Nothing existing changes.
 */
export async function upgradeEnvironmentTo15Ledger(db: SqlDb, schema: string): Promise<void> {
  for (const t of LEDGER_TABLES) {
    const r = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`"${schema}"."${t}"`])
    if (!r[0]?.ok) throw new Error(`table ${schema}.${t} is missing after the schema update`)
  }
}
