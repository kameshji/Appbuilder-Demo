import { describe, expect, it } from 'vitest'
import { contacts, err, fakeHost, val } from './testutil.ts'

const C = () => ({ Contacts: contacts() })

describe('behaviour functions without a host', () => {
  it('error with the behaviour message', () => {
    for (const f of ['Set(x, 1)', 'UpdateContext({a: 1})', 'Collect(C, {a: 1})', 'ClearCollect(C, [])', 'Clear(C)', 'Remove(C, {a: 1})', 'RemoveIf(C, true)', 'Patch(C, {}, {a: 1})', 'UpdateIf(C, true, {a: 1})', 'Navigate(S)', 'Back()', 'Notify("x")', 'Reset(T)', 'Refresh(C)']) {
      expect(err('=' + f, { C: [] }).message).toBe('Behaviour function in a non-behaviour property')
    }
  })
  it('points at the function name', () => {
    const e = err('=1 + Set(x, 1)')
    expect(e.start).toBe(5)
    expect(e.end).toBe(8)
  })
  it('chaining needs a host too', () => {
    expect(err('=1; 2').message).toMatch(/behaviour/)
  })
  it('IfError does not swallow it', () => {
    expect(err('=IfError(Back(), 1)').message).toBe('Behaviour function in a non-behaviour property')
  })
})

