import { describe, expect, it, vi } from 'vitest'
import type { AppDef, ControlNode, FxRecord } from '@/contracts'

const calls: string[] = []
const fake = vi.hoisted(() => {
  const state = {
    mode: 'server' as 'server' | 'demo',
    flushError: null as Error | null,
    uploadError: null as Error | null,
    rows: [] as Array<Record<string, unknown>>,
  }
  return state
})

vi.mock('@/platform', async (orig) => {
  const real = await orig<typeof import('@/platform')>()
  const platform = {
    getState: () => ({ ready: true, mode: fake.mode, tables: [], roles: [], dataVersion: 1, loading: [], truncated: [], currentUserId: 'u' }),
    subscribe: () => () => {},
    tables: {
      get: (n: string) => (n === 'Contacts' ? { id: 't1', name: 'Contacts', displayName: 'Contacts', primaryColumn: 'Name', columns: [{ name: 'Name', displayName: 'Name', type: 'text' }, { name: 'Photo', displayName: 'Photo', type: 'image' }] } : undefined),
      rows: () => fake.rows,
      insert: (_t: string, v: FxRecord) => {
        calls.push('insert')
        const row = { ...v, __id: 'row-1', id: 'row-1' }
        fake.rows.push(row)
        return row
      },
      update: (_t: string, id: string, v: FxRecord) => {
        calls.push('update')
        return { ...v, __id: id }
      },
      flush: async () => {
        calls.push('flush')
        if (fake.flushError) throw fake.flushError
      },
      reload: async () => {
        calls.push('reload')
      },
    },
    attachments: {
      upload: async (_t: string, c: string, id: string, f: File) => {
        calls.push(`upload:${c}:${id}:${f.name}`)
        if (fake.uploadError) throw fake.uploadError
        return { id: 'att_1' }
      },
      url: (id: string) => id,
      resolve: async () => [],
    },
    security: { currentUser: () => ({ id: 'u', name: 'U', email: '', roleIds: [] }) },
  }
  return { ...real, platform }
})

import { ROOT_CTX, type RuntimeView } from './evaluator'
import { runFormula } from './host'
import { blankApp } from './sample'
import { finishSubmit, SubmitError } from './submit'
import { registerFiles } from './attachments'

const rt = (outputs: RuntimeView['outputs']): RuntimeView & { navStack: string[] } => ({
  vars: {}, context: {}, collections: {}, outputs, resetKeys: {}, focusKeys: {}, formModes: {}, dataKey: '0', userId: '', navStack: ['s1'],
})

function setup(mode: 'New' | 'Edit' = 'New') {
  const a: AppDef = blankApp('T', 1920, 1080)
  const form: ControlNode = { id: 'f1', name: 'Form1', type: 'Form', props: { DataSource: '="Contacts"', Mode: `=FormMode.${mode}` }, children: [] }
  a.screens[0].children = [form]
  a.screens[0].id = 's1'
  return { a, form }
}

const submit = (outputs: RuntimeView['outputs']) => {
  const { a, form } = setup()
  return runFormula({
    app: a, rt: rt(outputs), env: { w: 1920, h: 1080 }, node: form, ctx: ROOT_CTX, label: 'Form1.Submit',
    action: (h) => h.form('submit', 'Form1'), fromSubmitButton: true,
  })
}

