/**
 * The common business model (P0 package N, docs/guide/maker/core-data-model.md): Accounts, Contacts, Addresses,
 * Products, Price lists (+ items) and Tax codes, shared by the CRM and ERP templates. NOT installed by default: it is a
 * versioned solution package (stable ids, so a later version upgrades it in place) that templates depend on and an
 * administrator installs through the normal solution import (plan, confirm, one transaction).
 *
 * Tax codes carry structure only (code, name, description): no GST rates or rules until the reviewed GST spec exists
 * (docs/plan/master-plan.md section 10).
 *
 *   GET /api/v1/templates/business-model      the package (YAML), makers
 */
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import type { Router, Services } from '../../core/contracts.ts'
import { PACKAGE_VERSION } from './packages.ts'
import { systemColumns, toYaml } from './util.ts'

export const BUSINESS_MODEL_SOLUTION_ID = 'sol_core_business_model'
export const BUSINESS_MODEL_VERSION = '1.0.0'

const c = (name: string, displayName: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName, type, ...extra })
const look = (name: string, displayName: string, table: string, extra: Partial<ColumnDef> = {}) => c(name, displayName, 'lookup', { lookupTable: table, ...extra })

const TABLES: { id: string; name: string; displayName: string; primary: string; description: string; columns: ColumnDef[]; uniqueTogether?: string[][] }[] = [
  {
    id: 'tbl_cbm_accounts', name: 'Accounts', displayName: 'Accounts', primary: 'Name', description: 'Organisations you do business with: customers, suppliers, partners.',
    columns: [
      c('Name', 'Name', 'text', { required: true, indexed: true }), c('AccountNumber', 'Account number', 'autonumber', { prefix: 'ACC-' }),
      c('Type', 'Type', 'choice', { choices: ['Customer', 'Supplier', 'Partner', 'Other'], default: 'Customer' }),
      c('Email', 'Email', 'email'), c('Phone', 'Phone', 'phone'), c('Website', 'Website', 'url'),
      c('Gstin', 'GSTIN', 'text'), c('Pan', 'PAN', 'text'), c('Industry', 'Industry', 'text'),
      look('Currency', 'Currency', 'Currencies'), c('PaymentTermsDays', 'Payment terms (days)', 'number'), c('CreditLimit', 'Credit limit', 'currency'),
      c('Status', 'Status', 'choice', { choices: ['Active', 'Inactive'], default: 'Active' }), look('ParentAccount', 'Parent account', 'Accounts'),
    ],
  },
  {
    id: 'tbl_cbm_contacts', name: 'Contacts', displayName: 'Contacts', primary: 'FullName', description: 'People at your accounts.',
    columns: [
      c('FullName', 'Full name', 'text', { required: true, indexed: true }), look('Account', 'Account', 'Accounts'), c('JobTitle', 'Job title', 'text'),
      c('Email', 'Email', 'email'), c('Phone', 'Phone', 'phone'), c('Mobile', 'Mobile', 'phone'), c('IsPrimary', 'Primary contact', 'boolean', { default: 'false' }),
    ],
  },
  {
    id: 'tbl_cbm_addresses', name: 'Addresses', displayName: 'Addresses', primary: 'Line1', description: 'Billing, shipping and registered-office addresses of accounts and contacts.',
    columns: [
      look('Account', 'Account', 'Accounts'), look('Contact', 'Contact', 'Contacts'),
      c('Kind', 'Kind', 'choice', { choices: ['Billing', 'Shipping', 'Registered office', 'Other'], default: 'Billing' }),
      c('Line1', 'Address line 1', 'text', { required: true }), c('Line2', 'Address line 2', 'text'), c('City', 'City', 'text'), c('PostalCode', 'PIN / postal code', 'text'),
      look('State', 'State', 'States'), look('Country', 'Country', 'Countries'), c('IsDefault', 'Default', 'boolean', { default: 'false' }),
    ],
  },
  {
    id: 'tbl_cbm_tax_codes', name: 'TaxCodes', displayName: 'Tax codes', primary: 'Code', description: 'Tax codes (structure only: rates and rules come with the reviewed GST specification).',
    columns: [c('Code', 'Code', 'text', { required: true, unique: true }), c('Name', 'Name', 'text'), c('Description', 'Description', 'multiline'), c('IsActive', 'Active', 'boolean', { default: 'true' })],
  },
  {
    id: 'tbl_cbm_products', name: 'Products', displayName: 'Products', primary: 'Name', description: 'Goods and services you buy or sell.',
    columns: [
      c('Code', 'Code', 'text', { required: true, unique: true }), c('Name', 'Name', 'text', { required: true, indexed: true }),
      c('Kind', 'Kind', 'choice', { choices: ['Goods', 'Service'], default: 'Goods' }), c('Description', 'Description', 'multiline'),
      look('Unit', 'Unit', 'UnitsOfMeasure'), c('HsnSac', 'HSN / SAC', 'text'), look('TaxCode', 'Tax code', 'TaxCodes'),
      c('StandardPrice', 'Standard price', 'currency'), c('IsActive', 'Active', 'boolean', { default: 'true' }),
    ],
  },
  {
    id: 'tbl_cbm_price_lists', name: 'PriceLists', displayName: 'Price lists', primary: 'Name', description: 'Named price lists in a currency, valid for a period.',
    columns: [c('Name', 'Name', 'text', { required: true, unique: true }), look('Currency', 'Currency', 'Currencies'), c('ValidFrom', 'Valid from', 'date'), c('ValidTo', 'Valid to', 'date'), c('IsDefault', 'Default', 'boolean', { default: 'false' })],
  },
  {
    id: 'tbl_cbm_price_list_items', name: 'PriceListItems', displayName: 'Price list items', primary: 'Product', description: 'The price of a product in a price list.',
    columns: [look('PriceList', 'Price list', 'PriceLists', { required: true }), look('Product', 'Product', 'Products', { required: true }), c('UnitPrice', 'Unit price', 'currency', { required: true }), c('MinQuantity', 'Minimum quantity', 'decimal')],
    uniqueTogether: [['PriceList', 'Product']],
  },
]