describe('behaviour functions with a host', () => {
  it('Set takes the name unevaluated', () => {
    const { host, calls } = fakeHost()
    val('=Set(counter, 5)', {}, host)
    expect(calls).toEqual([{ fn: 'setVar', args: ['counter', 5] }])
  })
  it('Set with a variable that already exists still uses the name', () => {
    const { host, calls } = fakeHost()
    val('=Set(counter, counter + 1)', { counter: 1 }, host)
    expect(calls[0]).toEqual({ fn: 'setVar', args: ['counter', 2] })
  })
  it('chain returns the last value and runs in order', () => {
    const { host, calls } = fakeHost()
    expect(val('=Set(a, 1); Set(b, 2); 42', {}, host)).toBe(42)
    expect(calls.map((c) => c.fn)).toEqual(['setVar', 'setVar'])
  })
  it('later steps see earlier Set within the same evaluation', () => {
    const { host } = fakeHost()
    expect(val('=Set(x, 10); x * 2', {}, host)).toBe(20)
    expect(val('=UpdateContext({y: 3}); y + 1', {}, host)).toBe(4)
  })
  it('trailing semicolon is fine', () => {
    const { host, calls } = fakeHost()
    val('=Back();', {}, host)
    expect(calls).toEqual([{ fn: 'back', args: [] }])
  })
  it('UpdateContext', () => {
    const { host, calls } = fakeHost()
    val('=UpdateContext({a: 1, b: "x"})', {}, host)
    expect(calls).toEqual([{ fn: 'updateContext', args: [{ a: 1, b: 'x' }] }])
  })
  it('Collect / ClearCollect flatten items and drop __id', () => {
    const { host, calls } = fakeHost()
    val('=Collect(Cart, {a: 1}, {a: 2})', {}, host)
    val('=ClearCollect(Cart, Filter(Contacts, Active))', C(), host)
    val('=Collect(Cart, 5)', {}, host)
    expect(calls[0]).toEqual({ fn: 'collect', args: ['Cart', [{ a: 1 }, { a: 2 }], false] })
    const second = calls[1]!.args as [string, Record<string, unknown>[], boolean]
    expect(second[0]).toBe('Cart')
    expect(second[2]).toBe(true)
    expect(second[1]).toHaveLength(3)
    expect(second[1].every((r) => !('__id' in r))).toBe(true)
    expect(calls[2]).toEqual({ fn: 'collect', args: ['Cart', [{ Value: 5 }], false] })
  })
  it('ClearCollect with Table(...) like the sample OnStart', () => {
    const { host, calls } = fakeHost()
    val('=ClearCollect(Contacts, Table({Name: "A", Active: true}, {Name: "B", Active: false}))', {}, host)
    expect(calls[0]).toEqual({ fn: 'collect', args: ['Contacts', [{ Name: 'A', Active: true }, { Name: 'B', Active: false }], true] })
  })
  it('collection reads reflect earlier writes in the same chain', () => {
    const { host } = fakeHost()
    expect(val('=ClearCollect(L, [1, 2]); Collect(L, 3); CountRows(L)', {}, host)).toBe(3)
    expect(val('=Clear(L); CountRows(L)', { L: [{ a: 1 }] }, host)).toBe(0)
  })
  it('Clear', () => {
    const { host, calls } = fakeHost()
    val('=Clear(Cart)', {}, host)
    expect(calls).toEqual([{ fn: 'clear', args: ['Cart'] }])
  })
  it('Remove passes the records with their __id', () => {
    const { host, calls } = fakeHost()
    val('=Remove(Contacts, LookUp(Contacts, Name = "Ben Cole"))', C(), host)
    expect(calls[0]!.fn).toBe('remove')
    expect(calls[0]!.args[0]).toBe('Contacts')
    expect((calls[0]!.args[1] as { __id: string }[]).map((r) => r.__id)).toEqual(['b'])
  })
  it('Remove(Contacts, ThisItem) inside a gallery row', () => {
    const { host, calls } = fakeHost()
    const item = contacts()[2]!
    val('=Remove(Contacts, ThisItem)', { ...C(), ThisItem: item }, host)
    expect((calls[0]!.args[1] as { __id: string }[])[0]!.__id).toBe('c')
  })
  it('RemoveIf reads rows from scope and removes matches', () => {
    const { host, calls } = fakeHost()
    val('=RemoveIf(Contacts, Age > 30)', C(), host)
    expect((calls[0]!.args[1] as { __id: string }[]).map((r) => r.__id)).toEqual(['a', 'c'])
  })
  it('RemoveIf with no match makes no host call', () => {
    const { host, calls } = fakeHost()
    val('=RemoveIf(Contacts, Age > 99)', C(), host)
    expect(calls).toEqual([])
  })
  it('RemoveIf on an unknown collection errors', () => {
    const { host } = fakeHost()
    expect(err('=RemoveIf(Nope, true)', {}, host).message).toBe("Name isn't recognised: Nope")
  })
  it('Patch creates with Defaults and returns the stored record', () => {
    const { host, calls } = fakeHost()
    const r = val('=Patch(Contacts, Defaults(Contacts), {Name: "Zed", Age: 1})', C(), host) as { __id: string; Name: string }
    expect(calls[0]).toEqual({ fn: 'patch', args: ['Contacts', {}, { Name: 'Zed', Age: 1 }] })
    expect(r.Name).toBe('Zed')
    expect(r.__id).toBe('new1')
  })
  it('Patch updates an existing row; result is usable', () => {
    const { host, calls } = fakeHost()
    const r = val('=Patch(Contacts, First(Contacts), {Age: 99}).Age', C(), host)
    expect(r).toBe(99)
    expect((calls[0]!.args[1] as { __id: string }).__id).toBe('a')
  })
  it('Patch merges several change records and strips __id from changes', () => {
    const { host, calls } = fakeHost()
    val('=Patch(Contacts, Defaults(Contacts), {a: 1}, {b: 2, __id: "evil"})', C(), host)
    expect(calls[0]!.args[2]).toEqual({ a: 1, b: 2 })
  })
  it('UpdateIf patches matching rows', () => {
    const { host, calls } = fakeHost()
    val('=UpdateIf(Contacts, City = "Pune", {Age: Age + 1})', C(), host)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args[2]).toEqual({ Age: 32 })
    expect(calls[1]!.args[2]).toEqual({ Age: 43 })
    expect((calls[0]!.args[1] as { __id: string }).__id).toBe('a')
  })
  it('Navigate takes a bare identifier as the screen name', () => {
    const { host, calls } = fakeHost()
    val('=Navigate(AddScreen)', {}, host)
    val('=Navigate("Home")', {}, host)
    expect(calls).toEqual([{ fn: 'navigate', args: ['AddScreen'] }, { fn: 'navigate', args: ['Home'] }])
  })
  it('Back / Reset / Refresh', () => {
    const { host, calls } = fakeHost()
    val('=Back(); Reset(NameInput); Refresh(Contacts)', {}, host)
    expect(calls).toEqual([{ fn: 'back', args: [] }, { fn: 'reset', args: ['NameInput'] }, { fn: 'refresh', args: ['Contacts'] }])
  })
  it('Notify maps notification kinds', () => {
    const { host, calls } = fakeHost()
    val('=Notify("a")', {}, host)
    val('=Notify("b", NotificationType.Success)', {}, host)
    val('=Notify("c", NotificationType.Warning)', {}, host)
    val('=Notify("d", NotificationType.Error)', {}, host)
    val('=Notify("e", NotificationType.Information)', {}, host)
    expect(calls.map((c) => c.args)).toEqual([['a', 'info'], ['b', 'success'], ['c', 'warning'], ['d', 'error'], ['e', 'info']])
    expect(err('=Notify("x", "loud")', {}, host).message).toMatch(/Notification type/)
  })
  it('the sample Save button', () => {
    const { host, calls } = fakeHost()
    const f = '=Patch(Contacts, Defaults(Contacts), {Name: NameInput.Value, City: CityInput.Value, Active: ActiveToggle.Value}); Reset(NameInput); Notify("Saved", NotificationType.Success); Back()'
    val(f, { ...C(), NameInput: { Value: 'Q' }, CityInput: { Value: 'Goa' }, ActiveToggle: { Value: true } }, host)
    expect(calls.map((c) => c.fn)).toEqual(['patch', 'reset', 'notify', 'back'])
    expect(calls[0]!.args[2]).toEqual({ Name: 'Q', City: 'Goa', Active: true })
  })
  it('behaviour inside ForAll and If', () => {
    const { host, calls } = fakeHost()
    val('=ForAll([1, 2], Collect(Seen, {n: Value}))', {}, host)
    expect(calls).toHaveLength(2)
    val('=If(1 > 2, Back(), Notify("no"))', {}, host)
    expect(calls[2]).toEqual({ fn: 'notify', args: ['no', 'info'] })
  })
  it('errors in arguments still report spans', () => {
    const { host, calls } = fakeHost()
    const e = err('=Set(x, 1 / 0)', {}, host)
    expect(e.message).toBe("Can't divide by zero")
    expect(calls).toEqual([])
  })
  it('a failing step stops the chain', () => {
    const { host, calls } = fakeHost()
    err('=Back(); Nope; Back()', {}, host)
    expect(calls).toHaveLength(1)
  })
})
