/**
 * The step picker's groups, plain-language descriptions and icons (the catalogue from GET /flows/catalog is the source
 * of the kinds; this adds how a maker finds them). Recently used kinds are kept per user in localStorage.
 */
import {
  Bell, Box, Braces, Calculator, CircleStop, Clock, Database, FilePlus2, FileText, FileSearch, FileX2, GitBranch, Globe, Hourglass, ListTree,
  Mail, PencilLine, Plug, Repeat, Repeat1, Reply, Rows3, ShieldCheck, Split, Variable, Webhook, Workflow, Zap, type LucideIcon,
} from 'lucide-react'

export type PickerGroup = 'Control' | 'Data' | 'Approvals' | 'Notifications' | 'Connectors' | 'Advanced'
export const GROUPS: PickerGroup[] = ['Control', 'Data', 'Approvals', 'Notifications', 'Connectors', 'Advanced']

export interface KindInfo { /** the default step name */ short: string; group: PickerGroup; title: string; blurb: string; icon: LucideIcon; tone: string }

export const KINDS: Record<string, KindInfo> = {
  condition: { short: 'Condition', group: 'Control', title: 'Condition', blurb: 'Do one thing or another depending on a yes/no test.', icon: Split, tone: 'text-violet-600 bg-violet-500/10' },
  switch: { short: 'Switch', group: 'Control', title: 'Switch', blurb: 'Pick a path by a value: one path per case, and a default.', icon: GitBranch, tone: 'text-violet-600 bg-violet-500/10' },
  forEach: { short: 'ForEach', group: 'Control', title: 'For each', blurb: 'Repeat steps for every item of a list, e.g. every row a step listed.', icon: Repeat, tone: 'text-violet-600 bg-violet-500/10' },
  until: { short: 'DoUntil', group: 'Control', title: 'Do until', blurb: 'Repeat steps until something is true (with a limit).', icon: Repeat1, tone: 'text-violet-600 bg-violet-500/10' },
  scope: { short: 'Scope', group: 'Control', title: 'Scope', blurb: 'Group steps; with "run after failed" on the next step it works like try/catch.', icon: Box, tone: 'text-violet-600 bg-violet-500/10' },
  delay: { short: 'Delay', group: 'Control', title: 'Delay', blurb: 'Wait some time, or until a date and time. Waiting costs nothing.', icon: Hourglass, tone: 'text-violet-600 bg-violet-500/10' },
  terminate: { short: 'Terminate', group: 'Control', title: 'Terminate', blurb: 'Stop the run now, as succeeded, failed or cancelled.', icon: CircleStop, tone: 'text-violet-600 bg-violet-500/10' },
  'data.get': { short: 'GetRow', group: 'Data', title: 'Get a row', blurb: 'Read one row of a table, by its id or by a condition.', icon: FileSearch, tone: 'text-sky-600 bg-sky-500/10' },
  'data.list': { short: 'ListRows', group: 'Data', title: 'List rows', blurb: 'Read the rows of a table that match a filter, sorted.', icon: Rows3, tone: 'text-sky-600 bg-sky-500/10' },
  'data.create': { short: 'AddRow', group: 'Data', title: 'Add a row', blurb: 'Add a row to a table.', icon: FilePlus2, tone: 'text-sky-600 bg-sky-500/10' },
  'data.update': { short: 'UpdateRow', group: 'Data', title: 'Update a row', blurb: 'Change columns of a row.', icon: PencilLine, tone: 'text-sky-600 bg-sky-500/10' },
  'data.delete': { short: 'DeleteRow', group: 'Data', title: 'Delete a row', blurb: 'Delete a row of a table.', icon: FileX2, tone: 'text-sky-600 bg-sky-500/10' },
  compose: { short: 'Compose', group: 'Data', title: 'Compose', blurb: 'Calculate a value once and use it in later steps.', icon: Calculator, tone: 'text-sky-600 bg-sky-500/10' },
  'document.generate': { short: 'GenerateDocument', group: 'Data', title: 'Generate a document', blurb: 'Make a PDF from a print template: keep it for an email, put it in a file column, or store it in the record\'s Documents.', icon: FileText, tone: 'text-sky-600 bg-sky-500/10' },
  setVariable: { short: 'SetVariable', group: 'Data', title: 'Set variable', blurb: 'Change a variable of the flow (declare it in the flow settings).', icon: Variable, tone: 'text-sky-600 bg-sky-500/10' },
  approval: { short: 'Approval', group: 'Approvals', title: 'Start and wait for an approval', blurb: 'Ask people to approve or reject; the run waits for the answer.', icon: ShieldCheck, tone: 'text-emerald-600 bg-emerald-500/10' },
  notify: { short: 'Notify', group: 'Notifications', title: 'Notify', blurb: 'Send a notification to people (the bell, and email if you want).', icon: Bell, tone: 'text-amber-600 bg-amber-500/10' },
  email: { short: 'SendEmail', group: 'Notifications', title: 'Send an email', blurb: 'Send an email through the environment\'s mail connection.', icon: Mail, tone: 'text-amber-600 bg-amber-500/10' },
  http: { short: 'CallApi', group: 'Connectors', title: 'HTTP request', blurb: 'Call a web API through an HTTP connection.', icon: Globe, tone: 'text-rose-600 bg-rose-500/10' },
  action: { short: 'Action', group: 'Connectors', title: 'Connector action', blurb: 'Run an action of a connection (its inputs come from the action).', icon: Plug, tone: 'text-rose-600 bg-rose-500/10' },
  callFlow: { short: 'RunChildFlow', group: 'Advanced', title: 'Run a child flow', blurb: 'Run another flow (started by hand) and use its answer.', icon: Workflow, tone: 'text-slate-600 bg-slate-500/10' },
  respond: { short: 'Respond', group: 'Advanced', title: 'Respond', blurb: 'Answer the app, web request or parent flow that started this run.', icon: Reply, tone: 'text-slate-600 bg-slate-500/10' },
  waitForCallback: { short: 'WaitForCallback', group: 'Advanced', title: 'Wait for a callback', blurb: 'Wait until another system posts to a one-time address.', icon: Webhook, tone: 'text-slate-600 bg-slate-500/10' },
}

export const TRIGGER_ICON: Record<string, LucideIcon> = { table: Database, schedule: Clock, manual: Zap, webhook: Webhook, approvalDecided: ShieldCheck, formSubmitted: ListTree }
export const FALLBACK_ICON = Braces

export const kindInfo = (k: string): KindInfo => KINDS[k] ?? { short: 'Step', group: 'Advanced', title: k, blurb: '', icon: FALLBACK_ICON, tone: 'text-slate-600 bg-slate-500/10' }
export const kindTitle = (k: string): string => kindInfo(k).title

const RECENT = 'appbuilder-flow-recent'
export function recentKinds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}
export function noteRecent(key: string): void {
  try {
    localStorage.setItem(RECENT, JSON.stringify([key, ...recentKinds().filter((x) => x !== key)].slice(0, 6)))
  } catch { /* private mode */ }
}
