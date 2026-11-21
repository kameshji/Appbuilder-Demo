/**
 * Accounts > Journals, Ledger, Reports, Return summaries, Periods (P3 package L). Every figure comes from the server;
 * the browser only shows it. Posted journals cannot be edited: the only correction is "Reverse". Return summaries are
 * data for the accountant (shown here and downloadable as CSV); nothing is filed anywhere.
 */
import { useState } from 'react'
import { Download, Lock, LockOpen, Plus, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, Panel, Segmented, TextDialog, useToast } from '../kit'
import { PERIOD_STATE, accountsApi, downloadUrl, inr, today, type AccountsState, type Journal, type Period } from './api'
import { Loading, Money, SectionTitle, num, sel, td, th } from './bits'
import { useLoad } from './useLoad'

/** the default start of a date range: the first day of the month one year ago (only a starting point for the pickers) */
const fyStart = (): string => {
  const d = new Date()
  return `${d.getFullYear() - 1}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function Range({ from, to, onChange, single }: { from: string; to: string; onChange(from: string, to: string): void; single?: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {!single && <Field label="From"><Input className="h-8 w-40 max-md:h-11" type="date" value={from} onChange={(e) => onChange(e.target.value, to)} aria-label="From" data-testid="range-from" /></Field>}
      <Field label={single ? 'As on' : 'To'}><Input className="h-8 w-40 max-md:h-11" type="date" value={to} onChange={(e) => onChange(from, e.target.value)} aria-label={single ? 'As on' : 'To'} data-testid="range-to" /></Field>
    </div>
  )
}
const Csv = ({ href }: { href: string }) => <Button size="sm" variant="outline" asChild><a href={href} data-testid="download-csv"><Download /> CSV</a></Button>

/* ------------------------------------------------------------------ journals */

function JournalView({ id, canPost, onChanged }: { id: string; canPost: boolean; onChanged(): void }) {
  const j = useLoad(() => accountsApi.journal(id), [id])
  const [reverse, setReverse] = useState(false)
  if (!j.data) return <Loading error={j.error} />
  const x: Journal = j.data.journal
  return (
    <Panel className="mt-3 p-4" data-testid="journal-view">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Journal {x.number}</span><span className="text-muted-foreground">{x.date}</span><span className="min-w-0 flex-1 truncate">{x.narration}</span>
        {x.reversedBy && <Badge variant="secondary">Reversed</Badge>}{x.reverses && <Badge variant="secondary">Reversal</Badge>}{x.sourceKind !== 'manual' && <Badge variant="outline">From a document</Badge>}
        {canPost && x.sourceKind === 'manual' && !x.reversedBy && !x.reverses && <Button size="sm" variant="outline" onClick={() => setReverse(true)} data-testid="journal-reverse"><Undo2 /> Reverse</Button>}
      </div>
      <table className="w-full text-sm">
        <thead><tr><th className={th}>Account</th><th className={th}>Memo</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th></tr></thead>
        <tbody>{x.lines.map((l) => <tr key={l.lineNo} className="border-t border-border/60"><td className={td}>{l.accountCode} {l.accountName}</td><td className={td}>{l.memo}</td><td className={num}><Money value={l.debit} blankZero /></td><td className={num}><Money value={l.credit} blankZero /></td></tr>)}</tbody>
      </table>
      <TextDialog open={reverse} onOpenChange={setReverse} title={`Reverse journal ${x.number}`} description="A posted journal is never changed. The reversal is a new journal, dated today, with every debit and credit swapped." label="Reason" confirmLabel="Reverse"
        onSubmit={async (reason) => { await accountsApi.reverseJournal(id, today(), reason); j.reload(); onChanged() }} />
    </Panel>
  )
}

function NewJournal({ onDone }: { onDone(): void }) {
  const chart = useLoad(accountsApi.chart)
  const { fail, toast } = useToast()
  const [date, setDate] = useState(today())
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }])
  if (!chart.data) return <Loading error={chart.error} />
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)))
  const post = () => accountsApi.postJournal({ date, narration, lines: lines.filter((l) => l.accountId && (l.debit || l.credit)) }).then(() => { toast('Journal posted', 'success'); onDone() }).catch(fail)
  return (
    <Panel className="mb-4 grid gap-3 p-4" data-testid="journal-new">
      <div className="grid gap-3 md:grid-cols-[10rem_1fr]">
        <Field label="Date"><Input className="h-8 max-md:h-11" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" data-testid="journal-date" /></Field>
        <Field label="Narration"><Input className="h-8 max-md:h-11" value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="Narration" data-testid="journal-narration" /></Field>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_8rem_8rem] gap-2">
          <select className={sel} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Account of line ${i + 1}`} data-testid={`journal-account-${i}`}><option value="">(account)</option>{chart.data!.items.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
          <Input className="h-8 text-right max-md:h-11" inputMode="decimal" placeholder="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: '' })} aria-label={`Debit of line ${i + 1}`} data-testid={`journal-debit-${i}`} />
          <Input className="h-8 text-right max-md:h-11" inputMode="decimal" placeholder="Credit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: '' })} aria-label={`Credit of line ${i + 1}`} data-testid={`journal-credit-${i}`} />
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setLines([...lines, { accountId: '', debit: '', credit: '' }])}><Plus /> Line</Button>
        <Button size="sm" onClick={() => void post()} data-testid="journal-post">Post journal</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
      <p className="text-xs text-muted-foreground">Debits must equal credits. A posted journal cannot be edited or deleted; it is corrected by a reversal.</p>
    </Panel>
  )
}

