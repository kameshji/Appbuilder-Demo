/**
 * App templates and seed data. The sample app comes from src/runtime/sample.ts, which is pure (no React or DOM),
 * so the platform core stays testable in plain Node.
 */
import type { AppDef, ControlNode } from '@/contracts'
import { shortId } from './values'
import { sampleApp } from '@/runtime/sample'

const nodeId = () => shortId('n')

const node = (type: string, name: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode => ({
  id: nodeId(),
  name,
  type,
  props,
  children,
})

/** An app with one empty screen. */
export function blankApp(name: string, width: number, height: number): AppDef {
  return {
    formatVersion: 2,
    name,
    width,
    height,
    scaleMode: 'responsive',
    theme: { mode: 'light' },
    dataSources: [],
    appProps: {},
    screens: [node('Screen', 'Screen1', {})],
  }
}

/**
 * The Contacts sample (see sampleApp in src/runtime/sample.ts), sized to the requested design size.
 * The name comes from the argument. The sample is a responsive 1920×1080 design (anchors adapt it to any
 * landscape window), so the requested width/height are intentionally ignored: its coordinates are not size-aware.
 */
export function contactsSampleApp(name: string, _width?: number, _height?: number): AppDef {
  return { ...sampleApp(), name, formatVersion: 2 }
}

/* ------------------------------------------------------------------ seed data */

export const CONTACT_STATUSES = ['Lead', 'Customer', 'Partner', 'Churned']
export const ORDER_STATUSES = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled']

export const SEED_CONTACTS: Array<{ Name: string; Company: string; City: string; Email: string; Active: boolean; Status: string }> = [
  { Name: 'Asha Rao', Company: 'Northwind', City: 'Pune', Email: 'asha.rao@northwind.example', Active: true, Status: 'Customer' },
  { Name: 'Ben Carter', Company: 'Contoso Labs', City: 'Austin', Email: 'ben.carter@contoso-labs.example', Active: true, Status: 'Lead' },
  { Name: 'Chitra Menon', Company: 'Fabrikam', City: 'Kochi', Email: 'chitra.menon@fabrikam.example', Active: false, Status: 'Churned' },
  { Name: 'Dmitri Volkov', Company: 'Tailspin', City: 'Riga', Email: 'dmitri.volkov@tailspin.example', Active: true, Status: 'Partner' },
  { Name: 'Elena Rossi', Company: 'Wingtip', City: 'Milan', Email: 'elena.rossi@wingtip.example', Active: true, Status: 'Customer' },
  { Name: 'Farid Khan', Company: 'Adventure Works', City: 'Dubai', Email: 'farid.khan@adventure-works.example', Active: false, Status: 'Lead' },
  { Name: 'Grace Liu', Company: 'Litware', City: 'Singapore', Email: 'grace.liu@litware.example', Active: true, Status: 'Customer' },
  { Name: 'Hiro Tanaka', Company: 'Proseware', City: 'Osaka', Email: 'hiro.tanaka@proseware.example', Active: true, Status: 'Partner' },
]

/** customer = index into SEED_CONTACTS */
export const SEED_ORDERS: Array<{ customer: number; amount: number; date: string; status: string }> = [
  { customer: 0, amount: 1250, date: '2026-01-05', status: 'Delivered' },
  { customer: 1, amount: 480.5, date: '2026-01-12', status: 'Delivered' },
  { customer: 4, amount: 2310, date: '2026-01-19', status: 'Shipped' },
  { customer: 6, amount: 89.99, date: '2026-01-27', status: 'Delivered' },
  { customer: 0, amount: 640, date: '2026-02-03', status: 'Processing' },
  { customer: 3, amount: 5200, date: '2026-02-10', status: 'Shipped' },
  { customer: 7, amount: 310.75, date: '2026-02-14', status: 'Delivered' },
  { customer: 4, amount: 1180, date: '2026-02-21', status: 'New' },
  { customer: 2, amount: 75, date: '2026-02-25', status: 'Cancelled' },
  { customer: 6, amount: 960, date: '2026-03-02', status: 'Processing' },
  { customer: 1, amount: 2750.25, date: '2026-03-09', status: 'New' },
  { customer: 5, amount: 420, date: '2026-03-16', status: 'New' },
]
