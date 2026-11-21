/**
 * The Accounts area (P3 package L: ledgers and India GST; docs/guide/accounts.md). One page with sections: Documents,
 * Journals, Ledger, Reports, Return summaries, Customers and suppliers, Items, Periods, Chart and series, Reference
 * data, Settings. What a person sees follows their Accounts level (read, post, Accounts administrator), which the
 * server decides and enforces; the page only hides what would be refused.
 *
 * The GST calculation rules are a draft that no practising accountant has reviewed: Settings and Reference data say so
 * at the top. Appbuilder files no return and talks to no government system.
 */
import { useState } from 'react'
import { BookOpenCheck, ShieldAlert } from 'lucide-react'
import { usePlatform } from '@/platform'
import { cn } from '@/lib/utils'
import { Empty, PageHeader } from '../kit'
import { accountsApi, type Level } from './api'
import { Loading } from './bits'
import { useLoad } from './useLoad'
import { Documents } from './Documents'
import { Journals, Ledger, Periods, Reports, Returns } from './Books'
import { ChartAndSeries, Items, Parties, ReferenceData, Settings } from './Setup'

type SectionId = 'documents' | 'journals' | 'ledger' | 'reports' | 'returns' | 'parties' | 'items' | 'periods' | 'chart' | 'reference' | 'settings'
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'documents', label: 'Documents' }, { id: 'journals', label: 'Journals' }, { id: 'ledger', label: 'Ledger' }, { id: 'reports', label: 'Reports' }, { id: 'returns', label: 'Return summaries' },
  { id: 'parties', label: 'Customers and suppliers' }, { id: 'items', label: 'Items' }, { id: 'periods', label: 'Periods' }, { id: 'chart', label: 'Chart and series' }, { id: 'reference', label: 'Reference data' }, { id: 'settings', label: 'Settings' },
]
const LEVEL_WORD: Record<Level, string> = { none: 'No access', view: 'Read', post: 'Post', admin: 'Accounts administrator' }

export function AccountsPage() {
  const server = usePlatform((s) => s.mode) === 'server'
  const st = useLoad(() => (server ? accountsApi.state() : Promise.resolve(null)), [server])
  const [section, setSection] = useState<SectionId | null>(null)
  if (!server) return <div className="p-6"><Empty icon={BookOpenCheck} title="Accounts needs the local server" description="Ledgers and GST documents are kept in the server's database. Demo mode has no Accounts area." /></div>
  if (!st.data) return <div className="p-6"><Loading error={st.error} /></div>
  const state = st.data
  if (state.level === 'none') {
    return <div className="p-6" data-testid="accounts-page"><Empty icon={ShieldAlert} title="Accounts is not available for your role" description="Ask an administrator to give your role a level in Accounts > Settings." /></div>
  }
  // until the business registration exists, the page opens on Settings
  const current: SectionId = section ?? (state.setup?.business && state.setup.chart ? 'documents' : 'settings')
  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6" data-testid="accounts-page" data-level={state.level}>
      <PageHeader icon={BookOpenCheck} title="Accounts" subtitle={`Ledgers, GST documents and summaries for your accountant. Your level: ${LEVEL_WORD[state.level]}.`} />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Accounts sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={current === s.id} onClick={() => setSection(s.id)} data-testid={`accounts-tab-${s.id}`}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-md:min-h-11', current === s.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {s.label}
          </button>
        ))}
      </div>
      {current === 'documents' && <Documents state={state} />}
      {current === 'journals' && <Journals state={state} />}
      {current === 'ledger' && <Ledger />}
      {current === 'reports' && <Reports />}
      {current === 'returns' && <Returns />}
      {current === 'parties' && <Parties state={state} />}
      {current === 'items' && <Items state={state} />}
      {current === 'periods' && <Periods state={state} />}
      {current === 'chart' && <ChartAndSeries state={state} />}
      {current === 'reference' && <ReferenceData state={state} />}
      {current === 'settings' && <Settings key={JSON.stringify(state.business ?? null)} state={state} reload={st.reload} />}
    </div>
  )
}