export function Journals({ state }: { state: AccountsState }) {
  const canPost = state.level !== 'view'
  const r = useLoad(() => accountsApi.journals())
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  return (
    <div data-testid="accounts-journals">
      <SectionTitle actions={canPost && !adding && <Button size="sm" onClick={() => setAdding(true)} data-testid="journal-add"><Plus /> New journal</Button>}>Journals</SectionTitle>
      {adding && <NewJournal onDone={() => { setAdding(false); r.reload() }} />}
      {!r.data ? <Loading error={r.error} /> : r.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No journals yet. Issuing a document posts its journal.</p> : (
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className={th}>No.</th><th className={th}>Date</th><th className={th}>Narration</th><th className={`${th} text-right`}>Amount</th></tr></thead>
            <tbody>{r.data.items.map((j) => (
              <tr key={j.id} className="cursor-pointer border-t border-border/60 hover:bg-muted/40" onClick={() => setOpen(open === j.id ? null : j.id)} data-testid="journal-row">
                <td className={td}>{j.number}</td><td className={td}>{j.date}</td><td className={td}>{j.narration}{j.reversedBy ? ' (reversed)' : ''}</td><td className={num}><Money value={j.total} /></td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
      {open && <JournalView id={open} canPost={canPost} onChanged={r.reload} />}
    </div>
  )
}

/* ------------------------------------------------------------------ ledger */

export function Ledger() {
  const chart = useLoad(accountsApi.chart)
  const [account, setAccount] = useState('')
  const [range, setRange] = useState({ from: fyStart(), to: today() })
  const l = useLoad(() => (account ? accountsApi.ledger(account, range.from, range.to) : Promise.resolve(null)), [account, range.from, range.to])
  if (!chart.data) return <Loading error={chart.error} />
  return (
    <div data-testid="accounts-ledger">
      <SectionTitle actions={account && <Csv href={downloadUrl('/accounts/ledger', { account, from: range.from, to: range.to, format: 'csv' })} />}>Account ledger</SectionTitle>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Account"><select className={`${sel} w-72`} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account" data-testid="ledger-account"><option value="">(choose an account)</option>{chart.data.items.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
        <Range from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      </div>
      {l.error && <Loading error={l.error} />}
      {l.data && (
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Date</th><th className={th}>Journal</th><th className={th}>Narration</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Balance</th></tr></thead>
            <tbody>
              <tr className="border-t border-border/60"><td className={td} colSpan={5}>Opening balance</td><td className={num}><Money value={l.data.opening} /></td></tr>
              {l.data.entries.map((e, i) => <tr key={i} className="border-t border-border/60"><td className={td}>{e.date}</td><td className={td}>{e.number}</td><td className={td}>{e.narration}</td><td className={num}><Money value={e.debit} blankZero /></td><td className={num}><Money value={e.credit} blankZero /></td><td className={num}><Money value={e.balance} /></td></tr>)}
              <tr className="border-t border-border font-semibold"><td className={td} colSpan={5}>Closing balance (debit positive)</td><td className={num} data-testid="ledger-closing"><Money value={l.data.closing} /></td></tr>
            </tbody>
          </table>
          {l.data.truncated && <p className="p-2 text-xs text-muted-foreground">Only the first 5,000 entries are shown; narrow the dates or use the CSV.</p>}
        </Panel>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ reports */

function Statement({ title, rows, total, totalLabel }: { title: string; rows: { accountId: string; code: string; name: string; amount: number }[]; total: number; totalLabel: string }) {
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr><th className={th} colSpan={2}>{title}</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.accountId} className="border-t border-border/60"><td className={td}>{r.code} {r.name}</td><td className={num}><Money value={r.amount} /></td></tr>)}
          <tr className="border-t border-border font-semibold"><td className={td}>{totalLabel}</td><td className={num}><Money value={total} /></td></tr>
        </tbody>
      </table>
    </Panel>
  )
}

export function Reports() {
  const [which, setWhich] = useState<'tb' | 'pl' | 'bs'>('tb')
  const [range, setRange] = useState({ from: fyStart(), to: today() })
  const tb = useLoad(() => (which === 'tb' ? accountsApi.trialBalance(range.from, range.to) : Promise.resolve(null)), [which, range.from, range.to])
  const pl = useLoad(() => (which === 'pl' ? accountsApi.profitLoss(range.from, range.to) : Promise.resolve(null)), [which, range.from, range.to])
  const bs = useLoad(() => (which === 'bs' ? accountsApi.balanceSheet(range.to) : Promise.resolve(null)), [which, range.to])
  const path = which === 'tb' ? '/accounts/reports/trial-balance' : which === 'pl' ? '/accounts/reports/profit-loss' : '/accounts/reports/balance-sheet'
  return (
    <div data-testid="accounts-reports">
      <SectionTitle actions={<Csv href={downloadUrl(path, which === 'bs' ? { asOf: range.to, format: 'csv' } : { from: range.from, to: range.to, format: 'csv' })} />}>Reports</SectionTitle>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Segmented label="Report" value={which} onChange={setWhich} options={[{ value: 'tb', label: 'Trial balance' }, { value: 'pl', label: 'Profit and loss' }, { value: 'bs', label: 'Balance sheet' }]} />
        <Range from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} single={which === 'bs'} />
      </div>
      {(tb.error || pl.error || bs.error) && <Loading error={tb.error || pl.error || bs.error} />}
      {which === 'tb' && tb.data && (
        <Panel className="overflow-x-auto" data-testid="trial-balance">
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Account</th><th className={`${th} text-right`}>Opening</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Closing debit</th><th className={`${th} text-right`}>Closing credit</th></tr></thead>
            <tbody>
              {tb.data.rows.map((r) => <tr key={r.accountId} className="border-t border-border/60" data-testid="tb-row"><td className={td}>{r.code} {r.name}</td><td className={num}><Money value={r.opening} blankZero /></td><td className={num}><Money value={r.debit} blankZero /></td><td className={num}><Money value={r.credit} blankZero /></td><td className={num}>{r.closing > 0 ? inr(r.closing) : ''}</td><td className={num}>{r.closing < 0 ? inr(-r.closing) : ''}</td></tr>)}
              <tr className="border-t border-border font-semibold"><td className={td}>Total</td><td className={num} /><td className={num} data-testid="tb-total-debit">{inr(tb.data.totals.debit)}</td><td className={num} data-testid="tb-total-credit">{inr(tb.data.totals.credit)}</td><td className={num} data-testid="tb-closing-debit">{inr(tb.data.totals.closingDebit)}</td><td className={num} data-testid="tb-closing-credit">{inr(tb.data.totals.closingCredit)}</td></tr>
            </tbody>
          </table>
          <p className="p-2 text-xs text-muted-foreground" data-testid="tb-balanced">{tb.data.balanced ? 'Debits equal credits.' : 'Debits and credits differ: tell your administrator.'}</p>
        </Panel>
      )}
      {which === 'pl' && pl.data && (
        <div className="grid gap-4 md:grid-cols-2" data-testid="profit-loss">
          <Statement title="Income" rows={pl.data.income} total={pl.data.totalIncome} totalLabel="Total income" />
          <Statement title="Expense" rows={pl.data.expense} total={pl.data.totalExpense} totalLabel="Total expense" />
          <p className="text-sm font-semibold md:col-span-2">Profit (income less expense): {inr(pl.data.profit)}</p>
        </div>
      )}
      {which === 'bs' && bs.data && (
        <div className="grid gap-4 md:grid-cols-2" data-testid="balance-sheet">
          <Statement title="Assets" rows={bs.data.assets} total={bs.data.totalAssets} totalLabel="Total assets" />
          <div className="grid content-start gap-4">
            <Statement title="Liabilities" rows={bs.data.liabilities} total={bs.data.totalLiabilities} totalLabel="Total liabilities" />
            <Statement title="Equity" rows={[...bs.data.equity, { accountId: 'profit', code: '', name: 'Profit to date, not closed', amount: bs.data.profitToDate }]} total={bs.data.totalEquity} totalLabel="Total equity" />
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">There are no year-end closing entries in this version: income less expense of all time up to the date is shown as one line under equity.</p>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ return summaries */

export function Returns() {
  const list = useLoad(accountsApi.returns)
  const [name, setName] = useState('outward-register')
  const [range, setRange] = useState({ from: `${today().slice(0, 8)}01`, to: today() })
  const r = useLoad(() => accountsApi.returnSummary(name, range.from, range.to), [name, range.from, range.to])
  if (!list.data) return <Loading error={list.error} />
  return (
    <div data-testid="accounts-returns">
      <SectionTitle actions={<Csv href={downloadUrl(`/accounts/returns/${name}`, { from: range.from, to: range.to, format: 'csv' })} />}>Return summaries</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground" data-testid="returns-notice">{list.data.notice}</p>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Summary"><select className={`${sel} w-72`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Summary" data-testid="returns-name">{list.data.items.map((i) => <option key={i.name} value={i.name}>{i.title}</option>)}</select></Field>
        <Range from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      </div>
      {!r.data ? <Loading error={r.error} /> : (
        <>
          {r.data.notes.map((n) => <p key={n} className="mb-2 text-xs text-muted-foreground">{n}</p>)}
          <Panel className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="returns-table">
              <thead><tr>{r.data.columns.map((c) => <th key={c} className={`${th} whitespace-nowrap`}>{c}</th>)}</tr></thead>
              <tbody>{r.data.rows.map((row, i) => <tr key={i} className="border-t border-border/60">{row.map((c, k) => <td key={k} className={`${td} whitespace-nowrap`}>{c}</td>)}</tr>)}</tbody>
            </table>
            {r.data.rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nothing in these dates.</p>}
          </Panel>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ periods */

export function Periods({ state }: { state: AccountsState }) {
  const admin = state.level === 'admin'
  const r = useLoad(accountsApi.years)
  const { fail, toast } = useToast()
  const [date, setDate] = useState(today())
  const [unlock, setUnlock] = useState<Period | null>(null)
  if (!r.data) return <Loading error={r.error} />
  const month = (p: Period) => new Date(`${p.start}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const lock = (p: Period, s: 'soft_locked' | 'locked') => accountsApi.lockPeriod(p.id, s).then(() => { toast(`${month(p)} is ${PERIOD_STATE[s].toLowerCase()}`, 'success'); r.reload() }).catch(fail)
  return (
    <div data-testid="accounts-periods">
      <SectionTitle>Financial years and periods</SectionTitle>
      <p className="mb-3 text-sm text-muted-foreground">Periods are calendar months. Soft-locked: only an Accounts administrator can post. Locked: nobody can post, issue or cancel in it; corrections are credit or debit notes in an open period. Only an install administrator can unlock a locked period, with a reason. Appbuilder does not know your filing dates: lock a month when your accountant has finished it.</p>
      {admin && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Add the financial year that contains"><Input className="h-8 w-44 max-md:h-11" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="A date in the financial year" data-testid="year-date" /></Field>
          <Button size="sm" onClick={() => accountsApi.addYear(date).then(() => { toast('Financial year added', 'success'); r.reload() }).catch(fail)} data-testid="year-add"><Plus /> Add financial year</Button>
        </div>
      )}
      {r.data.items.length === 0 && <p className="text-sm text-muted-foreground">No financial year yet. Nothing can be posted until one exists.</p>}
      {r.data.items.map((y) => (
        <Panel key={y.id} className="mb-4 overflow-x-auto" data-testid="year">
          <div className="px-3 py-2 text-sm font-semibold">Financial year {y.name}</div>
          <table className="w-full text-sm">
            <tbody>{y.periods.map((p) => (
              <tr key={p.id} className="border-t border-border/60" data-testid={`period-${p.start.slice(0, 7)}`}>
                <td className={td}>{month(p)}</td>
                <td className={td}><Badge variant={p.state === 'open' ? 'outline' : 'secondary'} data-testid="period-state">{PERIOD_STATE[p.state]}</Badge>{p.reason ? <span className="ml-2 text-xs text-muted-foreground">{p.reason}</span> : null}</td>
                <td className={`${td} whitespace-nowrap text-right`}>
                  {admin && p.state === 'open' && <Button size="sm" variant="ghost" onClick={() => void lock(p, 'soft_locked')} data-testid="period-soft-lock"><Lock /> Soft-lock</Button>}
                  {admin && p.state !== 'locked' && <Button size="sm" variant="ghost" onClick={() => void lock(p, 'locked')} data-testid="period-lock"><Lock /> Lock</Button>}
                  {admin && p.state !== 'open' && (p.state === 'soft_locked' || state.isInstallAdmin) && <Button size="sm" variant="ghost" onClick={() => setUnlock(p)} data-testid="period-unlock"><LockOpen /> Unlock</Button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      ))}
      <TextDialog open={!!unlock} onOpenChange={(o) => { if (!o) setUnlock(null) }} title={unlock ? `Unlock ${month(unlock)}` : 'Unlock'} description="Unlocking is recorded in the audit log with your reason." label="Reason" confirmLabel="Unlock"
        onSubmit={async (reason) => { await accountsApi.unlockPeriod(unlock!.id, reason); r.reload() }} />
    </div>
  )
}
