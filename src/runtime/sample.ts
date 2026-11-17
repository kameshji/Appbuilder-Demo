/**
 * Sample and blank app definitions. Pure functions: no React, no DOM, no registry access, so the
 * platform can import them for seeding.
 */
import type { AppDef, ControlNode } from '@/contracts'
import { uid } from './util'

const node = (type: string, name: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode => ({
  id: uid(),
  name,
  type,
  props,
  children,
})

const box = (x: number, y: number, w: number, h: number) => ({ X: `=${x}`, Y: `=${y}`, Width: `=${w}`, Height: `=${h}` })
const anchor = (h: string, v = 'Start') => ({ AnchorH: `=Anchor.${h}`, AnchorV: `=Anchor.${v}` })

export function blankApp(name = 'App', width = 1920, height = 1080): AppDef {
  return {
    formatVersion: 2,
    name,
    width,
    height,
    scaleMode: 'responsive',
    theme: { mode: 'light' },
    dataSources: [],
    appProps: { OnStart: '=false' },
    screens: [node('Screen', 'Screen1', { Fill: '=Color.White' })],
  }
}

/**
 * "Contacts app": a 1920x1080 responsive app over the seeded Contacts and Orders tables.
 * Search box, a data table with the filtered contacts, an edit form for the selected contact,
 * and a chart of that contact's orders.
 */
export function sampleApp(): AppDef {
  const muted = '=RGBA(100, 116, 139, 1)'
  const home = node('Screen', 'Home', { Fill: '=RGBA(248, 250, 252, 1)' }, [
    node('Rectangle', 'HeaderBar', { ...box(0, 0, 1920, 80), ...anchor('Stretch'), Fill: '=Color.White', Radius: '=0', BorderWidth: '=0' }),
    node('Rectangle', 'Accent', { ...box(32, 24, 6, 32), Fill: '=RGBA(79, 70, 229, 1)', Radius: '=3' }),
    node('Label', 'Title', { ...box(52, 18, 480, 44), Text: '="Contacts"', Size: '=28', FontWeight: '=FontWeight.Bold' }),
    node('AnimatedIcon', 'TitleHeart', { ...box(176, 22, 36, 36), Icon: '=AnimatedIcon.Heart', Size: '=28', Color: '=RGBA(239, 68, 68, 1)' }),
    node('Label', 'UserLabel', { ...box(1176, 28, 360, 24), ...anchor('End'), Text: '="Signed in as " & User().FullName', Size: '=13', Color: muted, Align: '=Align.Right' }),
    node('Button', 'QuickAddButton', {
      ...box(1560, 20, 152, 40),
      ...anchor('End'),
      Text: '="Quick add"',
      Style: '=ButtonStyle.Outline',
      OnSelect:
        '=Patch(Contacts, Defaults(Contacts), {Name: "New contact " & Text(CountRows(Contacts) + 1), Company: "Unassigned", City: "", Active: true}); Notify("Contact added", NotificationType.Success)',
    }),
    node('Button', 'NewButton', { ...box(1728, 20, 160, 40), ...anchor('End'), Text: '="+ New contact"', OnSelect: '=NewForm(ContactForm)' }),

    node('SearchBox', 'SearchBox', { ...box(32, 104, 520, 40), Placeholder: '="Search name, company or city"' }),
    node('Label', 'CountLabel', { ...box(576, 112, 400, 24), Text: '="Showing " & CountRows(FilteredContacts) & " of " & CountRows(Contacts) & " contacts"', Size: '=13', Color: muted }),
    node('DataTable', 'ContactsTable', {
      ...box(32, 160, 1096, 888),
      ...anchor('Stretch', 'Stretch'),
      Items: '=FilteredContacts',
      Columns: '="Name, Company, City, Email, Status"',
    }),

    node('Container', 'DetailPanel', { ...box(1160, 160, 728, 888), ...anchor('End', 'Stretch'), Fill: '=Color.White', Radius: '=12' }, [
      node('Label', 'DetailTitle', {
        ...box(24, 20, 680, 32),
        ...anchor('Stretch'),
        Text: '=If(ContactForm.Mode = "New", "New contact", Coalesce(ContactsTable.Selected.Name, "Select a contact"))',
        Size: '=20',
        FontWeight: '=FontWeight.Semibold',
      }),
      node('Form', 'ContactForm', {
        ...box(24, 64, 680, 440),
        ...anchor('Stretch'),
        DataSource: '="Contacts"',
        Item: '=ContactsTable.Selected',
        Mode: '=FormMode.Edit',
        Fields: '="Name, Company, City, Email, Active, Status"',
        Columns: '=2',
        OnSuccess: '=Notify("Contact saved", NotificationType.Success)',
        OnFailure: '=Notify(ContactForm.Error, NotificationType.Error)',
      }),
      node('Label', 'OrdersTitle', {
        ...box(24, 528, 680, 28),
        ...anchor('Stretch'),
        Text: '="Orders" & If(IsBlank(ContactsTable.Selected), "", " for " & ContactsTable.Selected.Name)',
        Size: '=16',
        FontWeight: '=FontWeight.Semibold',
      }),
      node('Chart', 'OrdersChart', {
        ...box(24, 568, 680, 296),
        ...anchor('Stretch', 'Stretch'),
        Items: '=Filter(Orders, Customer = ContactsTable.Selected.id)',
        Type: '=ChartType.Bar',
        CategoryField: '="OrderNo"',
        ValueFields: '="Amount"',
      }),
    ]),
  ])

  return {
    formatVersion: 2,
    name: 'Contacts app',
    width: 1920,
    height: 1080,
    scaleMode: 'responsive',
    theme: { mode: 'light' },
    dataSources: ['Contacts', 'Orders'],
    appProps: {
      OnStart: '=Set(StartedAt, Now())',
      Formulas:
        'FilteredContacts = Filter(Contacts, IsBlank(SearchBox.Value) || SearchBox.Value in Name || SearchBox.Value in Company || SearchBox.Value in City);',
    },
    screens: [home],
  }
}
