/**
 * App templates and seed data. Self-contained on purpose (no import from the runtime) so the
 * platform core stays testable in plain Node.
 */
import type { AppDef, ControlNode } from '@/contracts'
import { shortId } from './values'

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
 * The Contacts sample, bound to the platform table "Contacts" (no OnStart collection).
 * Laid out for a 960x600 reference grid and scaled to the requested design size.
 */
export function contactsSampleApp(name: string, width: number, height: number): AppDef {
  const sx = width / 960
  const sy = height / 600
  const k = Math.min(sx, sy)
  const X = (n: number) => Math.round(n * sx)
  const Y = (n: number) => Math.round(n * sy)
  const F = (n: number) => `=${Math.round(n * k)}`
  const box = (x: number, y: number, w: number, h: number) => ({ X: `=${X(x)}`, Y: `=${Y(y)}`, Width: `=${X(w)}`, Height: `=${Y(h)}` })
  const muted = '=RGBA(113, 113, 122, 1)'

  const home = node('Screen', 'Home', { Fill: '=RGBA(250, 250, 251, 1)' }, [
    node('Rectangle', 'Accent', { ...box(24, 22, 5, 30), Fill: '=RGBA(79, 70, 229, 1)', Radius: '=3' }),
    node('Label', 'Title', { ...box(40, 16, 480, 40), Text: '="Contacts"', Size: F(26), FontWeight: '=FontWeight.Bold' }),
    node('Button', 'AddButton', { ...box(780, 18, 156, 36), Text: '="+ Add contact"', OnSelect: '=Navigate(AddScreen)' }),
    node('TextInput', 'SearchBox', { ...box(24, 72, 420, 40), Placeholder: '="Search by name or company"' }),
    node('Label', 'ResultCount', {
      ...box(24, 120, 420, 24),
      Text: '="Showing " & CountRows(ContactList.Items) & " of " & CountRows(Contacts) & " contacts"',
      Size: F(12),
      Color: muted,
    }),
    node(
      'Gallery',
      'ContactList',
      {
        ...box(24, 152, 420, 424),
        Items: '=Filter(Contacts, SearchBox.Value in Name || SearchBox.Value in Company)',
        TemplateHeight: `=${Y(64)}`,
        Gap: `=${Y(4)}`,
      },
      [
        node('Label', 'RowName', { ...box(16, 10, 280, 24), Text: '=ThisItem.Name', Size: F(15), FontWeight: '=FontWeight.Semibold' }),
        node('Label', 'RowCompany', {
          ...box(16, 34, 300, 20),
          Text: '=ThisItem.Company & " · " & ThisItem.City',
          Size: F(12),
          Color: muted,
        }),
        node('Button', 'RowDelete', {
          ...box(340, 16, 68, 32),
          Text: '="Delete"',
          Style: '=ButtonStyle.Ghost',
          Size: F(12),
          OnSelect: '=Remove(Contacts, ThisItem)',
        }),
      ],
    ),
    node('Container', 'DetailPanel', { ...box(468, 152, 468, 424) }, [
      node('Label', 'DetailHeading', { ...box(24, 20, 300, 20), Text: '="DETAILS"', Size: F(11), Color: muted, FontWeight: '=FontWeight.Semibold' }),
      node('Label', 'DetailName', {
        ...box(24, 48, 420, 40),
        Text: '=If(IsBlank(ContactList.Selected), "Select a contact", ContactList.Selected.Name)',
        Size: F(24),
        FontWeight: '=FontWeight.Bold',
      }),
      node('Label', 'DetailCompany', { ...box(24, 104, 420, 24), Text: '="Company: " & ContactList.Selected.Company', Size: F(14) }),
      node('Label', 'DetailCity', { ...box(24, 136, 420, 24), Text: '="City: " & ContactList.Selected.City', Size: F(14) }),
      node('Label', 'DetailEmail', { ...box(24, 168, 420, 24), Text: '="Email: " & ContactList.Selected.Email', Size: F(14) }),
      node('Label', 'DetailStatus', {
        ...box(24, 208, 160, 28),
        Text: '=If(ContactList.Selected.Active, "Active", "Inactive")',
        Size: F(12),
        FontWeight: '=FontWeight.Semibold',
        Align: '=Align.Center',
        Color: '=If(ContactList.Selected.Active, RGBA(21, 128, 61, 1), RGBA(161, 98, 7, 1))',
        Fill: '=If(ContactList.Selected.Active, RGBA(220, 252, 231, 1), RGBA(254, 243, 199, 1))',
        Visible: '=!IsBlank(ContactList.Selected)',
      }),
    ]),
  ])

  const add = node('Screen', 'AddScreen', { Fill: '=RGBA(250, 250, 251, 1)' }, [
    node('Label', 'AddTitle', { ...box(24, 20, 480, 40), Text: '="New contact"', Size: F(26), FontWeight: '=FontWeight.Bold' }),
    node('TextInput', 'NameInput', { ...box(24, 84, 360, 40), Placeholder: '="Full name"' }),
    node('TextInput', 'CompanyInput', { ...box(24, 140, 360, 40), Placeholder: '="Company"' }),
    node('TextInput', 'CityInput', { ...box(24, 196, 360, 40), Placeholder: '="City"' }),
    node('TextInput', 'EmailInput', { ...box(24, 252, 360, 40), Placeholder: '="Email"' }),
    node('Toggle', 'ActiveToggle', { ...box(24, 312, 200, 32), Text: '="Active"', Default: '=true' }),
    node('Button', 'SaveButton', {
      ...box(24, 368, 120, 40),
      Text: '="Save"',
      OnSelect:
        '=Patch(Contacts, Defaults(Contacts), {Name: NameInput.Value, Company: CompanyInput.Value, City: CityInput.Value, Email: EmailInput.Value, Active: ActiveToggle.Value, Status: "Lead"}); Reset(NameInput); Reset(CompanyInput); Reset(CityInput); Reset(EmailInput); Reset(ActiveToggle); Notify("Saved", NotificationType.Success); Back()',
    }),
    node('Button', 'CancelButton', { ...box(156, 368, 120, 40), Text: '="Cancel"', Style: '=ButtonStyle.Outline', OnSelect: '=Back()' }),
  ])

  return {
    formatVersion: 2,
    name,
    width,
    height,
    scaleMode: 'responsive',
    theme: { mode: 'light' },
    dataSources: ['Contacts'],
    appProps: {},
    screens: [home, add],
  }
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