describe('finishSubmit sequencing', () => {
  const file = (n: string) => new File(['x'], n)
  it('flushes first, then uploads every file in order, then reloads', async () => {
    const log: string[] = []
    const deps = {
      flush: async () => { log.push('flush') },
      upload: async (t: string, c: string, id: string, f: File) => { log.push(`upload:${t}.${c}:${id}:${f.name}`) },
      reload: async (t: string) => { log.push(`reload:${t}`) },
    }
    const n = await finishSubmit(deps, { table: 'Contacts', rowId: 'r1', files: [{ column: 'Photo', files: [file('a.png'), file('b.png')] }, { column: 'Doc', files: [file('c.pdf')] }] })
    expect(n).toBe(3)
    expect(log).toEqual(['flush', 'upload:Contacts.Photo:r1:a.png', 'upload:Contacts.Photo:r1:b.png', 'upload:Contacts.Doc:r1:c.pdf', 'reload:Contacts'])
  })
  it('does not upload when the server refuses the row', async () => {
    const upload = vi.fn()
    const err = await finishSubmit({ flush: async () => { throw new Error('denied by server') }, upload }, { table: 'T', rowId: 'r', files: [{ column: 'P', files: [file('a')] }] }).catch((e) => e)
    expect(err).toBeInstanceOf(SubmitError)
    expect(err.stage).toBe('write')
    expect(err.message).toBe('denied by server')
    expect(upload).not.toHaveBeenCalled()
  })
  it('reports an upload failure with the file name and still refreshes what was uploaded', async () => {
    const log: string[] = []
    let k = 0
    const deps = {
      flush: async () => {},
      upload: async () => { if (++k === 2) throw new Error('too large') },
      reload: async () => { log.push('reload') },
    }
    const err = await finishSubmit(deps, { table: 'T', rowId: 'r', files: [{ column: 'P', files: [file('a'), file('b')] }] }).catch((e) => e)
    expect(err.stage).toBe('upload')
    expect(err.message).toBe('b: too large')
    expect(log).toEqual(['reload'])
  })
  it('skips the reload when nothing was uploaded', async () => {
    const reload = vi.fn()
    expect(await finishSubmit({ flush: async () => {}, upload: vi.fn(), reload }, { table: 'T', rowId: 'r', files: [] })).toBe(0)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('Form submit through the host', () => {
  it('server mode: inserts locally, defers the verdict, uploads the pending files after flush, then resolves with the row', async () => {
    calls.length = 0
    fake.mode = 'server'
    fake.flushError = null
    fake.uploadError = null
    fake.rows = []
    const token = registerFiles([new File(['x'], 'me.png')])
    const r = submit({ f1: { Updates: { Name: 'Ada' }, Valid: true, __files: { Photo: token } } })
    expect(calls).toEqual(['insert'])
    expect(r.deferred).toHaveLength(1)
    expect(r.outputs.f1.__busy).toBe(1)
    expect(r.outputs.f1.LastSubmit).toBeUndefined()
    expect(r.followUps).toHaveLength(0)
    const stored = await r.deferred[0].work()
    expect(calls).toEqual(['insert', 'flush', 'upload:Photo:row-1:me.png', 'reload'])
    expect(stored.__id).toBe('row-1')
  })
  it('server mode: a refused write rejects before any upload', async () => {
    calls.length = 0
    fake.flushError = new Error('You may not add rows')
    fake.rows = []
    const token = registerFiles([new File(['x'], 'me.png')])
    const r = submit({ f1: { Updates: { Name: 'Ada' }, Valid: true, __files: { Photo: token } } })
    const err = await r.deferred[0].work().catch((e) => e)
    expect(err.stage).toBe('write')
    expect(calls).toEqual(['insert', 'flush'])
    fake.flushError = null
  })
  it('demo mode without files stays synchronous (LastSubmit + OnSuccess immediately)', () => {
    calls.length = 0
    fake.mode = 'demo'
    fake.rows = []
    const r = submit({ f1: { Updates: { Name: 'Ada' }, Valid: true } })
    expect(r.deferred).toHaveLength(0)
    expect((r.outputs.f1.LastSubmit as FxRecord).__id).toBe('row-1')
    expect(r.followUps.map((f) => f.event)).toEqual(['OnSuccess'])
    expect(calls).toEqual(['insert'])
  })
  it('demo mode with files defers too (uploads need the stored row)', () => {
    calls.length = 0
    fake.mode = 'demo'
    fake.rows = []
    const token = registerFiles([new File(['x'], 'me.png')])
    const r = submit({ f1: { Updates: { Name: 'Ada' }, Valid: true, __files: { Photo: token } } })
    expect(r.deferred).toHaveLength(1)
  })
  it('ignores a second submit while the first is busy', () => {
    calls.length = 0
    fake.mode = 'server'
    const r = submit({ f1: { Updates: { Name: 'Ada' }, Valid: true, __busy: 1 } })
    expect(calls).toEqual([])
    expect(r.deferred).toHaveLength(0)
  })
})
