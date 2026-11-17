import { describe, expect, it } from 'vitest'
import { contacts, err, fakeHost, val } from './testutil'

const NO_HOST = 'Behaviour function in a non-behaviour property'

describe('new behaviour functions without a host', () => {
  it('all error with the standard message', () => {
    const fns = ['SubmitForm(F)', 'ResetForm(F)', 'NewForm(F)', 'EditForm(F)', 'ViewForm(F)', 'Select(B)', 'SetFocus(B)', 'Launch("x")', 'Download("x")', 'Copy("x")', 'Trace("x")', 'Trace("x", 1)', 'Exit()', 'Refresh(T)', 'Concurrent(1, 2)']
    for (const f of fns) expect(err('=' + f, { T: [] }).message, f).toBe(NO_HOST)
  })
  it('the error points at the function name', () => {
    const e = err('=1 + Launch("x")')
    expect([e.start, e.end]).toEqual([5, 11])
    const f = err('=Concurrent(1, 2)')
    expect([f.start, f.end]).toEqual([1, 11])
  })
  it('IfError does not swallow it', () => {
    expect(err('=IfError(Exit(), 1)').message).toBe(NO_HOST)
    expect(err('=IsError(Copy("x"))').message).toBe(NO_HOST)
  })
})

describe('form actions', () => {
  it('map to host.form', () => {
    const { host, calls } = fakeHost()
    val('=SubmitForm(Form1); ResetForm(Form1); NewForm(Form2); EditForm(Form2); ViewForm(Form3)', {}, host)
    expect(calls).toEqual([
      { fn: 'form', args: ['submit', 'Form1'] },
      { fn: 'form', args: ['reset', 'Form1'] },
      { fn: 'form', args: ['new', 'Form2'] },
      { fn: 'form', args: ['edit', 'Form2'] },
      { fn: 'form', args: ['view', 'Form3'] },
    ])
  })
  it('take the form name as a bare identifier even when it resolves to a record', () => {
    const { host, calls } = fakeHost()
    val('=SubmitForm(Form1)', { Form1: { Valid: true } }, host)
    expect(calls).toEqual([{ fn: 'form', args: ['submit', 'Form1'] }])
  })
  it('accept text names', () => {
    const { host, calls } = fakeHost()
    val('=EditForm("Form9")', {}, host)
    expect(calls).toEqual([{ fn: 'form', args: ['edit', 'Form9'] }])
  })
  it('need exactly one argument', () => {
    const { host } = fakeHost()
    expect(err('=SubmitForm()', {}, host).message).toBe('SubmitForm needs 1 argument')
    expect(err('=NewForm(A, B)', {}, host).message).toBe('NewForm takes at most 1 argument')
  })
  it('a blank text name is an error', () => {
    const { host, calls } = fakeHost()
    expect(err('=ResetForm("")', {}, host).message).toBe('A name is needed here')
    expect(calls).toEqual([])
  })
  it('typical Save button', () => {
    const { host, calls } = fakeHost()
    val('=If(Form1.Valid, SubmitForm(Form1), Notify("Fix the errors", NotificationType.Warning))', { Form1: { Valid: true } }, host)
    val('=If(Form1.Valid, SubmitForm(Form1), Notify("Fix the errors", NotificationType.Warning))', { Form1: { Valid: false } }, host)
    expect(calls.map((c) => c.fn)).toEqual(['form', 'notify'])
  })
})

describe('Select / SetFocus', () => {
  it('Select(Button1)', () => {
    const { host, calls } = fakeHost()
    val('=Select(Button1)', {}, host)
    expect(calls).toEqual([{ fn: 'select', args: ['Button1'] }])
  })
  it('SetFocus(TextInput1)', () => {
    const { host, calls } = fakeHost()
    val('=SetFocus(TextInput1)', { TextInput1: { Value: 'x' } }, host)
    expect(calls).toEqual([{ fn: 'setFocus', args: ['TextInput1'] }])
  })
  it('chain with others', () => {
    const { host, calls } = fakeHost()
    val('=Reset(Name); SetFocus(Name); Select(Save)', {}, host)
    expect(calls.map((c) => c.fn)).toEqual(['reset', 'setFocus', 'select'])
  })
  it('argument counts', () => {
    const { host } = fakeHost()
    expect(err('=Select()', {}, host).message).toBe('Select needs 1 argument')
    expect(err('=SetFocus()', {}, host).message).toBe('SetFocus needs 1 argument')
  })
})