/** the table definitions of the package (system columns included) */
export function businessModelTables(now = new Date().toISOString()): TableDef[] {
  return TABLES.map((t) => ({
    id: t.id, name: t.name, displayName: t.displayName, description: t.description, primaryColumn: t.primary,
    columns: [...systemColumns(), ...t.columns.map((x) => ({ ...x }))], createdOn: now, modifiedOn: now,
    ...(t.uniqueTogether ? { uniqueTogether: t.uniqueTogether } : {}),
  }))
}

/** the solution package (YAML), ready for POST /solutions/import/plan and /solutions/import */
export function businessModelPackage(now = new Date().toISOString()): string {
  return toYaml({
    kind: 'appbuilder/solution', packageVersion: PACKAGE_VERSION, exportedOn: now,
    solution: {
      id: BUSINESS_MODEL_SOLUTION_ID, name: 'CoreBusinessModel', displayName: 'Common business model', publisher: 'Appbuilder', version: BUSINESS_MODEL_VERSION,
      description: 'Accounts, contacts, addresses, products, price lists and tax codes shared by the CRM and ERP templates.',
    },
    apps: [],
    tables: businessModelTables(now).map((def) => ({ schema: def, events: [] })),
    roles: [], connections: [], files: [],
  })
}

export function registerBusinessModelRoutes(router: Router, s: Services): void {
  void s
  router.add('GET', '/api/v1/templates/business-model', async () => ({ yaml: businessModelPackage(), id: BUSINESS_MODEL_SOLUTION_ID, version: BUSINESS_MODEL_VERSION }), { auth: 'maker' })
}
