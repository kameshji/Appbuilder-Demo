import type { AppDef, ControlNode, FxRecord } from '@/contracts'
import { uid } from './util'

const node = (type: string, name: string, props: Record<string, string>, children: ControlNode[] = []): ControlNode => ({
  id: uid(),
  name,
  type,
  props,
  children,
})

const box = (x: number, y: number, w: number, h: number) => ({ X: `=${x}`, Y: `=${y}`, Width: `=${w}`, Height: `=${h}` })

const CONTACTS: Array<[string, string, string, boolean]> = [
  ['Asha Rao', 'Northwind', 'Pune', true],
  ['Ben Carter', 'Contoso Labs', 'Austin', true],
  ['Chitra Menon', 'Fabrikam', 'Kochi', false],
  ['Dmitri Volkov', 'Tailspin', 'Riga', true],
  ['Elena Rossi', 'Wingtip', 'Milan', true],
  ['Farid Khan', 'Adventure Works', 'Dubai', false],
  ['Grace Liu', 'Litware', 'Singapore', true],
  ['Hiro Tanaka', 'Proseware', 'Osaka', true],
]

const rec = (r: [string, string, string, boolean]) => `{Name:"${r[0]}", Company:"${r[1]}", City:"${r[2]}", Active:${r[3]}}`

export const SAMPLE_ONSTART = `=ClearCollect(Contacts, Table(${CONTACTS.map(rec).join(', ')}))`

export function sampleCollections(): Record<string, FxRecord[]> {
  return {
    Contacts: CONTACTS.map((r) => ({ Name: r[0], Company: r[1], City: r[2], Active: r[3], __id: uid() })),
  }
}

export function sampleApp(): AppDef {
  const muted = '=RGBA(113, 113, 122, 1)'
  const home = node('Screen', 'Home', { Fill: '=RGBA(250, 250, 251, 1)' }, [
    node('Rectangle', 'Accent', { ...box(24, 22, 5, 30), Fill: '=RGBA(79, 70, 229, 1)', Radius: '=3' }),
    node('Label', 'Title', { ...box(40, 16, 480, 40), Text: '="Contacts"', Size: '=26', FontWeight: '=FontWeight.Bold' }),
    node('Button', 'AddButton', { ...box(780, 18, 156, 36), Text: '="+ Add contact"', OnSelect: '=Navigate(AddScreen)' }),
    node('TextInput', 'SearchBox', { ...box(24, 72, 420, 40), Placeholder: '="Search by name or company"' }),
    node('Label', 'ResultCount', {
      ...box(24, 120, 420, 24),
      Text: '="Showing " & CountRows(ContactList.Items) & " of " & CountRows(Contacts) & " contacts"',
      Size: '=12',
      Color: muted,
    }),
    node(
      'Gallery',
      'ContactList',
      {
        ...box(24, 152, 420, 424),
        Items: '=Filter(Contacts, SearchBox.Value in Name || SearchBox.Value in Company)',
        TemplateHeight: '=64',
        Gap: '=4',
      },
      [
        node('Label', 'RowName', { ...box(16, 10, 280, 24), Text: '=ThisItem.Name', Size: '=15', FontWeight: '=FontWeight.Semibold' }),
        node('Label', 'RowCompany', {
          ...box(16, 34, 300, 20),
          Text: '=ThisItem.Company & " · " & ThisItem.City',
          Size: '=12',
          Color: muted,
        }),
        node('Button', 'RowDelete', {
          ...box(340, 16, 68, 32),
          Text: '="Delete"',
          Style: '=ButtonStyle.Ghost',
          Size: '=12',
          OnSelect: '=Remove(Contacts, ThisItem)',
        }),
      ],
    ),
    node('Container', 'DetailPanel', { ...box(468, 152, 468, 424) }, [
      node('Label', 'DetailHeading', { ...box(24, 20, 300, 20), Text: '="DETAILS"', Size: '=11', Color: muted, FontWeight: '=FontWeight.Semibold' }),
      node('Label', 'DetailName', {
        ...box(24, 48, 420, 40),
        Text: '=If(IsBlank(ContactList.Selected), "Select a contact", ContactList.Selected.Name)',
        Size: '=24',
        FontWeight: '=FontWeight.Bold',
      }),
      node('Label', 'DetailCompany', { ...box(24, 104, 420, 24), Text: '="Company: " & ContactList.Selected.Company', Size: '=14' }),
      node('Label', 'DetailCity', { ...box(24, 136, 420, 24), Text: '="City: " & ContactList.Selected.City', Size: '=14' }),
      node('Label', 'DetailStatus', {
        ...box(24, 176, 160, 28),
        Text: '=If(ContactList.Selected.Active, "Active", "Inactive")',
        Size: '=12',
        FontWeight: '=FontWeight.Semibold',
        Align: '=Align.Center',
        Color: '=If(ContactList.Selected.Active, RGBA(21, 128, 61, 1), RGBA(161, 98, 7, 1))',
        Fill: '=If(ContactList.Selected.Active, RGBA(220, 252, 231, 1), RGBA(254, 243, 199, 1))',
        Visible: '=!IsBlank(ContactList.Selected)',
      }),
    ]),
  ])

  const add = node('Screen', 'AddScreen', { Fill: '=RGBA(250, 250, 251, 1)' }, [
    node('Label', 'AddTitle', { ...box(24, 20, 480, 40), Text: '="New contact"', Size: '=26', FontWeight: '=FontWeight.Bold' }),
    node('TextInput', 'NameInput', { ...box(24, 84, 360, 40), Placeholder: '="Full name"' }),
    node('TextInput', 'CompanyInput', { ...box(24, 140, 360, 40), Placeholder: '="Company"' }),
    node('TextInput', 'CityInput', { ...box(24, 196, 360, 40), Placeholder: '="City"' }),
    node('Toggle', 'ActiveToggle', { ...box(24, 256, 200, 32), Text: '="Active"', Default: '=true' }),
    node('Button', 'SaveButton', {
      ...box(24, 312, 120, 40),
      Text: '="Save"',
      OnSelect:
        '=Patch(Contacts, Defaults(Contacts), {Name: NameInput.Value, Company: CompanyInput.Value, City: CityInput.Value, Active: ActiveToggle.Value}); Reset(NameInput); Reset(CompanyInput); Reset(CityInput); Reset(ActiveToggle); Notify("Saved", NotificationType.Success); Back()',
    }),
    node('Button', 'CancelButton', { ...box(156, 312, 120, 40), Text: '="Cancel"', Style: '=ButtonStyle.Outline', OnSelect: '=Back()' }),
  ])

  return {
    formatVersion: 1,
    name: 'Contacts app',
    width: 960,
    height: 600,
    appProps: { OnStart: SAMPLE_ONSTART },
    screens: [home, add],
  }
}