describe('Launch / Download / Copy', () => {
  it('Launch passes the url text', () => {
    const { host, calls } = fakeHost()
    val('=Launch("https://example.com/a?b=1")', {}, host)
    val('=Launch("https://example.com/" & EncodeUrl("a b"))', {}, host)
    expect(calls).toEqual([
      { fn: 'launch', args: ['https://example.com/a?b=1'] },
      { fn: 'launch', args: ['https://example.com/a%20b'] },
    ])
  })
  it('Download uses host.launch', () => {
    const { host, calls } = fakeHost()
    val('=Download("/files/report.csv")', {}, host)
    expect(calls).toEqual([{ fn: 'launch', args: ['/files/report.csv'] }])
  })
  it('Copy sends text to the clipboard', () => {
    const { host, calls } = fakeHost()
    val('=Copy("hello " & Name)', { Name: 'Asha' }, host)
    val('=Copy(42)', {}, host)
    expect(calls).toEqual([{ fn: 'copy', args: ['hello Asha'] }, { fn: 'copy', args: ['42'] }])
  })
  it('return blank', () => {
    const { host } = fakeHost()
    expect(val('=Launch("x")', {}, host)).toBeNull()
    expect(val('=Copy("x")', {}, host)).toBeNull()
    expect(val('=Download("x")', {}, host)).toBeNull()
  })
  it('errors in the argument stop the call', () => {
    const { host, calls } = fakeHost()
    expect(err('=Launch(1 / 0)', {}, host).message).toBe("Can't divide by zero")
    expect(calls).toEqual([])
  })
})

describe('Trace / Exit / Refresh', () => {
  it('Trace with and without data', () => {
    const { host, calls } = fakeHost()
    val('=Trace("hello")', {}, host)
    val('=Trace("with data", {a: 1})', {}, host)
    val('=Trace("count", CountRows(Contacts))', { Contacts: contacts() }, host)
    expect(calls).toEqual([
      { fn: 'trace', args: ['hello'] },
      { fn: 'trace', args: ['with data', { a: 1 }] },
      { fn: 'trace', args: ['count', 4] },
    ])
  })
  it('Exit()', () => {
    const { host, calls } = fakeHost()
    val('=Exit()', {}, host)
    expect(calls).toEqual([{ fn: 'exit', args: [] }])
    expect(err('=Exit(1)', {}, host).message).toBe("Exit doesn't take any arguments")
  })
  it('Refresh(Table) now calls host.refresh', () => {
    const { host, calls } = fakeHost()
    val('=Refresh(Contacts)', { Contacts: contacts() }, host)
    val('=Refresh("Orders")', {}, host)
    expect(calls).toEqual([{ fn: 'refresh', args: ['Contacts'] }, { fn: 'refresh', args: ['Orders'] }])
  })
  it('Refresh does not read the table', () => {
    const { host, calls } = fakeHost()
    val('=Refresh(NotLoadedYet)', {}, host)
    expect(calls).toEqual([{ fn: 'refresh', args: ['NotLoadedYet'] }])
  })
})

describe('Concurrent', () => {
  it('evaluates every argument in order', () => {
    const { host, calls } = fakeHost()
    val('=Concurrent(Set(a, 1), Set(b, 2), Collect(L, {x: 1}))', {}, host)
    expect(calls.map((c) => c.fn)).toEqual(['setVar', 'setVar', 'collect'])
  })
  it('later arguments see nothing special but still run after a failure', () => {
    const { host, calls } = fakeHost()
    const e = err('=Concurrent(Set(a, 1 / 0), Set(b, 2), Set(c, 3))', {}, host)
    expect(e.message).toBe("Can't divide by zero")
    expect(calls).toEqual([{ fn: 'setVar', args: ['b', 2] }, { fn: 'setVar', args: ['c', 3] }])
  })
  it('the first failure is the one reported', () => {
    const { host } = fakeHost()
    expect(err('=Concurrent(Error("one"), Error("two"))', {}, host).message).toBe('one')
  })
  it('fatal errors stop immediately', () => {
    const { host, calls } = fakeHost()
    expect(err('=Concurrent(Nope, Set(b, 2))', {}, host).message).toBe("Name isn't recognised: Nope")
    expect(calls).toEqual([])
  })
  it('returns blank and works inside a chain', () => {
    const { host, calls } = fakeHost()
    expect(val('=Concurrent(Back(), Back()); 7', {}, host)).toBe(7)
    expect(calls).toHaveLength(2)
  })
  it('IfError can handle a failed Concurrent', () => {
    const { host } = fakeHost()
    expect(val('=IfError(Concurrent(Error("x")), "recovered")', {}, host)).toBe('recovered')
  })
  it('needs at least one argument', () => {
    const { host } = fakeHost()
    expect(err('=Concurrent()', {}, host).message).toBe('Concurrent needs at least 1 argument')
  })
})

describe('behaviour functions are listed', () => {
  it('as behaviour kind', async () => {
    const { functions } = await import('./index')
    const docs = new Map(functions().map((f) => [f.name, f]))
    for (const n of ['SubmitForm', 'ResetForm', 'NewForm', 'EditForm', 'ViewForm', 'Select', 'SetFocus', 'Launch', 'Download', 'Copy', 'Trace', 'Exit', 'Refresh', 'Concurrent']) {
      expect(docs.get(n)?.kind, n).toBe('behaviour')
    }
  })
})
